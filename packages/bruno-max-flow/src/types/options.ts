/**
 * The entry API's options — 001 §13.2, plus 002 §11.1 and §11.2's read-only entries.
 */
import type { SuiteFlowRecord } from './capture';
import type { FlowDescription } from './describe';
import type { Vars, EnginePorts, ReadOnlyPorts, ListDirectory, ReadFile } from './ports';
import type { FlowEvent, RunResult, RunStatus, StepStatus } from './result';

export type Scope = { workspaceRoot: string; collectionRoot?: string };

/** Who started a run and against what — recorded for readers (002 §10, 001 §14.8), never consulted by the engine. */
export type RunOrigin = {
  host: 'app' | 'cli';
  /** The collection environment's name (§7.3's tier), when one was selected. Display only — its values arrive in `variables`. */
  environment?: string;
  /** The workspace (global) environment's name, when one was selected. */
  globalEnvironment?: string;
};

/**
 * Variables arrive as tiers, not as a merged map: §7.3's precedence is a flow semantic and belongs
 * to the engine, while *finding* each tier is host knowledge.
 *
 * Two of these five are not ranks in §7.3's chain, and the sixth rank has no field: runtime
 * variables (`bru.setVar`) are produced during the run, so no host can supply them up front.
 */
export type VariableTiers = {
  globalEnvironment?: Vars;
  collectionVars?: Vars;
  environment?: Vars;
  /** --env-var. Merges into `environment` and wins inside it; it does not outrank a scope (§7.3). */
  envVarOverrides?: Vars;
  /** Populates the `process.env` namespace. Not a tier — a bare {{VAR}} never reaches it (§7.3). */
  processEnv?: Vars;
};

export type RunOptions = {
  /** Path to a .flow.yml, resolved by the host. */
  entry: string;
  scope: Scope;
  ports: EnginePorts;
  variables: VariableTiers;
  /** --param, for a library flow (§12.5). */
  params?: Vars;
  /**
   * Optional only because the conformance suite calls `runFlow` directly a few hundred times and a
   * required field would say those runs came from somewhere; both real hosts always supply it.
   */
  origin?: RunOrigin;
  overrides?: {
    concurrency?: number;
    maxRunDuration?: number;
    dataset?: string;
    /**
     * --no-capture / --capture-dir (§14.5).
     *
     * `dir` means "write run directories directly here, no suite of their own" — for a host that has
     * already opened a suite for several flows (§14.8.5). With it absent the run opens a suite of
     * one under the scope's capture root, which is the default layout.
     *
     * Nothing under the capture root is ever pruned — it grows with every run and is the user's to
     * clear (§14.5).
     */
    capture?: { enabled?: boolean; dir?: string };
  };
  signal?: AbortSignal;
  onEvent?: (event: FlowEvent) => void;
};

export type ValidateOptions = {
  entry: string;
  scope: Scope;
  ports: ReadOnlyPorts;
  /** So a library flow's required-param check (§14.3) sees what a run would supply. */
  params?: Vars;
};

export type DescribeOptions = {
  entry: string;
  scope: Scope;
  ports: ReadOnlyPorts;
};

export type ListRunsOptions = {
  /** Where .bruno-runs/ lives (§14.5). */
  scopeRoot: string;
  /** Filter to one flow. */
  flow?: string;
  ports: { readFile: ReadFile; listDirectory: ListDirectory };
};

export type RunIndexEntry = {
  runId: string;
  dir: string;
  /** From run.json, so a selector can show who ran it without opening the run itself. */
  origin?: RunOrigin;
  /**
   * The §14.8.5 suite directory this run sits in, by basename — absent for a run written at the top
   * level, which is where the app puts its own.
   *
   * 002 §10's list is one list over both hosts, so a reader wanting to group an invocation's runs
   * together needs the name to group them by; the path alone would have to be parsed back out.
   */
  suite?: string;
  /** From run.json, so the filter works on unfinished runs. */
  flow: string;
  startedAt: string;
  /** Whether a run finished is a separate field from what its outcome was (002 §10). */
  state: 'complete' | 'running' | 'interrupted';
  status?: RunStatus;
  summary?: RunResult['summary'];
  /**
   * Whether the flow's text has changed since this run — 001 §14.5's `flowHash`, compared against the
   * file as it is now.
   *
   * **Three-valued on purpose.** `undefined` is *unknown*: the run predates the snapshot, or the flow
   * is no longer on disk to compare against. Collapsing that into `false` would tell a reader that
   * the oldest runs in their history match a file nobody can prove they match.
   */
  flowChanged?: boolean;
};

export type ReadRunOptions = {
  /** A run directory, as `listRuns` reports it. */
  dir: string;
  /** The ids to ask about — §14.5's directory name cannot be inverted back to one. */
  stepIds?: string[];
  /** Which iteration's captures to look under, for a `dataset:` flow (§14.5). */
  iteration?: number;
  ports: { readFile: ReadFile; listDirectory: ListDirectory };
};

/**
 * 002 §11.2's index/detail split: `listRuns` answers which runs exist, this answers what one did.
 * `capturedSteps` is what makes an interrupted run render — with no `summary.json` the only evidence
 * of what happened is which step directories exist.
 */
export type StoredRun = RunIndexEntry & {
  result?: RunResult;
  capturedSteps: string[];
  /**
   * The flow as it was when this run started (001 §14.5), when the run recorded one.
   *
   * A viewer draws *this* rather than the flow's current graph: painting a run's outcomes onto
   * today's nodes drops a step that has since been renamed, invents a never-started node for one
   * added since, and draws edges the run never had (002 §10).
   */
  description?: FlowDescription;
  /** The flow's own text at run time — the diff against what it says now. */
  source?: string;
  /**
   * §12.5's params this run was started with, secrets already masked (001 §14.4). Absent for a run
   * recorded before they were, which is *unknown* rather than "none were supplied" — 002 §5.6 says
   * so rather than drawing an empty set.
   */
  params?: Record<string, unknown>;
  /**
   * §7.3's `vars:` as each iteration resolved them, keyed by iteration index the way the step
   * captures are — under a dataset every row resolves its own set. Absent for a run recorded before
   * them, and for one that was interrupted before `finish` wrote them.
   */
  vars?: Record<number, Record<string, unknown>>;
};

export type ReadCaptureOptions = {
  dir: string;
  stepId: string;
  iteration?: number;
  attempt: number;
  ports: { readFile: ReadFile };
};

export type ListSuitesOptions = {
  /** Where .bruno-runs/ lives (§14.5), and the root §5.2 measures a flow's identity from. */
  scopeRoot: string;
  ports: { readFile: ReadFile; listDirectory: ListDirectory };
};

export type ReadSuiteOptions = {
  /** A suite directory, as `listSuites` reports it — or one a user named on the command line. */
  dir: string;
  /**
   * The scope that owns the flows, which is not derivable from `dir`: `--capture-dir` can put a
   * suite anywhere, and §5.2's identity is measured from the scope root either way.
   */
  scopeRoot: string;
  ports: { readFile: ReadFile; listDirectory: ListDirectory };
};

/**
 * A suite as a reader finds it — `SuiteManifest` with the three fields a rebuilt roster cannot
 * know made optional, plus where it lives and whether it is the whole story.
 *
 * `readSuite` returns this rather than a `SuiteManifest` for that reason: a suite with no manifest
 * is an ordinary state (every single-flow run mints one, §14.5), and a reader that had to promise a
 * `suiteId` and an `exitCode` for it would have to invent them.
 */
export type SuiteIndexEntry = {
  /** Absolute, the way `listRuns` reports a run's. */
  dir: string;
  suiteId?: string;
  startedAt: string;
  finishedAt?: string;
  /** §14.2's code the invocation exited with. */
  exitCode?: number;
  origin?: RunOrigin;
  /** Basename of the suite this one re-ran, when `--retry-failed` produced it. */
  retryOf?: string;
  flows: SuiteFlowRecord[];
  /**
   * The roster was rebuilt from run directories, so flows that never ran are missing from it — a
   * flow that failed validation opens no directory to be found. Said out loud rather than left to
   * be discovered, because the difference is invisible in the list itself.
   */
  partial?: boolean;
};

export type { RunStatus, StepStatus };
