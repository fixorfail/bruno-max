/**
 * §8.5's connector files — an operation's default outputs, declared once.
 *
 * `token: data.access_token` in every flow that calls `login` is §1's duplication one layer down:
 * when the API renames the field, every flow is edited by hand. A connector file supplies those
 * outputs for every step that targets the operation, and a step that declares none still has them.
 *
 * **Matching is by resolved spec identity, not by alias.** A connector file declares its own
 * `apis:`, and an entry applies to any step whose operation resolves to the same document and the
 * same operation — whatever alias that flow happens to use. Aliases are flow-local, so keying on
 * them would silently miss every flow that named the spec differently.
 *
 * **Discovery is by convention** — `<workspace>/flows/connectors.yml` and
 * `<collection>/flows/connectors.yml` (§5.1) — so no listing port is needed: the two paths are
 * fixed by the scope a host already supplies, and each is one `ReadFile` that either answers or
 * does not. A file that cannot be read is a scope with no connectors, which is the ordinary case.
 *
 * **Resolution order, later overriding earlier:** workspace file → collection file → the step's own
 * `outputs:`. A layer extends what it inherits, a same-named entry overrides, and `!...` suppresses
 * an inherited one. Which files apply to a flow is decided by *where the flow is* (§5.1's scopes):
 * a sub-flow under the workspace's `flows/` invoked from a collection resolves against the
 * workspace file alone, which is §12.3's rule that connectors never inherit from the caller.
 */
import * as path from 'path';

import {
  asRecord,
  normalizeApis,
  normalizeFlow,
  normalizeOutputs,
  parseDocument,
  type ApiBinding,
  type NormalizedFlow,
  type NormalizedStep,
  type OutputSpec,
  type ParseError,
  type Positions
} from './document';
import { endpointKey, resolveOperation, SpecLoader, type ResolvedOperation, type SpecIndex } from './openapi';
import type { Scope, ValidateOptions } from './types/options';
import type { FlowContext } from './types/ports';

export type ConnectorScope = 'workspace' | 'collection';

/** Where an output was declared — what §8.5 has `bru flow validate` print beside each one. */
export type OutputOrigin = 'inline' | ConnectorScope;

export type ResolvedOutput = OutputSpec & { origin: OutputOrigin; file: string };

/** One `connectors:` entry, with its operation resolved or the reason it could not be. */
export type ConnectorEntry = {
  /** `auth-api#login`, as the file wrote it. */
  key: string;
  outputs: OutputSpec[];
  suppressed: string[];
  /** Outputs written as `null`, which is not the removal token (§8.5) — `validate` refuses them. */
  nulls: string[];
  /** Absent where the entry is not a mapping of outputs, and so declares nothing. */
  mapping: boolean;
  resolved?: { spec: SpecIndex; operation: ResolvedOperation };
  problem?: { code: string; message: string; node: (string | number)[] };
};

export type ConnectorFile = {
  scope: ConnectorScope;
  file: string;
  /** The scope root the file was found under, which decides the flows it applies to. */
  root: string;
  apis: Record<string, ApiBinding>;
  entries: ConnectorEntry[];
  errors: ParseError[];
  positions: Positions;
};

type Layer = { outputs: OutputSpec[]; suppressed: string[] };

export const connectorFileIn = (root: string): string => path.join(root, 'flows', 'connectors.yml');

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * §8.5's identity: the document as resolved, and the operation as method and path. `operationId`
 * is what a reference usually names, but §6.1's fallback lets a step address the same operation
 * as `POST /payments` — and the two must match one connector entry, not two.
 */
const identityOf = (spec: SpecIndex, operation: ResolvedOperation): string =>
  `${spec.source} ${endpointKey(operation.method, operation.template)}`;

const parseConnectorFile = (scope: ConnectorScope, root: string, file: string, text: string): ConnectorFile => {
  const { model, positions, errors } = parseDocument(text);
  const entries = Object.entries(asRecord(model.connectors)).map(([key, value]): ConnectorEntry => {
    const mapping = Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    const { outputs, suppressed } = normalizeOutputs(value);
    return {
      key,
      outputs,
      suppressed,
      nulls: Object.entries(asRecord(value)).filter(([, entry]) => entry === null).map(([name]) => name),
      mapping
    };
  });

  return { scope, file, root, apis: normalizeApis(model.apis), entries, errors, positions };
};

/**
 * The merge one layer performs over what it inherits: a same-named entry replaces the inherited one
 * where it stood, a new name is appended, and a suppression removes. Position is kept so a listing
 * reads in the order the outputs were first declared, whichever file last had the say.
 */
const mergeOutputs = (inherited: ResolvedOutput[], own: ResolvedOutput[], suppressed: string[]): ResolvedOutput[] => {
  const merged = new Map(inherited.map((output) => [output.name, output]));
  for (const output of own) merged.set(output.name, output);
  for (const name of suppressed) merged.delete(name);
  return [...merged.values()];
};

export class Connectors {
  private constructor(
    readonly files: ConnectorFile[],
    private readonly specs: SpecLoader,
    private readonly layers: Map<ConnectorFile, Map<string, Layer>>
  ) {}

  /**
   * Reads whichever of the two conventional files exist and resolves every entry's operation, so
   * a run, a description and a validation all match steps against the same index.
   *
   * A host with no workspace names the collection as both roots (the CLI does), which would read
   * one file twice and count it as two layers — so a file both candidates name is the collection's.
   */
  static async load(
    scope: Scope,
    readText: (file: string) => Promise<string>,
    specs: SpecLoader
  ): Promise<Connectors> {
    const candidates: { scope: ConnectorScope; root: string }[] = [
      { scope: 'workspace', root: scope.workspaceRoot },
      ...(scope.collectionRoot ? [{ scope: 'collection' as const, root: scope.collectionRoot }] : [])
    ];

    const files: ConnectorFile[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const file = connectorFileIn(candidate.root);
      if (candidates.slice(index + 1).some((later) => connectorFileIn(later.root) === file)) continue;

      let text: string;
      try {
        text = await readText(file);
      } catch {
        continue;
      }
      files.push(parseConnectorFile(candidate.scope, candidate.root, file, text));
    }

    const layers = new Map<ConnectorFile, Map<string, Layer>>();
    for (const file of files) {
      const resolved = new Map<string, Layer>();
      for (const entry of file.entries) await Connectors.resolveEntry(file, entry, specs);
      for (const entry of file.entries) {
        if (!entry.resolved) continue;
        resolved.set(identityOf(entry.resolved.spec, entry.resolved.operation), {
          outputs: entry.outputs,
          suppressed: entry.suppressed
        });
      }
      layers.set(file, resolved);
    }

    return new Connectors(files, specs, layers);
  }

  /**
   * One resolution, recorded on the entry: the run and the graph read `resolved`, and `validate`
   * reports `problem` — so an entry the run silently ignores is exactly one `validate` names.
   */
  private static async resolveEntry(file: ConnectorFile, entry: ConnectorEntry, specs: SpecLoader): Promise<void> {
    const separator = entry.key.indexOf('#');
    const alias = separator === -1 ? entry.key : entry.key.slice(0, separator);
    const reference = separator === -1 ? '' : entry.key.slice(separator + 1);
    const node = ['connectors', entry.key];

    const binding = file.apis[alias];
    if (separator === -1 || !binding) {
      entry.problem = {
        code: 'unresolved-alias',
        message: `${entry.key} names the api alias ${alias}, which this file's apis: does not bind`,
        node
      };
      return;
    }

    let spec: SpecIndex;
    try {
      spec = await specs.load(binding.source, file.file);
    } catch (cause) {
      entry.problem = {
        code: 'unresolved-alias',
        message: `${alias} does not resolve: ${(cause as Error).message}`,
        node: ['apis', alias]
      };
      return;
    }

    const operation = resolveOperation(spec, reference);
    if (!operation) {
      entry.problem = { code: 'unknown-operation', message: `${reference} is not an operation in ${spec.source}`, node };
      return;
    }
    if (operation === 'ambiguous') {
      entry.problem = {
        code: 'ambiguous-operation',
        message: `${reference} is declared by more than one operation in ${spec.source} — an operationId identifies one (§6.5)`,
        node
      };
      return;
    }
    entry.resolved = { spec, operation };
  }

  /** The flow's own bindings, indexed — a binding that does not load is `validate`'s to report. */
  private async specsOf(flow: NormalizedFlow): Promise<Map<string, SpecIndex>> {
    const indexed = new Map<string, SpecIndex>();
    for (const binding of Object.values(flow.apis)) {
      try {
        indexed.set(binding.alias, await this.specs.load(binding.source, flow.file));
      } catch {
        // Reported by `validateFlow` against the flow; here the step simply inherits nothing.
      }
    }
    return indexed;
  }

  private outputsFor(step: NormalizedStep, flow: NormalizedFlow, specs: Map<string, SpecIndex>): ResolvedOutput[] {
    const inline = step.outputs.map((output): ResolvedOutput => ({ ...output, origin: 'inline', file: flow.file }));

    const spec = step.operation ? specs.get(step.operation.alias) : undefined;
    const operation = spec && step.operation ? resolveOperation(spec, step.operation.operationId) : undefined;
    const identity = spec && operation && operation !== 'ambiguous' ? identityOf(spec, operation) : undefined;

    let inherited: ResolvedOutput[] = [];
    for (const file of this.files) {
      if (file.scope === 'collection' && !isWithin(file.root, flow.file)) continue;
      const layer = identity === undefined ? undefined : this.layers.get(file)?.get(identity);
      if (!layer) continue;
      inherited = mergeOutputs(
        inherited,
        layer.outputs.map((output): ResolvedOutput => ({ ...output, origin: file.scope, file: file.file })),
        layer.suppressed
      );
    }

    return mergeOutputs(inherited, inline, step.suppressedOutputs);
  }

  /**
   * The flow with every step's outputs resolved — what the run extracts, the graph draws and the
   * validator holds references to. Connector-supplied outputs are declarations like any other from
   * here on (§8.5), and nothing downstream has to know a connector file exists.
   */
  async apply(flow: NormalizedFlow): Promise<NormalizedFlow> {
    if (!this.files.length) return flow;
    const specs = await this.specsOf(flow);
    return { ...flow, steps: flow.steps.map((step) => ({ ...step, outputs: this.outputsFor(step, flow, specs) })) };
  }

  /**
   * §8.5's answer to the locality it costs: each step's resolved outputs and where each was
   * declared. Over the flow as written, not as applied — an applied flow's outputs are all inline
   * by then.
   */
  async resolve(flow: NormalizedFlow): Promise<{ id: string; outputs: ResolvedOutput[] }[]> {
    const specs = await this.specsOf(flow);
    return flow.steps.map((step) => ({ id: step.id, outputs: this.outputsFor(step, flow, specs) }));
  }
}

/**
 * The listing `bru flow validate` prints beneath a flow, beside `resolveFunctions` and for the
 * same reason: a step's available outputs are no longer visible by reading the step, and this is
 * what keeps them discoverable (§8.5). Diagnostics are what a host acts on; a listing is not one,
 * so it is asked for separately.
 */
export const resolveOutputs = async (options: ValidateOptions): Promise<{ id: string; outputs: ResolvedOutput[] }[]> => {
  const context: FlowContext = {
    runId: 'validate',
    flow: options.entry,
    scope: options.scope,
    signal: new AbortController().signal
  };
  const readText = async (file: string) => (await options.ports.readFile(file, context)).toString('utf8');
  const connectors = await Connectors.load(options.scope, readText, new SpecLoader(options.ports.readSpec, context));
  return connectors.resolve(normalizeFlow(parseDocument(await readText(options.entry)), options.entry));
};
