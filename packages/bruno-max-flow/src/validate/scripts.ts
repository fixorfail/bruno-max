/**
 * What every §8.2 script position holds, and the one check that reads all of them together.
 *
 * A script is text until it runs. Nothing here parses JavaScript — `functions.ts` says why, and the
 * whole of this file is written under that constraint — so what it can say about a script is what a
 * careful reader could say about it without running it.
 */
import { SCRIPT_ARGUMENTS } from '../functions';
import { type NormalizedFlow } from '../document';
import { suggest, type Report } from './report';

export type ScriptPosition = { source: string; stepId?: string; node: (string | number)[] };

/**
 * Every position §8.2 evaluates as a script, with the document path each is written at.
 *
 * `when:` in its string form is not one — that is §9.3's condition, read by the expression dialect —
 * and neither is an assertion or an output *path*. A check that walked those too would report the
 * two languages' rules against each other.
 *
 * The flow's own `config.retry.shouldRetry` needs no entry: normalization folds it into every step,
 * so it arrives here as each step's own.
 *
 * **`pre:` and `outputs:` are addressed by name, not by position.** Both normalize to a list, and
 * both are written as a mapping — so an index addresses nothing in the document, and a diagnostic
 * carrying one arrives with no line at all. `when:` is a list in the file as well, and keeps its.
 */
export const scriptPositions = (flow: NormalizedFlow): ScriptPosition[] => {
  const scripts: ScriptPosition[] = [];

  for (const [name, source] of Object.entries(flow.functions.define)) {
    scripts.push({ source, node: ['functions', 'define', name] });
  }

  flow.steps.forEach((step, index) => {
    step.pre.forEach((entry) => {
      scripts.push({ source: entry.script, stepId: step.id, node: ['steps', index, 'pre', entry.name] });
    });
    step.when.forEach((entry, at) => {
      if (typeof entry !== 'string') {
        scripts.push({ source: entry.script, stepId: step.id, node: ['steps', index, 'when', at] });
      }
    });
    step.outputs.forEach((entry) => {
      if (entry.script) {
        scripts.push({ source: entry.script, stepId: step.id, node: ['steps', index, 'outputs', entry.name] });
      }
    });
    if (step.retry.shouldRetry) {
      scripts.push({
        source: step.retry.shouldRetry,
        stepId: step.id,
        node: ['steps', index, 'retry', 'shouldRetry']
      });
    }
  });

  return scripts;
};

/**
 * A name called as a function, where nothing before the `(` is a property access.
 *
 * `res.body.map(…)` is a method on a value this cannot know the shape of, and is skipped by the
 * leading class — only a bare name is a call into the scope §8.6 composes.
 */
const CALL = /(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

/** Names the script itself brings into scope: its declarations, and the parameters it is handed. */
const DECLARED = /\b(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const PARAMETERS = /(?:function\s*\*?\s*[A-Za-z_$][A-Za-z0-9_$]*\s*|function\s*\*?\s*|catch\s*)?\(([^()]*)\)\s*=>|function\s*\*?\s*[A-Za-z_$][A-Za-z0-9_$]*?\s*\(([^()]*)\)|catch\s*\(([^()]*)\)/g;
const BARE_PARAMETER = /(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g;
const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * What a call to a name that is none of these would throw on. Keywords first, because `if (`,
 * `while (` and `return (` are calls by this file's reading of the text and by nobody else's.
 */
const KEYWORDS = [
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'new', 'delete', 'void',
  'await', 'yield', 'throw', 'function', 'class', 'do', 'else', 'in', 'of', 'case', 'with', 'super',
  'this', 'try', 'finally', 'const', 'let', 'var', 'import', 'export', 'default'
];

/**
 * The globals a script may call without declaring anything — the language's own, the handful the
 * sandbox adds (§13.2), and `require`, which both sandboxes answer.
 *
 * Generous on purpose. Every name missing from this list is a warning on code that works, and the
 * cost of those is not symmetric with the cost of a typo going unreported: an author who is told
 * their correct script is broken stops reading the warnings, and the real ones go with them.
 */
const GLOBALS = [
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'Date', 'Error', 'EvalError', 'Function', 'Infinity',
  'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError',
  'ReferenceError', 'Reflect', 'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError', 'TextDecoder',
  'TextEncoder', 'TypeError', 'URIError', 'URL', 'URLSearchParams', 'Uint8Array', 'WeakMap',
  'WeakSet', 'atob', 'btoa', 'console', 'decodeURI', 'decodeURIComponent', 'encodeURI',
  'encodeURIComponent', 'fetch', 'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt',
  'structuredClone', 'undefined',
  // The host's, which §13.2 hands every script position in both sandboxes.
  'Buffer', 'process', 'require', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'bru', 'req', 'expect', 'test'
];

const identifiersIn = (text: string): string[] => text.match(IDENTIFIER) || [];

/** Everything the script brings into its own scope, so a call to one of them is not a call out. */
const boundWithin = (source: string): Set<string> => {
  const bound = new Set<string>();

  for (const match of source.matchAll(DECLARED)) bound.add(match[1]);
  for (const match of source.matchAll(BARE_PARAMETER)) bound.add(match[2]);
  for (const match of source.matchAll(PARAMETERS)) {
    // Destructured and defaulted parameters are taken whole: every name in the list is bound by it,
    // and reading `{ id, name = 'x' }` any more precisely than that needs the parser there is not.
    for (const name of identifiersIn(match[1] || match[2] || match[3] || '')) bound.add(name);
  }

  return bound;
};

/**
 * 001 §8.6 — a script calling a helper that is not in scope.
 *
 * The call throws at run time, and `script-error` reports it against whichever step ran first, which
 * is rarely the step the typo is in and never the line. Read from the text instead, it is named
 * where it is written, before anything runs.
 *
 * **A warning, and the narrowest reading that finds the defect.** This cannot parse, so a call is a
 * bare name before a `(` — and a name it cannot account for is only reported when it is accounted
 * for by nothing at all: not the library, not the script's own declarations or parameters, not the
 * arguments §8.2 hands it, not a global, not a keyword. Everything else stays quiet. A false warning
 * is worse than a missed one here, because it lands on code the author can see working, and the
 * lesson it teaches is to stop reading warnings.
 */
export const checkFunctionCalls = (flow: NormalizedFlow, names: string[], report: Report) => {
  const inScope = new Set([...names, ...SCRIPT_ARGUMENTS, ...GLOBALS, ...KEYWORDS]);

  for (const { source, stepId, node } of scriptPositions(flow)) {
    /**
     * A script this file does not contain is not this file's to report. §8.5's connector files
     * supply outputs that normalization folds into a step, and their scripts run in *this* flow's
     * library — but they are written somewhere else, so a warning here would land on a line the
     * document does not have, and land once per flow that binds the operation rather than once where
     * it is written. The position answering is the same question as the anchor, so it is asked once.
     */
    if (!flow.positions.at(node)) continue;

    const bound = boundWithin(source);
    const reported = new Set<string>();

    for (const match of source.matchAll(CALL)) {
      const name = match[2];
      if (inScope.has(name) || bound.has(name) || reported.has(name)) continue;
      reported.add(name);

      report.warn(
        'unknown-function',
        `${name}() is not a function this flow declares or a script is given, and will throw when the `
        + `script runs — §8.6's functions: block is what puts a helper in scope${suggest(name, names)}`,
        stepId,
        node
      );
    }
  }
};
