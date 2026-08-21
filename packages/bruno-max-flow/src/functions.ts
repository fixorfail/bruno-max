/**
 * §8.6's script library — the functions a flow's `script:` positions can call.
 *
 * **It is a prelude, not a module system.** The library's source is composed into the same program
 * the call site is evaluated in, so a function is in scope by its name and nothing has to be
 * imported, injected as an argument, or reached through an object. That is what makes it usable from
 * every position §8.2 defines without any of them changing shape.
 *
 * **The hosts are untouched, and that is the point.** `RunScript` (§13.2) hands the host an
 * expression that evaluates to a function; wrapping that expression in an IIFE whose body declares
 * the library keeps the contract exactly as it was, so a library works in both sandboxes, in `bru`
 * and in the app, with no port change and no new IPC. A mechanism that needed a host to cooperate
 * would be a mechanism that behaves differently depending on who ran the flow.
 */
import * as path from 'path';
import * as YAML from 'yaml';

import { asRecord, type NormalizedFlow, type FunctionLibrary } from './document';
import { FileAccessError, type FileReader } from './files';

const YAML_OPTIONS = { merge: true, logLevel: 'silent' as const };

/** What a `use:` entry with this extension is: a library document rather than raw source. */
const isLibraryDocument = (source: string) => ['.yml', '.yaml'].includes(path.extname(source).toLowerCase());

/**
 * A name has to be a JavaScript identifier, because that is what it becomes. Checked rather than
 * escaped: a library entry called `last-four` would otherwise compose into a program that fails to
 * parse, and every script in the flow would fail at once with a syntax error naming none of them.
 */
export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The arguments §8.2 hands a script. A library function taking one of these names shadows it inside
 * every script in the flow, which is a warning rather than an error: shadowing is legal JavaScript
 * and an author who means it is not wrong, but nobody means it by accident twice.
 */
export const SCRIPT_ARGUMENTS = ['res', 'ctx'];

export type LibrarySource = { from: string; name?: string; source: string };

/**
 * Walks `use:` depth-first, then the flow's own definitions — so a file is in scope by the time
 * anything that includes it is read, and the flow itself has the last word on a name.
 *
 * A file already included is skipped rather than read again, which is also what makes a cycle
 * terminate: two libraries that include each other are a diamond, not an error, and the same
 * argument §12's sub-flow loader makes about `seen` applies here.
 *
 * Paths resolve against the file that named them — a library including another library is written
 * from where it sits, not from wherever a flow that uses it happens to be.
 */
export const collectLibrary = async (
  library: FunctionLibrary,
  origin: string,
  read: (source: string, from: string) => Promise<string>,
  seen: Set<string> = new Set()
): Promise<LibrarySource[]> => {
  const collected: LibrarySource[] = [];

  for (const entry of library.use) {
    const resolved = path.resolve(path.dirname(origin), entry);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    const text = await read(entry, origin);
    if (!isLibraryDocument(entry)) {
      // Raw source, composed as written: a library file with a dozen helpers in it is the case this
      // exists for, and naming each one in YAML to get at it would be the duplication §8.5 removes.
      collected.push({ from: resolved, source: text });
      continue;
    }

    const document = asRecord(YAML.parse(text, YAML_OPTIONS));
    const nested: FunctionLibrary = {
      use: document.functions && asRecord(document.functions).use
        ? (asRecord(document.functions).use as unknown[]).map(String)
        : [],
      define: Object.fromEntries(
        Object.entries(asRecord(document.functions))
          .filter(([name]) => name !== 'use')
          .map(([name, source]) => [name, String(source)])
      )
    };
    collected.push(...(await collectLibrary(nested, resolved, read, seen)));
  }

  for (const [name, source] of Object.entries(library.define)) {
    collected.push({ from: origin, name, source });
  }

  return collected;
};

/**
 * What the flow actually ends up with: one entry per name, carrying the declaration that won.
 *
 * A name is kept at the position it was *first* declared and given the source it was *last* given —
 * so a flow overriding a library's function replaces it rather than declaring it twice, which is a
 * syntax error rather than an override. Raw sources stay where they are, since nothing here knows
 * what they declare.
 *
 * This is both what gets composed and what `bru flow validate` prints: a library that reported one
 * set of functions and ran another would be worse than not printing them (§8.5 makes the same point
 * about resolved outputs).
 */
export const effectiveLibrary = (sources: LibrarySource[]): LibrarySource[] => {
  const winner = new Map<string, LibrarySource>();
  for (const entry of sources) {
    if (entry.name) winner.set(entry.name, entry);
  }

  const emitted = new Set<string>();
  return sources.flatMap((entry) => {
    if (!entry.name) return [entry];
    if (emitted.has(entry.name)) return [];
    emitted.add(entry.name);
    return [winner.get(entry.name) as LibrarySource];
  });
};

/**
 * The prelude, as source. `var` rather than `const`: it is the one declaration form that tolerates
 * being re-declared, so a library included twice by two paths that `seen` did not catch stays a
 * working flow instead of a broken one.
 */
export const composeLibrary = (sources: LibrarySource[]): string =>
  effectiveLibrary(sources)
    .map((entry) => (entry.name ? `var ${entry.name} = (${entry.source});` : entry.source))
    .join('\n');

/**
 * The call site, with the library in scope.
 *
 * An expression that evaluates to the script's own function, which is exactly what `RunScript`
 * expects — so a flow with no library composes to the source it was written as, and a host cannot
 * tell the two apart.
 */
export const withLibrary = (prelude: string, source: string): string =>
  (prelude ? `(() => {\n${prelude}\nreturn (${source});\n})()` : source);

/**
 * Everything a run needs, resolved once: read the files, compose the prelude.
 *
 * `FileAccessError` is left to the caller — a library that cannot be read is a flow that cannot run
 * its scripts, and §14.6 reports it where the script would have failed.
 */
export const loadLibrary = async (flow: NormalizedFlow, reader: FileReader): Promise<string> => {
  if (!flow.functions.use.length && !Object.keys(flow.functions.define).length) {
    return '';
  }

  const read = async (source: string, from: string) => {
    // A library is read through the same reader every other file is (§7.4), so a path climbing out
    // of the scope root is refused here too.
    const relative = path.relative(path.dirname(flow.file), path.resolve(path.dirname(from), source));
    const text = await reader(relative.startsWith('.') ? relative : `./${relative}`);
    return text.toString('utf8');
  };

  try {
    return composeLibrary(await collectLibrary(flow.functions, flow.file, read));
  } catch (cause) {
    if (cause instanceof FileAccessError) throw cause;
    throw new FileAccessError('function-library-unreadable', `${(cause as Error).message}`);
  }
};

/**
 * §8.6, for a reader rather than for a run: the functions a flow ends up with and the file each was
 * declared in, in the order they are composed.
 *
 * §8.5 names the cost this pays off — *a step's available outputs are no longer visible by reading
 * the step* — and a library is the same trade one layer along: what a script may call is assembled
 * from files the flow names. `bru flow validate` prints this for the same reason it prints resolved
 * outputs, and it reads only the flow and its libraries, so asking costs no OpenAPI document.
 */
export const resolveLibrary = async (
  flow: NormalizedFlow,
  read: (source: string, from: string) => Promise<string>
): Promise<{ name?: string; from: string }[]> =>
  effectiveLibrary(await collectLibrary(flow.functions, flow.file, read)).map(({ name, from }) => ({ name, from }));
