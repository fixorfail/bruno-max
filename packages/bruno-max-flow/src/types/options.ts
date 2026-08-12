/**
 * The entry API's options — 001 §13.2, plus 002 §11.1 and §11.2's read-only entries.
 */
import type { Vars, EnginePorts, ReadOnlyPorts, ListDirectory, ReadFile } from './ports';
import type { FlowEvent, RunResult, RunStatus, StepStatus } from './result';

export type Scope = { workspaceRoot: string; collectionRoot?: string };

/**
 * Variables arrive as tiers, not as a merged map: §7.3's precedence is a flow semantic and belongs
 * to the engine, while *finding* each tier is host knowledge.
 *
 * NOTE: where `processEnv` and `envVarOverrides` sit in §7.3's chain is an open question (§18).
 */
export type VariableTiers = {
  globalEnvironment?: Vars;
  collectionVars?: Vars;
  environment?: Vars;
  processEnv?: Vars;
  /** --env-var */
  envVarOverrides?: Vars;
};

export type RunOptions = {
  /** Path to a .flow.yml, resolved by the host. */
  entry: string;
  scope: Scope;
  ports: EnginePorts;
  variables: VariableTiers;
  /** --param, for a library flow (§12.5). */
  params?: Vars;
  overrides?: {
    concurrency?: number;
    maxRunDuration?: number;
    dataset?: string;
    /** --no-capture / --capture-dir (§14.5). */
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
  /** From run.json, so the filter works on unfinished runs. */
  flow: string;
  startedAt: string;
  /** Whether a run finished is a separate field from what its outcome was (002 §10). */
  state: 'complete' | 'running' | 'interrupted';
  status?: RunStatus;
  summary?: RunResult['summary'];
};

export type ReadCaptureOptions = {
  dir: string;
  stepId: string;
  iteration?: number;
  attempt: number;
  ports: { readFile: ReadFile };
};

export type { RunStatus, StepStatus };
