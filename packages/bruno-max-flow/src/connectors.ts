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
  normalizeAuthProfiles,
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
import {
  endpointKey,
  resolveOperation,
  resolveSpecSource,
  SpecLoader,
  type ResolvedOperation,
  type SpecIndex
} from './openapi';
import { merge } from './materialize';
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
  /**
   * §6.4's profiles, declared once beside the API they authenticate (§8.5).
   *
   * A credential is a property of the service in the same way a host is, and the flows that call one
   * API almost always authenticate to it identically — so a scope that states the binding and stops
   * short of the profile has moved four fields and left the fifth in every flow.
   */
  authProfiles: Record<string, Record<string, unknown>>;
  /**
   * The `apis:` block exactly as written, because normalization drops what it does not recognize and
   * `validate` is the only thing that can tell a key it ignored from a key nobody wrote. A connector
   * file is schema-checked nowhere — §5.4's schema describes a flow document, whose root forbids
   * `connectors:` — so a misspelt `ratelimit:` here would otherwise be silence.
   */
  rawApis: Record<string, unknown>;
  entries: ConnectorEntry[];
  errors: ParseError[];
  positions: Positions;
};

type Layer = { outputs: OutputSpec[]; suppressed: string[] };

export const connectorFileIn = (root: string): string => path.join(root, 'flows', 'connectors.yml');

/**
 * A binding's fields minus the ones it did not declare, so a later layer's silence does not erase an
 * earlier layer's value. `alias` and `source` go too: both are the connector file's own, and neither
 * is inheritable — see `apisWith`.
 */
const omitUndefined = (binding: ApiBinding): Partial<ApiBinding> =>
  Object.fromEntries(
    Object.entries(binding).filter(
      ([key, value]) => value !== undefined && key !== 'alias' && key !== 'source'
    )
  );

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

  return {
    scope,
    file,
    root,
    apis: normalizeApis(model.apis),
    rawApis: asRecord(model.apis),
    authProfiles: normalizeAuthProfiles(model.authProfiles),
    entries,
    errors,
    positions
  };
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
    private readonly layers: Map<ConnectorFile, Map<string, Layer>>,
    private readonly bindings: Map<ConnectorFile, Map<string, ApiBinding>>
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
    const bindings = new Map<ConnectorFile, Map<string, ApiBinding>>();
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

      /**
       * §8.5's bindings, indexed by where their `source:` resolves to rather than by the alias the
       * file chose — the same identity rule the outputs above are matched on, so a default reaches a
       * flow that named the same document something else.
       *
       * Resolved rather than loaded: `resolveSpecSource` is the path `SpecLoader` will read, so a
       * connector file may carry defaults for a document this scope never opens without costing a
       * fetch, and a `source:` that does not resolve is still `validate`'s to report.
       */
      bindings.set(
        file,
        new Map(Object.values(file.apis).map((binding) => [resolveSpecSource(binding.source, file.file), binding]))
      );
    }

    return new Connectors(files, specs, layers, bindings);
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
    // The bindings pass runs even with no connector files: it is also where a `!...` in a binding's
    // own defaults is resolved, and a scope with nothing to inherit still has to resolve it.
    const apis = this.apisWith(flow);
    if (!this.files.length) return { ...flow, apis };

    const specs = await this.specsOf(flow);
    return {
      ...flow,
      apis,
      ...this.profilesWith(flow),
      steps: flow.steps.map((step) => ({ ...step, outputs: this.outputsFor(step, flow, specs) }))
    };
  }

  /**
   * The flow's profiles over the scope's (§8.5), by name — the flow's own winning, and the
   * collection's over the workspace's, exactly as an output or a binding field does.
   *
   * **Folded into the flow's own block rather than carried separately**, which is what makes the
   * rest of the engine need no changes: `referencesOf` sweeps the profile a step uses, so a
   * `{{shared.userAuthToken}}` written here is checked by `validate`, drawn as a data edge by
   * `describe`, and counted as a read of the slot — none of which would happen for a profile the
   * flow's model did not contain.
   *
   * **It resolves in the scope of the step that uses it**, since `run.ts` gives every profile in
   * this block the using flow's scope. That is the only coherent reading: a connector file has no
   * steps and no run state of its own, so `{{shared.x}}` and `{{params.x}}` can only mean the
   * flow's. Matched by *name*, unlike a binding or an output — a profile is not attached to a
   * document, and §6.4 already addresses profiles by name everywhere else.
   *
   * The flow still declares the slot such a profile reads. `shared:` states which of *this flow's*
   * steps may write a value (§9.1), which is a fact about this graph and not about the service — and
   * it is what keeps `{{shared.userAuthToken}}` traceable to something written in the file you are
   * reading. A flow that forgets it is told so: `undeclared-slot`, before anything is sent.
   */
  private profilesWith(flow: NormalizedFlow): Pick<NormalizedFlow, 'authProfiles' | 'authProfileOrigins'> {
    let inherited: Record<string, Record<string, unknown>> = {};
    const origins: Record<string, string> = {};
    for (const file of this.files) {
      if (file.scope === 'collection' && !isWithin(file.root, flow.file)) continue;
      inherited = { ...inherited, ...file.authProfiles };
      for (const name of Object.keys(file.authProfiles)) origins[name] = file.file;
    }

    // A name the flow declares itself is the flow's, whatever a scope file also called it.
    for (const name of Object.keys(flow.authProfiles)) delete origins[name];

    return { authProfiles: { ...inherited, ...flow.authProfiles }, authProfileOrigins: origins };
  }

  /**
   * The flow's bindings with a connector file's defaults filled in (§8.5) — the same layering the
   * outputs above take, and for the same reason: `baseUrl`, `auth`, the default headers and query,
   * the colour and the rate are all properties of the *service*, and a team should be able to state
   * them once rather than in every flow that calls it.
   *
   * **The flow's own declaration wins outright, field by field.** Layer order (workspace →
   * collection) decides which *default* applies, not which value the run uses; a flow that writes a
   * field down has said what it wants. `defaultHeaders` and `defaultQuery` merge key by key instead
   * of replacing, through the same `merge` a step's inline values take over a binding's (§7.2), so a
   * flow adds one header without restating the scope's and drops an inherited one with `!...`.
   *
   * **`source:` is never inherited.** It is what the match is *on* — a binding with no source names
   * no document and there is nothing to look up. That is what keeps a flow readable: the file still
   * says which APIs it talks to, and a scope file fills in only how to talk to them.
   *
   * **`baseUrl` lands in `inheritedBaseUrl`**, because §6.3 ranks a scope file's host below the
   * flow's own `config.baseUrl` — see `resolveBaseUrl`.
   */
  private apisWith(flow: NormalizedFlow): Record<string, ApiBinding> {
    return Object.fromEntries(
      Object.entries(flow.apis).map(([alias, binding]) => {
        const identity = resolveSpecSource(binding.source, flow.file);

        let inherited: Partial<ApiBinding> = {};
        let defaultHeaders: unknown = {};
        let defaultQuery: unknown = {};
        for (const file of this.files) {
          if (file.scope === 'collection' && !isWithin(file.root, flow.file)) continue;
          const found = this.bindings.get(file)?.get(identity);
          if (!found) continue;
          inherited = { ...inherited, ...omitUndefined(found) };
          defaultHeaders = merge(defaultHeaders, found.defaultHeaders);
          defaultQuery = merge(defaultQuery, found.defaultQuery);
        }

        return [
          alias,
          {
            ...binding,
            inheritedBaseUrl: binding.inheritedBaseUrl || inherited.baseUrl,
            auth: binding.auth || inherited.auth,
            color: binding.color || inherited.color,
            rateLimit: binding.rateLimit || inherited.rateLimit,
            // Merged over a `{}` seed whether or not a layer supplied anything, so a `!...` in the
            // flow's own defaults is *resolved* here rather than surviving into materialization,
            // where it would be stringified into a header whose value reads `Symbol(bruno.flow.drop)`.
            defaultHeaders: asRecord(merge(defaultHeaders, binding.defaultHeaders)),
            defaultQuery: asRecord(merge(defaultQuery, binding.defaultQuery))
          }
        ];
      })
    );
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
