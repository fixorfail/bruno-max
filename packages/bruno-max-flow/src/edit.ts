/**
 * Editing a flow document through the engine — 005 §9.1's writer and §9.2's read.
 *
 * 001 §18 asked what writes a flow file; this does. The rule the whole module answers to is one
 * sentence: **a structured edit changes the lines it names and no others.** A `.flow.yml` is
 * committed and reviewed, so a writer that read the normalized model and serialized it back would
 * produce a correct flow and an unreviewable diff — every default spelled out, every comment gone,
 * every `!file` destroyed. What happens instead is `meta.ts`' mechanism applied to the rest of the
 * document: parse to the AST with `serialize.ts`' identity tags, mutate the nodes the edit named,
 * re-emit, and transplant the changed lines onto the text that came in.
 *
 * The read half is the same discipline inverted: the editor renders a step **as written** (§6.2), so
 * every field comes off the document and none off `normalizeFlow` — a read through the normalized
 * model followed by a write back would turn a renamed step into a whole-file diff, and would show an
 * author `failOnStatusCode: true` for a key their `config:` set to `false` (§6.5).
 */
import * as YAML from 'yaml';

import { OPERATORS, asRecord, parseDocument, type Position } from './document';
import { UNARY_OPERATORS } from './expression';
import { checkDocumentSchema } from './schema';
import {
  AUTH_MODES,
  CONFIG_KEY_ORDER,
  OUTPUT_SOURCES,
  RETRY_PROPERTIES,
  ROOT_KEY_ORDER,
  STATUSES,
  STEP_KEY_ORDER
} from './schema/v1';
import { PARSE_OPTIONS, ensureBlock } from './serialize';

export type EditValue
  = | null | boolean | number | string
    | EditValue[]
    | { [key: string]: EditValue };

/**
 * Explicit about clearing. `undefined` does not survive structuredClone, so `{ body: undefined }`
 * arrives as an absent key — indistinguishable from "I did not mention body".
 */
export type StepPatch = { set?: Record<string, EditValue>; unset?: string[] };

/**
 * §5.2's `config:`, patched the same way a step is — and for the same reason `unset` exists beside
 * `set`: a flow-wide default is written as an *absence*, so clearing `concurrency` deletes the key
 * rather than spelling `5` out, and a flag returned to its default leaves no trace that it was ever
 * turned off.
 */
export type ConfigPatch = { set?: Record<string, EditValue>; unset?: string[] };

export type StepDraft = { id?: string; operation?: string; uses?: string } & Record<string, EditValue>;

export type ApiBindingDraft = {
  alias: string;
  /** As the file should read it — relative, resolved by the host (001 §6.2). */
  source: string;
  baseUrl?: string;
  auth?: string;
  color?: string;
  rateLimit?: { requests: number; per?: 'second' | 'minute' | 'hour'; burst?: number };
  defaultHeaders?: Record<string, EditValue>;
  defaultQuery?: Record<string, EditValue>;
  /** 001 §10.1's null tolerance for this document. `false` is the meaningful value, so it is written. */
  strictNulls?: boolean;
};

export type FlowEdit
  = | { kind: 'step.insert'; step: StepDraft; after?: string; before?: string }
    | { kind: 'step.remove'; id: string }
    | { kind: 'step.rename'; id: string; to: string }
    | { kind: 'step.duplicate'; id: string; to: string; after?: string }
    | { kind: 'step.move'; id: string; after?: string; before?: string }
    | { kind: 'step.patch'; id: string; patch: StepPatch }
    /** 001 §5.2's flow-wide block. The one edit that addresses the flow rather than a thing in it. */
    | { kind: 'config.patch'; patch: ConfigPatch }
    | { kind: 'api.add'; binding: ApiBindingDraft }
    | { kind: 'api.update'; alias: string; binding: ApiBindingDraft }
    | { kind: 'api.rename'; alias: string; to: string }
    | { kind: 'api.remove'; alias: string }
    /** 001 §8.6's `functions.use:` — a script file every script in the flow may call, as the file should read it. */
    | { kind: 'functions.use'; source: string }
    | { kind: 'functions.unuse'; source: string }
    /**
     * §8.6's other half: the functions the flow defines inline, as a block. Written whole rather
     * than one at a time, because a rename is the commonest edit to a named script and is otherwise
     * a removal and an addition that lose the entry's place.
     */
    | { kind: 'functions.define'; define: Record<string, string> };

/**
 * One vocabulary for every edit, because they all fail for the same handful of reasons and
 * `writeFlowProperties`' `string | undefined` (002 §4.4) does not scale past one function.
 *
 * `unparseable` is the text having no document to edit at all; `unknown-field` a `set` key outside
 * the step's schema; `schema-refused` an error the edit introduced that the text did not have; and
 * `api-in-use` an `api.remove` of a binding a step still references, which carries those steps;
 * `unknown-edit` a kind this build of the engine does not know, which an older engine under a newer
 * renderer would otherwise apply as nothing.
 */
export type FlowEditRefusal
  = | 'unparseable'
    | 'no-such-step' | 'no-such-api'
    | 'duplicate-step-id' | 'duplicate-alias' | 'invalid-step-id'
    | 'unknown-field'
    | 'schema-refused'
    | 'api-in-use'
    | 'unknown-edit';

export type FlowEditResult
  = | {
    ok: true;
    text: string;
    changed: boolean;
    /** The ids `step.insert` and `step.duplicate` wrote, in order — derived ids the caller could not know. */
    inserted?: string[];
  }
  | { ok: false; reason: FlowEditRefusal; message: string; steps?: string[] };

export type StepFields = {
  id: string;
  /** Every key the step declares that this format models, as written — never normalized. */
  fields: Record<string, EditValue>;
  /**
   * Keys the editor must not rewrite: unknown to this build, or carrying a local tag. Named rather
   * than dropped, because 001 §15's "never drops unrecognized fields" is only true if the surface
   * that would drop them can see them.
   */
  opaque: { key: string; tag?: string }[];
  /** One-based, from the parser's line counter — what *Open in YAML* jumps to. */
  position: Position;
  /** Per key, so the jump lands on the key rather than on the step. */
  keyPositions: Record<string, Position>;
};

export type FlowEditModel = {
  steps: StepFields[];
  apis: (ApiBindingDraft & { opaque: string[] })[];
  /**
   * 001 §5.2's `config:` as the file declares it — the flow-wide defaults the pane over them renders
   * from. A key the block does not carry is absent rather than filled in with its default: the pane
   * shows *what the file says*, and the default is what it says by saying nothing.
   */
  config: Record<string, EditValue>;
  /** Names the editor offers in selects — what the flow itself declares (001 §6.4). */
  authProfiles: string[];
  /** 001 §8.6's `functions.use:` entries as written, in order — the shared scripts the flow draws on. */
  functions: string[];
  /** §8.6's other half: the functions this flow defines inline, by name, in the order it declares them. */
  definitions: Record<string, string>;
  /**
   * Every name a `script:` in this flow may call — the inline definitions above, and what each
   * library the flow uses declares.
   *
   * **Absent from a text-only read, and filled in by the host.** A library is a file, and this
   * module does not read files; a host that has the ports resolves them (`resolveFunctions`) and
   * sets this. The editor underlines a name it has not been told about, so a host that leaves it out
   * gets what there was before — an author's own helpers marked as undefined — rather than a wrong
   * answer.
   */
  functionNames?: string[];
  /**
   * The closed vocabularies the editor's controls need. Sent rather than duplicated in the renderer,
   * for 002-C R4's reason: a dropdown offering an operator the engine does not accept is the
   * renderer deciding semantics.
   */
  vocabulary: {
    operators: string[];
    statuses: string[];
    authModes: string[];
    backoff: string[];
    jitter: string[];
    /** The schema's step keys, in order. */
    stepKeys: string[];
    /** §5.2's `config:` keys, in order — what a pane over the block may write. */
    configKeys: string[];
    /** §10.2's operators that take no operand, so a row for one has no value to type into. */
    unaryOperators: string[];
    /** §8.1's kinds of output — the four sources a path is read from, and `script`. */
    outputSources: string[];
  };
};

/** 001 §5.3's id, which is `-`-free because `-` is subtraction in the expression dialect (§10.2). */
const STEP_ID = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** 001 §6.1's second reference form, which §5.1 derives an id from differently. */
const ENDPOINT_REFERENCE = /^(get|put|post|delete|options|head|patch|trace)\s+(\S+)$/i;

/**
 * The keys `ApiBindingDraft` models, in the order a binding is written in; anything else under a
 * binding is the legend's opaque row, and `api.update` leaves it exactly where the author put it.
 */
const BINDING_KEYS = [
  'source', 'baseUrl', 'auth', 'color', 'rateLimit', 'defaultHeaders', 'defaultQuery', 'strictNulls'
];

const rootKeysBefore = (key: string): string[] => ROOT_KEY_ORDER.slice(0, ROOT_KEY_ORDER.indexOf(key));

const refuse = (reason: FlowEditRefusal, message: string, steps?: string[]): FlowEditResult => ({
  ok: false,
  reason,
  message,
  ...(steps ? { steps } : {})
});

const stepsOf = (document: YAML.Document): YAML.YAMLSeq | undefined => {
  const seq = document.getIn(['steps']);
  return YAML.isSeq(seq) ? seq : undefined;
};

const apisOf = (document: YAML.Document): YAML.YAMLMap | undefined => {
  const map = document.getIn(['apis']);
  return YAML.isMap(map) ? map : undefined;
};

const configOf = (document: YAML.Document): YAML.YAMLMap | undefined => {
  const map = document.getIn(['config']);
  return YAML.isMap(map) ? map : undefined;
};

const stepIdOf = (item: unknown): string | undefined => {
  if (!YAML.isMap(item)) return undefined;
  const id = item.get('id');
  return id === undefined || id === null ? undefined : String(id);
};

const declaredStepIds = (document: YAML.Document): string[] => {
  const seq = stepsOf(document);
  if (!seq) return [];
  return seq.items.map(stepIdOf).filter((id): id is string => id !== undefined);
};

const pairFor = (map: YAML.YAMLMap, key: string): YAML.Pair<unknown, unknown> | undefined =>
  map.items.find((item) => String(item.key) === key);

/** The slot names a step's `shared:` publishes to — a list of names, or a mapping of slot → output (001 §9.1). */
const slotsNamed = (shared: EditValue): string[] => {
  if (Array.isArray(shared)) return shared.map(String);
  if (shared !== null && typeof shared === 'object') return Object.keys(shared);
  return [];
};

const scalarText = (item: unknown): string => (YAML.isScalar(item) ? String(item.value) : String(item));

/**
 * §6.2: a slot a step publishes to is declared where the flow reads its slots from. The engine
 * reports no error for a write to a slot no `shared:` block declares — the step publishes, the
 * graph draws no slot to receive it, and only a reader is told the slot is undeclared — so the
 * author who typed the slot on a step would otherwise have to open the YAML to finish the thought.
 * The declaration takes the form the block already has: a name appended to the list, or a
 * `{ writers: all }` entry in the mapping (001 §9.1's default, spelled out because the mapping form
 * exists to spell it), and a flow with no block gets the list. A declaration is never removed here:
 * a slot nobody writes stays legal, and which slots a flow declares is the author's.
 */
const declareSlots = (document: YAML.Document, slots: string[]): void => {
  if (!slots.length) return;
  const declared = document.getIn(['shared']);

  if (YAML.isSeq(declared)) {
    const names = declared.items.map(scalarText);
    for (const slot of slots) {
      if (!names.includes(slot)) declared.add(document.createNode(slot));
    }
    return;
  }
  if (YAML.isMap(declared)) {
    for (const slot of slots) {
      if (pairFor(declared, slot)) continue;
      const rule = document.createNode({ writers: 'all' }) as YAML.YAMLMap;
      rule.flow = true;
      declared.add(document.createPair(slot, rule));
    }
    return;
  }

  // One line, as 001 §9.1 writes its own example — the list is a handful of names, not a block.
  const list = document.createNode([...new Set(slots)]) as YAML.YAMLSeq;
  list.flow = true;
  if (document.has('shared')) {
    document.set('shared', list);
    return;
  }
  ensureBlock(document, 'shared', list, rootKeysBefore('shared'));
};

/**
 * `snake_case`, then §5.3's character class applied to what is left.
 *
 * The acronym pass runs first so `getOrderByID` breaks as `get_order_by_id` rather than as
 * `get_order_by_i_d` — an id is read by whoever writes `{{steps.<id>.x}}` next. A separator the
 * class rejects — `-`, `.`, a space — becomes the one it accepts rather than vanishing, so
 * `create-payment` reads as `create_payment` and not as `createpayment`.
 */
const snakeCase = (name: string): string =>
  name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * §5.1's derivation: one rule, in the engine, so two flows created from one spec name the same
 * operation the same way.
 *
 * A method-and-path reference (001 §6.1's fallback) derives from the static segments, because the
 * templated ones are the parts that differ per call and name nothing about the operation.
 * `undefined` where nothing addressable is left — an `operationId` of punctuation has no id to give.
 */
const operationStepName = (operation: string): string => {
  const reference = operation.includes('#') ? operation.slice(operation.indexOf('#') + 1) : operation;
  const endpoint = reference.match(ENDPOINT_REFERENCE);
  return endpoint
    ? [endpoint[1], ...endpoint[2].split('/').filter((segment) => segment && !segment.startsWith('{'))]
        .map(snakeCase)
        .filter(Boolean)
        .join('_')
    : snakeCase(reference);
};

/**
 * A `uses:` step is named for the file it invokes — `./shared/login.flow.yml` → `login`. The
 * directories say where the library lives and the extension says what kind of file it is; the name
 * is the one part of the path that says what the step does. A `workspace:` prefix (001 §12.2) is
 * a directory for this purpose.
 */
const subflowStepName = (uses: string): string => {
  const filename = uses.split(/[\\/:]/).pop() || '';
  return snakeCase(filename.replace(/\.flow\.ya?ml$|\.ya?ml$/, ''));
};

const derivedStepId = (base: string, taken: string[]): string | undefined => {
  const named = /^[0-9]/.test(base) ? `_${base}` : base;
  if (!STEP_ID.test(named)) return undefined;
  if (!taken.includes(named)) return named;

  let suffix = 2;
  while (taken.includes(`${named}_${suffix}`)) suffix += 1;
  return `${named}_${suffix}`;
};

const isPrimitive = (value: EditValue): value is null | boolean | number | string =>
  value === null || typeof value !== 'object';

/**
 * §8.2's scripts, written as block scalars wherever this writer puts one.
 *
 * Nothing requires it — every script position reads its value as a string, whatever YAML spelling it
 * arrived in — but the library picks a spelling per string, so one flow ends up with a plain scalar,
 * a double-quoted one (the moment a script contains `: `) and a `|-` block (the moment it contains a
 * newline) for three values of the same kind. A script reads as code or it does not; which of the
 * three it got is not information about the flow.
 *
 * Applied to what the writer creates, which is the key being edited and nothing else: a script the
 * author spelled their own way elsewhere in the file is not restyled by an edit that was not about
 * it, which is the same promise this writer makes about comments, anchors and flow style.
 */
const asBlockScalar = (node: unknown): void => {
  if (YAML.isScalar(node) && typeof node.value === 'string') node.type = YAML.Scalar.BLOCK_LITERAL;
};

const styleScripts = (key: string, node: unknown): void => {
  if (key === 'pre' && YAML.isMap(node)) {
    for (const pair of node.items) asBlockScalar(pair.value);
    return;
  }
  if (key === 'outputs' && YAML.isMap(node)) {
    for (const pair of node.items) {
      if (YAML.isMap(pair.value)) asBlockScalar(pair.value.get('script', true));
    }
    return;
  }
  // A step's `retry:` and §5.2's `config.retry:` are the same block, and reach this the same way.
  if (key === 'retry' && YAML.isMap(node)) asBlockScalar(node.get('shouldRetry', true));
};

/**
 * A key written into a block, at the schema's position for it when it is new.
 *
 * An existing scalar is mutated rather than replaced, because replacing the node drops the trailing
 * comment and the quoting style the author chose — a rename would lose `id: charge # the one that
 * matters`. A key the block does not have is spliced after the last key the schema reads *before* it,
 * so a `headers:` added to a step that already declares `assert:` lands above it rather than at the
 * end; keys this build does not model are stepped over, keeping their place.
 *
 * `order` is which schema is being written into — §5.3's step keys or §5.2's `config:` ones. The rule
 * is the same for both, and a second copy of it would drift the first time one of them gained a key.
 */
const writeOrderedKey = (
  document: YAML.Document,
  block: YAML.YAMLMap,
  key: string,
  value: EditValue,
  order: string[]
): void => {
  const existing = pairFor(block, key);
  if (existing) {
    if (YAML.isScalar(existing.value) && isPrimitive(value)) {
      existing.value.value = value;
      return;
    }
    const replacement = document.createNode(value);
    if (YAML.isNode(existing.value)) {
      replacement.comment = existing.value.comment;
      replacement.commentBefore = existing.value.commentBefore;
      replacement.spaceBefore = existing.value.spaceBefore;
    }
    styleScripts(key, replacement);
    existing.value = replacement;
    return;
  }

  const position = order.indexOf(key);
  const at = block.items.reduce((found, item, index) => {
    const declared = order.indexOf(String(item.key));
    return declared !== -1 && declared < position ? index + 1 : found;
  }, 0);
  const pair = document.createPair(key, value) as YAML.Pair<unknown, unknown>;
  styleScripts(key, pair.value);
  block.items.splice(at, 0, pair);
};

const writeStepKey = (document: YAML.Document, step: YAML.YAMLMap, key: string, value: EditValue): void =>
  writeOrderedKey(document, step, key, value, STEP_KEY_ORDER);

/** A step block in §5.3's key order, whatever order the draft's keys arrived in. */
const stepNode = (document: YAML.Document, draft: StepDraft, id: string): unknown => {
  const keys = Object.keys(draft).filter((key) => key !== 'id' && draft[key] !== undefined);
  const ordered = ['id', ...keys.sort((a, b) => STEP_KEY_ORDER.indexOf(a) - STEP_KEY_ORDER.indexOf(b))];
  const node = document.createNode(
    Object.fromEntries(ordered.map((key) => [key, key === 'id' ? id : draft[key]]))
  );

  if (YAML.isMap(node)) {
    for (const pair of node.items) styleScripts(String(pair.key), pair.value);
  }

  return node;
};

/**
 * What the draft says beyond its source, in `BINDING_KEYS` order — a key it says nothing with is not
 * a key. Shared by the two writers below so a binding added and a binding updated agree on both what
 * is written and where.
 */
const bindingEntries = (binding: ApiBindingDraft): [string, EditValue][] =>
  ([
    ['baseUrl', binding.baseUrl],
    ['auth', binding.auth],
    ['color', binding.color],
    ['rateLimit', binding.rateLimit],
    ['defaultHeaders', binding.defaultHeaders],
    ['defaultQuery', binding.defaultQuery],
    ['strictNulls', binding.strictNulls]
  ] as [string, EditValue][]).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    return typeof value === 'object' ? Object.keys(value).length > 0 : String(value).trim() !== '';
  });

/** What a binding reads as: §5.2's shorthand where the alias binds a document and says nothing else. */
const bindingNode = (binding: ApiBindingDraft): EditValue => {
  const entries = bindingEntries(binding);
  if (!entries.length) return binding.source;
  return { source: binding.source, ...Object.fromEntries(entries) };
};

/**
 * A binding brought up to date **in place**, rather than replaced by what the draft holds.
 *
 * `ApiBindingDraft` models eight keys (`BINDING_KEYS`) and a binding may carry more: a key a later
 * format version adds, or one a hand-written file has that this build knows nothing about. Written
 * as a replacement, the mapping becomes the draft exactly — so saving an edit to the colour deleted
 * every one of them, silently, from a form that never showed them. What the draft does not model it
 * cannot have meant to change, so those keys stay where the author put them, in their order.
 *
 * **A modelled key the draft leaves out is still removed**, because that is how the form clears one:
 * the dialog sends the fields that have values and omits the rest, and a merge that kept everything
 * would leave no way to take a colour off. The exception is a key written under a tag (§6.4) — the
 * model reports those as opaque and the form never received it, so its absence from the draft says
 * nothing about what the author wanted.
 *
 * Keys are written through `writeOrderedKey`, so an existing scalar is mutated rather than replaced
 * and its trailing comment and quoting survive (§9.1); flow style survives for the same reason,
 * since the mapping node itself is never rebuilt.
 */
const mergeBinding = (document: YAML.Document, pair: YAML.Pair<unknown, unknown>, binding: ApiBindingDraft): void => {
  // §5.2's shorthand has nothing under it to preserve, and a draft that says more than its source
  // has to become a mapping — both are the node the writer would have built for an `api.add`.
  if (!YAML.isMap(pair.value)) {
    pair.value = document.createNode(bindingNode(binding));
    return;
  }

  const map = pair.value;
  const entries = bindingEntries(binding);
  const written = new Set(entries.map(([key]) => key));

  for (const key of BINDING_KEYS) {
    if (key === 'source' || written.has(key)) continue;
    const declared = pairFor(map, key);
    if (declared && tagUnder(declared.value) === undefined) map.delete(key);
  }

  writeOrderedKey(document, map, 'source', binding.source, BINDING_KEYS);
  for (const [key, value] of entries) writeOrderedKey(document, map, key, value, BINDING_KEYS);

  // Nothing left but the source, and nothing unmodelled holding the mapping open: back to the
  // shorthand, which is what the same binding added from scratch would have read as.
  if (map.items.length === 1 && pairFor(map, 'source')) {
    pair.value = document.createNode(binding.source);
  }
};

/** Steps whose `operation:` names this alias — what an `api.remove` is refused with (§5.5). */
const usersOfAlias = (document: YAML.Document, alias: string): string[] => {
  const seq = stepsOf(document);
  if (!seq) return [];
  return seq.items
    .filter((item) => {
      if (!YAML.isMap(item)) return false;
      const operation = item.get('operation');
      return typeof operation === 'string' && operation.split('#')[0] === alias;
    })
    .map(stepIdOf)
    .filter((id): id is string => id !== undefined);
};

const insertAt = (seq: YAML.YAMLSeq, after?: string, before?: string): number | undefined => {
  if (after !== undefined) {
    const index = seq.items.findIndex((item) => stepIdOf(item) === after);
    return index === -1 ? undefined : index + 1;
  }
  if (before !== undefined) {
    const index = seq.items.findIndex((item) => stepIdOf(item) === before);
    return index === -1 ? undefined : index;
  }
  return seq.items.length;
};

const insertStep = (document: YAML.Document, edit: { step: StepDraft; after?: string; before?: string }, inserted: string[]) => {
  const taken = declaredStepIds(document);
  const operation = typeof edit.step.operation === 'string' ? edit.step.operation : undefined;
  const uses = typeof edit.step.uses === 'string' ? edit.step.uses : undefined;
  const id = edit.step.id !== undefined
    ? edit.step.id
    : operation !== undefined
      ? derivedStepId(operationStepName(operation), taken)
      : uses !== undefined
        ? derivedStepId(subflowStepName(uses), taken)
        : undefined;

  if (id === undefined) {
    return refuse('invalid-step-id', 'a step needs an id, and none could be derived from what it declares');
  }
  if (!STEP_ID.test(id)) {
    return refuse('invalid-step-id', `${id} is not a step id — §5.3 allows letters, digits and _, and no leading digit`);
  }
  if (taken.includes(id)) return refuse('duplicate-step-id', `the flow already has a step called ${id}`);

  const unknown = Object.keys(edit.step).find((key) => key !== 'id' && !STEP_KEY_ORDER.includes(key));
  if (unknown) return refuse('unknown-field', `a step has no ${unknown} field`);

  // §4.1c writes a flow with no `steps:`, so the first insert is the one that creates the block —
  // after the last block §5.2 reads before it, never appended below whatever the file ends with.
  if (!stepsOf(document)) ensureBlock(document, 'steps', [], rootKeysBefore('steps'));
  const seq = stepsOf(document);
  if (!seq) return refuse('schema-refused', 'the document has no root mapping to add steps to');

  const at = insertAt(seq, edit.after, edit.before);
  if (at === undefined) {
    return refuse('no-such-step', `the flow has no step called ${edit.after === undefined ? edit.before : edit.after}`);
  }
  seq.items.splice(at, 0, stepNode(document, edit.step, id));
  if (edit.step.shared !== undefined) declareSlots(document, slotsNamed(edit.step.shared));
  inserted.push(id);
  return undefined;
};

const removeStep = (document: YAML.Document, id: string) => {
  const seq = stepsOf(document);
  const index = seq ? seq.items.findIndex((item) => stepIdOf(item) === id) : -1;
  if (!seq || index === -1) return refuse('no-such-step', `the flow has no step called ${id}`);

  seq.items.splice(index, 1);
  // §5.2: the last step going leaves the file as 002 §4.1c's create form writes it, rather than
  // `steps: []` — the two mean the same to the engine, and one of them is what a person would type.
  if (!seq.items.length) document.deleteIn(['steps']);
  return undefined;
};

const stepMap = (document: YAML.Document, id: string): YAML.YAMLMap | undefined => {
  const seq = stepsOf(document);
  if (!seq) return undefined;
  const item = seq.items.find((entry) => stepIdOf(entry) === id);
  return YAML.isMap(item) ? item : undefined;
};

const renameStep = (document: YAML.Document, id: string, to: string) => {
  const step = stepMap(document, id);
  if (!step) return refuse('no-such-step', `the flow has no step called ${id}`);
  if (!STEP_ID.test(to)) {
    return refuse('invalid-step-id', `${to} is not a step id — §5.3 allows letters, digits and _, and no leading digit`);
  }
  if (declaredStepIds(document).some((other) => other !== id && other === to)) {
    return refuse('duplicate-step-id', `the flow already has a step called ${to}`);
  }

  // Nothing else is rewritten (§6.6). A `depends:` or a `{{steps.<old>.x}}` now dangles, and each is
  // a diagnostic 001 §14.3 anchors on the line that has it — which is a statement the author can act
  // on, where a rewrite would be an edit made on a guess in a place they are not looking.
  writeStepKey(document, step, 'id', to);
  return undefined;
};

const duplicateStep = (document: YAML.Document, edit: { id: string; to: string; after?: string }, inserted: string[]) => {
  const seq = stepsOf(document);
  const index = seq ? seq.items.findIndex((item) => stepIdOf(item) === edit.id) : -1;
  if (!seq || index === -1) return refuse('no-such-step', `the flow has no step called ${edit.id}`);
  if (!STEP_ID.test(edit.to)) {
    return refuse('invalid-step-id', `${edit.to} is not a step id — §5.3 allows letters, digits and _, and no leading digit`);
  }
  if (declaredStepIds(document).includes(edit.to)) {
    return refuse('duplicate-step-id', `the flow already has a step called ${edit.to}`);
  }

  const source = seq.items[index];
  if (!YAML.isMap(source)) return refuse('no-such-step', `${edit.id} is not a step block`);
  const copy = source.clone() as YAML.YAMLMap;
  // An anchor names one node in a document; a copy carrying the original's would leave two, and
  // every `*name` after it would resolve to whichever the emitter wrote last.
  YAML.visit(copy, { Value: (unused, node) => { node.anchor = undefined; } });
  writeStepKey(document, copy, 'id', edit.to);

  const at = edit.after === undefined ? index + 1 : insertAt(seq, edit.after);
  if (at === undefined) return refuse('no-such-step', `the flow has no step called ${edit.after}`);
  seq.items.splice(at, 0, copy);
  inserted.push(edit.to);
  return undefined;
};

const moveStep = (document: YAML.Document, edit: { id: string; after?: string; before?: string }) => {
  const seq = stepsOf(document);
  const index = seq ? seq.items.findIndex((item) => stepIdOf(item) === edit.id) : -1;
  if (!seq || index === -1) return refuse('no-such-step', `the flow has no step called ${edit.id}`);

  const item = seq.items[index];
  seq.items.splice(index, 1);
  const at = insertAt(seq, edit.after, edit.before);
  if (at === undefined) {
    seq.items.splice(index, 0, item);
    return refuse('no-such-step', `the flow has no step called ${edit.after === undefined ? edit.before : edit.after}`);
  }
  seq.items.splice(at, 0, item);
  // A blank line between two steps separates them; it does not belong to the one below it. `yaml`
  // records it on the node, so a move that changes which step comes first would otherwise open the
  // block on an indented empty line and glue the moved step to the one it landed after.
  const spaced = seq.items.some((entry, position) => position > 0 && YAML.isNode(entry) && entry.spaceBefore);
  for (const [position, entry] of seq.items.entries()) {
    if (YAML.isNode(entry)) entry.spaceBefore = spaced && position > 0;
  }
  return undefined;
};

const patchStep = (document: YAML.Document, id: string, patch: StepPatch) => {
  const step = stepMap(document, id);
  if (!step) return refuse('no-such-step', `the flow has no step called ${id}`);

  const set = patch.set || {};
  const unknown = Object.keys(set).find((key) => !STEP_KEY_ORDER.includes(key));
  if (unknown) return refuse('unknown-field', `a step has no ${unknown} field`);

  // §9.1: a default is written as an absence, so clearing a field deletes its key rather than
  // spelling the default out — which is why `unset` exists beside `set` at all.
  for (const key of patch.unset || []) step.delete(key);
  for (const [key, value] of Object.entries(set)) writeStepKey(document, step, key, value);
  if (set.shared !== undefined) declareSlots(document, slotsNamed(set.shared));
  return undefined;
};

/**
 * §5.2's `config:` block — the one edit that addresses the flow rather than something in it.
 *
 * The body is `patchStep`'s, because a flow-wide default and a step's override are written the same
 * way: `set` writes, `unset` deletes, and a default is an absence rather than a value spelled out.
 * Two things are its own, and both come from `config:` being a *block* rather than a key in one:
 *
 * - **It is created when the flow has none**, in §5.2's position. Turning the first flag off is the
 *   common case, and a refusal there would mean "open the YAML tab first" for the one edit the pane
 *   exists to make.
 * - **It is removed when its last key goes.** A flow returned to its defaults should read as one; a
 *   `config: {}` left behind is a block that says nothing and still has to be explained to whoever
 *   reads the file next.
 */
const patchConfig = (document: YAML.Document, patch: ConfigPatch) => {
  const set = patch.set || {};
  const unknown = Object.keys(set).find((key) => !CONFIG_KEY_ORDER.includes(key));
  if (unknown) return refuse('unknown-field', `a flow's config has no ${unknown} field`);

  const writes = Object.entries(set);
  const unset = patch.unset || [];
  // A block that does not exist has nothing to delete from, and is not created to hold nothing.
  if (!configOf(document) && !writes.length) return undefined;
  if (!configOf(document)) ensureBlock(document, 'config', {}, rootKeysBefore('config'));

  const config = configOf(document);
  if (!config) return undefined;

  for (const key of unset) config.delete(key);
  for (const [key, value] of writes) writeOrderedKey(document, config, key, value, CONFIG_KEY_ORDER);
  if (!config.items.length) document.delete('config');

  return undefined;
};

const addApi = (document: YAML.Document, binding: ApiBindingDraft) => {
  const apis = apisOf(document);
  if (apis && pairFor(apis, binding.alias)) {
    return refuse('duplicate-alias', `the flow already binds ${binding.alias}`);
  }

  if (!apis) ensureBlock(document, 'apis', {}, rootKeysBefore('apis'));
  document.setIn(['apis', binding.alias], bindingNode(binding));
  return undefined;
};

/**
 * §5.5: an alias renamed is renamed where the steps say it. Unlike a step id (§5.2), which can be
 * meant or not meant by any `steps.<id>` in a body or a script, an alias has exactly one place a
 * step names it — the prefix of `operation: <alias>#<reference>` — so retargeting it is reading,
 * not guessing, and leaving it would turn every step of the API red for a rename of a label.
 */
const retargetOperations = (document: YAML.Document, alias: string, to: string): void => {
  const seq = stepsOf(document);
  if (!seq) return;
  for (const item of seq.items) {
    if (!YAML.isMap(item)) continue;
    const operation = pairFor(item, 'operation');
    if (!operation || !YAML.isScalar(operation.value)) continue;
    const text = String(operation.value.value);
    if (text.startsWith(`${alias}#`)) operation.value.value = `${to}#${text.slice(alias.length + 1)}`;
  }
};

const updateApi = (document: YAML.Document, alias: string, binding: ApiBindingDraft) => {
  const apis = apisOf(document);
  const existing = apis ? pairFor(apis, alias) : undefined;
  if (!apis || !existing) return refuse('no-such-api', `the flow binds no api called ${alias}`);
  if (binding.alias !== alias && pairFor(apis, binding.alias)) {
    return refuse('duplicate-alias', `the flow already binds ${binding.alias}`);
  }

  if (binding.alias !== alias && YAML.isScalar(existing.key)) existing.key.value = binding.alias;
  mergeBinding(document, existing, binding);
  if (binding.alias !== alias) retargetOperations(document, alias, binding.alias);
  return undefined;
};

const renameApi = (document: YAML.Document, alias: string, to: string) => {
  const apis = apisOf(document);
  const existing = apis ? pairFor(apis, alias) : undefined;
  if (!apis || !existing) return refuse('no-such-api', `the flow binds no api called ${alias}`);
  if (pairFor(apis, to)) return refuse('duplicate-alias', `the flow already binds ${to}`);

  if (YAML.isScalar(existing.key)) existing.key.value = to;
  retargetOperations(document, alias, to);
  return undefined;
};

const removeApi = (document: YAML.Document, alias: string) => {
  const apis = apisOf(document);
  if (!apis || !pairFor(apis, alias)) return refuse('no-such-api', `the flow binds no api called ${alias}`);

  // §5.5: unlike a dangling `depends`, there is no diagnostic anchored where the author is looking —
  // every step through the alias would go red at once and the legend row that caused it would be gone.
  const used = usersOfAlias(document, alias);
  if (used.length) {
    return refuse('api-in-use', `${alias} is used by ${used.join(', ')}`, used);
  }

  apis.delete(alias);
  // An empty `apis:` is the shape 002 §4.1c's create form declines to write, for the reason a
  // cleared `meta:` key is deleted rather than spelled out.
  if (!apis.items.length) document.deleteIn(['apis']);
  return undefined;
};

/** `functions.use:` as written — one path, or a list of them (001 §8.6). */
const usedScripts = (document: YAML.Document): string[] => {
  const use = document.getIn(['functions', 'use'], true);
  if (YAML.isSeq(use)) return use.items.map(scalarText);
  if (YAML.isScalar(use)) return [String(use.value)];
  return [];
};

/**
 * §6.2: a shared script joins the flow's `functions.use:` list. The block is created where §5.2
 * reads it when there is none, the one-path string form becomes a list once there are two, and a
 * path already listed is not listed twice — the second use is `changed: false`, not an error, since
 * the author asked for a state the file is already in.
 */
const useScript = (document: YAML.Document, source: string) => {
  const listed = usedScripts(document);
  if (listed.includes(source)) return undefined;

  const functions = document.getIn(['functions']);
  if (!YAML.isMap(functions)) ensureBlock(document, 'functions', {}, rootKeysBefore('functions'));
  const use = document.getIn(['functions', 'use']);
  if (YAML.isSeq(use)) {
    use.add(document.createNode(source));
    return undefined;
  }
  const list = document.createNode([...listed, source]) as YAML.YAMLSeq;
  list.flow = true;
  document.setIn(['functions', 'use'], list);
  return undefined;
};

/** The reverse: the last path gone takes `use:` with it, and an empty block goes too. */
/**
 * §8.6's inline definitions, as a block — `use:` is left exactly as it was.
 *
 * The two halves of `functions:` are different statements in one key: `use:` names files, and every
 * other key is a function this flow defines. So a write here reaches only the keys that are not
 * `use`, in the order given, and the block goes when neither half has anything left.
 *
 * Each source is written as a block scalar for §8.2's reason — these are the same functions every
 * script position calls, and a spelling per string across one file is noise.
 */
const defineFunctions = (document: YAML.Document, define: Record<string, string>) => {
  const named = Object.keys(define).find((name) => name === 'use');
  if (named) return refuse('unknown-field', 'use: names the scripts a flow reads, and is not a function it defines');

  const existing = document.getIn(['functions']);
  if (!YAML.isMap(existing) && Object.keys(define).length) {
    ensureBlock(document, 'functions', {}, rootKeysBefore('functions'));
  }

  const functions = document.getIn(['functions']);
  if (!YAML.isMap(functions)) return undefined;

  functions.items = functions.items.filter((pair) => String(pair.key) === 'use');
  for (const [name, source] of Object.entries(define)) {
    const pair = document.createPair(name, source) as YAML.Pair<unknown, unknown>;
    asBlockScalar(pair.value);
    functions.items.push(pair);
  }

  if (!functions.items.length) document.delete('functions');
  return undefined;
};

const unuseScript = (document: YAML.Document, source: string) => {
  const listed = usedScripts(document);
  if (!listed.includes(source)) return undefined;

  const remaining = listed.filter((entry) => entry !== source);
  const use = document.getIn(['functions', 'use']);
  if (YAML.isSeq(use) && remaining.length) {
    use.items = use.items.filter((item) => scalarText(item) !== source);
    return undefined;
  }
  if (!remaining.length) {
    document.deleteIn(['functions', 'use']);
    const functions = document.getIn(['functions']);
    if (YAML.isMap(functions) && !functions.items.length) document.delete('functions');
    return undefined;
  }
  document.setIn(['functions', 'use'], remaining.length === 1 ? remaining[0] : remaining);
  return undefined;
};

const applyEdit = (document: YAML.Document, edit: FlowEdit, inserted: string[]): FlowEditResult | undefined => {
  switch (edit.kind) {
    case 'step.insert': return insertStep(document, edit, inserted);
    case 'step.remove': return removeStep(document, edit.id);
    case 'step.rename': return renameStep(document, edit.id, edit.to);
    case 'step.duplicate': return duplicateStep(document, edit, inserted);
    case 'step.move': return moveStep(document, edit);
    case 'step.patch': return patchStep(document, edit.id, edit.patch);
    case 'config.patch': return patchConfig(document, edit.patch);
    case 'api.add': return addApi(document, edit.binding);
    case 'api.update': return updateApi(document, edit.alias, edit.binding);
    case 'api.rename': return renameApi(document, edit.alias, edit.to);
    case 'api.remove': return removeApi(document, edit.alias);
    case 'functions.use': return useScript(document, edit.source);
    case 'functions.unuse': return unuseScript(document, edit.source);
    case 'functions.define': return defineFunctions(document, edit.define);
    // A kind this build does not know — a renderer newer than its engine — is said, not skipped:
    // an edit that changes nothing and reports nothing is the one failure nobody can see.
    default: return refuse('unknown-edit', `this engine has no ${(edit as { kind: string }).kind} edit`);
  }
};

/**
 * A flow with no `steps:` — which 001 §5.4 requires and 002 §4.1c's create form does not write.
 *
 * The absence is a legal authoring state at both ends of a flow's life: it is what the app creates
 * before the first insert, and §5.2 says it is what the file returns to when the last step is
 * removed. The schema has no way to say "required, except while the author is still building it", so
 * the gate does: counting this one would refuse the delete that restores the create form's own
 * output, and refuse it with the schema as the reason.
 */
const MISSING_STEPS = /required property 'steps'/;

/**
 * The schema errors a document carries, keyed so before and after can be compared.
 *
 * Errors only: an unknown property is a *warning* (001 §5.4), because 001 §15 has an older Bruno
 * open a file a newer one wrote — a gate that refused those would refuse every flow from the future.
 */
const schemaErrors = (text: string): Set<string> => {
  const { model } = parseDocument(text);
  return new Set(
    checkDocumentSchema(model)
      .filter((issue) => issue.severity === 'error' && !MISSING_STEPS.test(issue.message))
      .map((issue) => `${issue.node.join('.')} ${issue.message}`)
  );
};

/**
 * The edited document's lines, transplanted onto the text that came in.
 *
 * `String(document)` is the whole of how an edit is written, but it re-emits the *document*, not the
 * file: the library has one flow-collection padding setting for the whole document, one line width,
 * and no memory of the spaces an author used to align a column of trailing comments. Emitting it
 * directly would re-spell `depends: [a, b]` and collapse a comment column a hundred lines from the
 * edit — which is precisely the diff §9.1 promises not to produce.
 *
 * So the document is emitted twice, before and after the mutation. Both come off the same emitter, so
 * they differ only where the edit acted, and the span between the first and last differing line is
 * the edit; everything outside it is taken from the original text byte for byte. What is left is
 * §9.1's one stated exception — a trailing comment re-spaced — confined to the lines that changed.
 *
 * The emitter can also change how many lines a document takes (a flow mapping too long for the line
 * width becomes a block). There is then no line-for-line correspondence to transplant onto, and the
 * emitted text stands: a correct file that reformats beats a wrong one that does not.
 */
const transplant = (text: string, baseline: string, edited: string): string => {
  if (edited === baseline) return text;

  const original = text.split('\n');
  const before = baseline.split('\n');
  if (before.length !== original.length) return edited;

  const after = edited.split('\n');
  const shortest = Math.min(before.length, after.length);
  let head = 0;
  while (head < shortest && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < shortest - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    tail += 1;
  }

  return [
    ...original.slice(0, head),
    ...after.slice(head, after.length - tail),
    ...original.slice(original.length - tail)
  ].join('\n');
};

/**
 * §9.1's writer: text in, text out, and nothing on disk.
 *
 * **One entry point over a list of edits**, because edits compose and have to compose inside one
 * parse: applying them one call at a time would be parse → emit → parse → emit, and the second parse
 * re-derives every node from text the first pass just rewrote. The preservation above holds across a
 * compound edit only because there is one parse and one emission.
 *
 * **Refuse rather than corrupt, and refuse only what the edit caused.** The schema pass runs before
 * and after: a flow can carry an error before the edit — the schema requires `steps`, so every flow
 * 002 §4.1c's create form writes is invalid until its first step — and a gate refusing any error
 * would refuse that first insert. On refusal the original text stands, and text that does not parse
 * is refused rather than rebuilt from scratch, which is `writeFlowProperties`' exact position.
 */
export const applyFlowEdits = (text: string, edits: FlowEdit[]): FlowEditResult => {
  const document = YAML.parseDocument(text, PARSE_OPTIONS);
  if (document.errors.length) {
    return refuse('unparseable', document.errors[0].message.split('\n')[0]);
  }

  const before = schemaErrors(text);
  const baseline = String(document);
  const inserted: string[] = [];

  for (const edit of edits) {
    const refusal = applyEdit(document, edit, inserted);
    if (refusal) return refusal;
  }

  const written = transplant(text, baseline, String(document));
  const introduced = [...schemaErrors(written)].filter((error) => !before.has(error));
  if (introduced.length) return refuse('schema-refused', introduced[0]);

  return { ok: true, text: written, changed: written !== text, ...(inserted.length ? { inserted } : {}) };
};

const positionOf = (lines: YAML.LineCounter, node: unknown): Position | undefined => {
  // A node from a merge key or an alias has no range of its own; there is no line to point at, and
  // inventing one would point at the anchor a reader did not write.
  if (!YAML.isNode(node) || !node.range) return undefined;
  const { line, col } = lines.linePos(node.range[0]);
  return { line, column: col };
};

/**
 * The first tag anywhere under a value, which is what makes its key opaque (§6.4).
 *
 * The *subtree*, not the node: `outputs: { role: !... }` carries no tag on `outputs` itself, and an
 * editor that re-emitted the mapping around the suppression would destroy it just the same.
 */
const tagUnder = (node: unknown): string | undefined => {
  if (!YAML.isNode(node)) return undefined;
  let found: string | undefined;
  YAML.visit(node, {
    Node: (unused, child) => {
      if (child.tag && found === undefined) found = child.tag;
    }
  });
  return found;
};

const bindingOf = (alias: string, node: unknown, declared: unknown): ApiBindingDraft & { opaque: string[] } => {
  if (typeof declared === 'string') return { alias, source: declared, opaque: [] };

  const fields = asRecord(declared);
  const opaque = YAML.isMap(node)
    ? node.items
        .filter((item) => !BINDING_KEYS.includes(String(item.key)) || tagUnder(item.value) !== undefined)
        .map((item) => String(item.key))
    : [];
  const declaredText = (key: string): string | undefined =>
    (fields[key] === undefined || fields[key] === null || opaque.includes(key) ? undefined : String(fields[key]));
  const declaredMap = (key: string): Record<string, EditValue> | undefined =>
    (fields[key] === undefined || opaque.includes(key) ? undefined : asRecord(fields[key]) as Record<string, EditValue>);

  const baseUrl = declaredText('baseUrl');
  const auth = declaredText('auth');
  const color = declaredText('color');
  const rateLimit = declaredMap('rateLimit');
  const defaultHeaders = declaredMap('defaultHeaders');
  const defaultQuery = declaredMap('defaultQuery');
  // Read as the boolean it is, not through `declaredText`: `false` is this key's meaningful value
  // (001 §10.1), and a `'false'` string would read as true in every control that renders it.
  const strictNulls
    = fields.strictNulls === undefined || opaque.includes('strictNulls')
      ? undefined
      : Boolean(fields.strictNulls);

  return {
    alias,
    source: declaredText('source') || '',
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(auth === undefined ? {} : { auth }),
    ...(color === undefined ? {} : { color }),
    ...(rateLimit === undefined ? {} : { rateLimit: rateLimit as ApiBindingDraft['rateLimit'] }),
    ...(defaultHeaders === undefined ? {} : { defaultHeaders }),
    ...(defaultQuery === undefined ? {} : { defaultQuery }),
    ...(strictNulls === undefined ? {} : { strictNulls }),
    opaque
  };
};

/**
 * §9.2's read: the step editor's source of truth.
 *
 * `undefined` for text that does not parse, for `readFlowProperties`' reason — there is no document
 * to render, and a form over a document nobody could read would offer to write one back.
 *
 * The model is what the *editor* renders from; 002 §11.1's description is what the *graph* renders
 * from, and neither is widened to carry the other: a description is snapshotted into every run's
 * `run.json` (001 §14.5), so carrying step bodies here would write every request into every stored
 * run forever, for a pane only the editor has.
 */
export const readFlowEditModel = (text: string): FlowEditModel | undefined => {
  const lineCounter = new YAML.LineCounter();
  const document = YAML.parseDocument(text, { ...PARSE_OPTIONS, lineCounter });
  if (document.errors.length) return undefined;

  // The document's own projection, so an alias resolves to what it points at and a merge key is not
  // mistaken for a field. Keys still come off the nodes below, so what a step *declares* is what the
  // editor sees — a key reached only through `<<:` belongs to the anchor, not to this step.
  const model = asRecord(document.toJS());
  const declaredSteps = Array.isArray(model.steps) ? model.steps : [];
  const seq = stepsOf(document);

  const steps: StepFields[] = (seq ? seq.items : []).flatMap((item, index) => {
    const id = stepIdOf(item);
    if (!YAML.isMap(item) || id === undefined) return [];

    const declared = asRecord(declaredSteps[index]);
    const fields: Record<string, EditValue> = {};
    const opaque: { key: string; tag?: string }[] = [];
    const keyPositions: Record<string, Position> = {};

    for (const pair of item.items) {
      const key = String(pair.key);
      const at = positionOf(lineCounter, pair.key);
      if (at) keyPositions[key] = at;

      const tag = tagUnder(pair.value);
      if (tag !== undefined) opaque.push({ key, tag });
      else if (!STEP_KEY_ORDER.includes(key)) opaque.push({ key });
      else fields[key] = declared[key] as EditValue;
    }

    return [{
      id,
      fields,
      opaque,
      // A step that is an alias has no source of its own to point at; the file's first line is where
      // *Open in YAML* lands rather than nowhere.
      position: positionOf(lineCounter, item) || { line: 1, column: 1 },
      keyPositions
    }];
  });

  const apis = apisOf(document);
  const declaredApis = asRecord(model.apis);

  return {
    steps,
    apis: apis
      ? apis.items.map((pair) => bindingOf(String(pair.key), pair.value, declaredApis[String(pair.key)]))
      : [],
    // The flow's own profiles. A connector file supplies more (001 §8.5), and finding them means
    // reading other files — which is `listFlowOperations`' kind of work, not a pure read of one text.
    authProfiles: Object.keys(asRecord(model.authProfiles)),
    functions: usedScripts(document),
    // Every key of the block but `use:`, which names files rather than defining anything.
    definitions: Object.fromEntries(
      Object.entries(asRecord(model.functions))
        .filter(([name]) => name !== 'use')
        .map(([name, source]) => [name, String(source)])
    ),
    config: asRecord(model.config) as Record<string, EditValue>,
    vocabulary: {
      operators: [...OPERATORS],
      statuses: STATUSES,
      authModes: AUTH_MODES,
      backoff: RETRY_PROPERTIES.backoff.enum,
      jitter: RETRY_PROPERTIES.jitter.enum,
      stepKeys: STEP_KEY_ORDER,
      configKeys: CONFIG_KEY_ORDER,
      unaryOperators: UNARY_OPERATORS,
      outputSources: OUTPUT_SOURCES
    }
  };
};
