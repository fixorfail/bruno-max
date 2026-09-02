/**
 * The engine boundary's ports — 001 §13.2.
 *
 * The engine sends no HTTP, touches no `fs`, and selects no script runtime. Each host supplies
 * these and keeps its own auth, cookie, proxy and certificate handling.
 */
import type { MaterializedRequest, ExecutedResponse } from './request';

/**
 * `unknown` rather than `string`: collection variables already hold parsed JSON, and §7.3's
 * whole-value typing rule requires a non-string to survive the chain.
 */
export type Vars = Record<string, unknown>;

export type SpecDocument = {
  text: string;
  from: 'file' | 'network' | 'cache';
};

export type FlowContext = {
  runId: string;
  /** Absolute path of the .flow.yml being executed. */
  flow: string;
  scope: { workspaceRoot: string; collectionRoot?: string };
  /** The run's signal, per §11.3. */
  signal: AbortSignal;
  /**
   * `config.redactHeaders` — the run's extension of §14.4's denylist, from the root flow, exactly
   * as the capture uses it. A host that reports a request anywhere of its own (002 §8.5) has to
   * apply the run's policy rather than a guess at it, and `createRedactor` turns this into one.
   * Absent until the flow is loaded, which is before anything is dispatched.
   */
  redactHeaders?: string[];
};

/**
 * The engine owns *which* jar a request uses (§7.6); each host owns what a jar *is*. The engine
 * mints an id per §7.6's scoping rules and never looks inside it.
 */
export type CookieJarHandle = { readonly id: string };

export type StepContext = FlowContext & {
  /** Namespaced for sub-flow internals: "auth/login". */
  stepId: string;
  /** 0-based; always present, and distinct from the interpolated `{{flow.iteration}}`. */
  iteration: number;
  /** 1-based, per §11.1. */
  attempt: number;
  cookieJar: CookieJarHandle;
  /** The step's per-attempt `timeout` (§11.1). */
  timeoutMs?: number;
  /** The attempt's signal — aborts on timeout, on maxDuration, or with the run. */
  signal: AbortSignal;
};

/**
 * Rejects when no response arrived; the engine maps a rejection to `transport-error` (§14.6).
 * An abort is never a transport error — the engine owns the signal and knows it cancelled.
 */
export type ExecuteRequest = (request: MaterializedRequest, ctx: StepContext) => Promise<ExecutedResponse>;

export type ReadFile = (path: string, ctx: FlowContext) => Promise<Buffer>;
export type WriteFile = (path: string, data: Buffer, ctx: FlowContext) => Promise<void>;
export type ListDirectory = (path: string, ctx: FlowContext) => Promise<string[]>;
/**
 * Nothing calls this today: §14.5 prunes nothing, so a run is only ever written. It stays a port
 * because clearing runs (§19) is the engine's to do — it alone knows which entries under the capture
 * root are runs and suites and which are somebody else's — and dropping it now to restore it then
 * would cost every host the change twice.
 */
export type RemoveDirectory = (path: string, ctx: FlowContext) => Promise<void>;
export type ReadSpec = (source: string, ctx: FlowContext) => Promise<SpecDocument>;
export type RunScript = (source: string, args: unknown[], ctx: FlowContext) => Promise<unknown>;

export type Clock = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

export type EnginePorts = {
  executeRequest: ExecuteRequest;
  readFile: ReadFile;
  writeFile: WriteFile;
  listDirectory: ListDirectory;
  removeDirectory: RemoveDirectory;
  readSpec: ReadSpec;
  runScript: RunScript;
  clock?: Clock;
};

/** Validation and description resolve operations and read files; they never dispatch (§13.2). */
export type ReadOnlyPorts = {
  readFile: ReadFile;
  readSpec: ReadSpec;
};
