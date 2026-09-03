/**
 * Reading runs back — 002 §11.2, over the layout 001 §14.5 declares.
 *
 * These are the other side of `capture.ts` and deliberately share its path computation rather than
 * re-deriving it: the reason the layout is a contract at all is that one writer and one reader agree
 * on it, and a reader with its own idea of where an attempt lives would drift the first time the
 * layout gained a level (001 §13.2).
 *
 * Neither entry dispatches, and both are as tolerant as 002 §10 requires: a capture root that does
 * not exist yet is an empty list, and a run directory with no `summary.json` is an interrupted run
 * rather than a corrupt one.
 */
import * as path from 'path';

import {
  ATTEMPT_FILE,
  CAPTURE_DIRNAME,
  FLOW_DESCRIPTION_FILE,
  FLOW_SOURCE_FILE,
  RUN_INPUTS_FILE,
  RUN_DIRECTORY,
  SUITE_DIRECTORY,
  SUITE_MANIFEST_FILE,
  attemptFile,
  flowDigest,
  stepCaptureDir
} from './capture';
// §5.2's identity, from the engine's one spelling of it: a rebuilt roster has to name its flows
// exactly as the roster it stands in for would have, or a rerun matches none of them.
import { flowIdentity } from './meta';
import type { RunManifest, StepCapture, SuiteFlowRecord, SuiteManifest } from './types/capture';
import type { FlowDescription } from './types/describe';
import type {
  ListRunsOptions,
  ListSuitesOptions,
  ReadCaptureOptions,
  ReadRunOptions,
  ReadSuiteOptions,
  RunIndexEntry,
  StoredRun,
  SuiteIndexEntry
} from './types/options';
import type { FlowContext, ListDirectory, ReadFile } from './types/ports';
import type { RunResult } from './types/result';

/**
 * The runs this process is executing. 002 §11.2's `state` separates a run still going from one that
 * died, and the two look identical on disk — `run.json` with no `summary.json` — so the only thing
 * that can tell them apart is the engine knowing which runs it owns (002 §10).
 *
 * That knowledge is per-process: a run the CLI is executing in another process reads as
 * `interrupted` to the app, which is the honest answer from where the app is standing.
 */
const active = new Set<string>();

export const markRunActive = (runId: string): void => {
  active.add(runId);
};

export const markRunFinished = (runId: string): void => {
  active.delete(runId);
};

/** The readers take no `signal` and no `runId`; the ports want a context, so this is the minimum. */
const readContext = (root: string): FlowContext => ({
  runId: '',
  flow: '',
  scope: { workspaceRoot: root },
  signal: new AbortController().signal
});

/** §14.5's snapshot keeps the flow's text as text; a run written before snapshots simply has none. */
const readText = async (readFile: ReadFile, file: string, context: FlowContext): Promise<string | undefined> => {
  try {
    return (await readFile(file, context)).toString('utf8');
  } catch {
    return undefined;
  }
};

const readJson = async <T>(readFile: ReadFile, file: string, context: FlowContext): Promise<T | undefined> => {
  try {
    return JSON.parse((await readFile(file, context)).toString('utf8')) as T;
  } catch {
    // Absent and unparseable are the same answer here: the caller has a defined behaviour for a
    // file that is not there, and a half-written one from a killed process is not different enough
    // to be worth a second path.
    return undefined;
  }
};

/** Windows paths are case-insensitive, so a comparison or a lookup that was exact would miss on it. */
const pathKey = (target: string): string => {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const samePath = (left: string, right: string): boolean => pathKey(left) === pathKey(right);

/**
 * The digest of the flow as it is *now*, read once for the whole listing rather than per run.
 *
 * Undefined when there is no single flow to compare against, or when it is no longer on disk — both
 * of which leave every entry's `flowChanged` unknown rather than false.
 */
const currentFlowDigest = async (options: ListRunsOptions, context: FlowContext): Promise<string | undefined> => {
  if (!options.flow) {
    return undefined;
  }

  try {
    return flowDigest((await options.ports.readFile(options.flow, context)).toString('utf8'));
  } catch {
    return undefined;
  }
};

export const listRuns = async (options: ListRunsOptions): Promise<RunIndexEntry[]> => {
  const root = path.join(options.scopeRoot, CAPTURE_DIRNAME);
  const context = readContext(options.scopeRoot);

  let entries: string[];
  try {
    entries = await options.ports.listDirectory(root, context);
  } catch {
    return [];
  }

  const current = await currentFlowDigest(options, context);
  // Both sides have to exist for the comparison to mean anything: a run with no recorded hash
  // predates the snapshot, and a flow that cannot be read has nothing to be compared with.
  const changedSince = (manifest: RunManifest): boolean | undefined =>
    current === undefined || manifest.flowHash === undefined ? undefined : manifest.flowHash !== current;

  /**
   * Every run lives in a suite directory now (§14.5): one of its own when it ran alone, or the
   * invocation's when a host was batching flows into it (§14.8.5). Top-level run directories are
   * runs written before that was true, still listed so a history does not lose them.
   *
   * One level down and no further: nothing nests below a run, so a deeper walk would be searching a
   * tree the layout does not have.
   */
  const candidates: { dir: string; suite?: string }[] = entries
    .filter((entry) => RUN_DIRECTORY.test(entry))
    .map((entry) => ({ dir: path.join(root, entry) }));

  for (const suite of entries.filter((entry) => SUITE_DIRECTORY.test(entry))) {
    let nested: string[];
    try {
      nested = await options.ports.listDirectory(path.join(root, suite), context);
    } catch {
      continue;
    }
    for (const entry of nested.filter((child) => RUN_DIRECTORY.test(child))) {
      candidates.push({ dir: path.join(root, suite, entry), suite });
    }
  }

  const runs = await Promise.all(
    candidates
      .map(async ({ dir, suite }): Promise<RunIndexEntry | undefined> => {
        const manifest = await readJson<RunManifest>(options.ports.readFile, path.join(dir, 'run.json'), context);
        // A directory that cannot be attributed to a flow is not a run: §14.5 writes run.json before
        // anything else, so its absence means this is not one of ours.
        if (!manifest) return undefined;
        if (options.flow && !samePath(manifest.flow, options.flow)) return undefined;

        const summary = await readJson<RunResult>(options.ports.readFile, path.join(dir, 'summary.json'), context);
        if (!summary) {
          return {
            runId: manifest.runId,
            dir,
            ...(manifest.origin ? { origin: manifest.origin } : {}),
            ...(suite === undefined ? {} : { suite }),
            flow: manifest.flow,
            startedAt: manifest.startedAt,
            state: active.has(manifest.runId) ? 'running' : 'interrupted',
            flowChanged: changedSince(manifest)
          };
        }

        return {
          runId: manifest.runId,
          dir,
          ...(manifest.origin ? { origin: manifest.origin } : {}),
          ...(suite === undefined ? {} : { suite }),
          flow: manifest.flow,
          startedAt: manifest.startedAt,
          state: 'complete',
          status: summary.status,
          summary: summary.summary,
          flowChanged: changedSince(manifest)
        };
      })
  );

  // Newest first (002 §10), by `startedAt` rather than by directory name: the name carries a
  // truncated timestamp, so two runs inside the same second would order by their id suffix.
  return runs
    .filter((entry): entry is RunIndexEntry => entry !== undefined)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
};

/**
 * 002 §11.2. The detail half of the index/detail split — every step's outcome for one run, which is
 * what §10 needs to open a past run into the same view a live one uses.
 *
 * **`stepIds` is an input because the directory name is a lossy encoding of the step id.** §14.5's
 * segment replaces `/` with `__`, suffixes a reserved device name and truncates a long id to a hash,
 * so a name cannot be inverted — `child__use` is `child/use` or a step literally called `child__use`,
 * and nothing on disk distinguishes them. The caller already knows the ids it is asking about (the
 * graph `describeFlow` returned), so the answerable question is which of *those* have a capture, and
 * the mapping stays in the engine where §14.5 puts every path computation.
 *
 * **The snapshot supersedes that input when the run has one.** §14.5's `flow.json` holds the graph
 * this run executed, so its node ids are the ids that could have captures — and they are the right
 * ones to ask about, because the caller's list is today's graph and a step renamed since would leave
 * its captures unreachable. `stepIds` remains the fallback for runs written before snapshots.
 */
export const readRun = async (options: ReadRunOptions): Promise<StoredRun> => {
  const context = readContext(options.dir);
  const manifest = await readJson<RunManifest>(options.ports.readFile, path.join(options.dir, 'run.json'), context);
  if (!manifest) {
    throw new Error(`${options.dir} is not a run directory: no run.json`);
  }

  const result = await readJson<RunResult>(options.ports.readFile, path.join(options.dir, 'summary.json'), context);
  const description = await readJson<FlowDescription>(
    options.ports.readFile,
    path.join(options.dir, FLOW_DESCRIPTION_FILE),
    context
  );
  const source = await readText(options.ports.readFile, path.join(options.dir, FLOW_SOURCE_FILE), context);
  // Absent for a run recorded before inputs were, which 002 §5.6 reports as unknown rather than as
  // a run that was started with nothing.
  const inputs = await readJson<{ params: Record<string, unknown>; vars?: Record<number, Record<string, unknown>> }>(
    options.ports.readFile,
    path.join(options.dir, RUN_INPUTS_FILE),
    context
  );

  const stepIds = description ? description.nodes.map((node) => node.id) : options.stepIds || [];
  const captured = await Promise.all(
    stepIds.map(async (stepId) => {
      try {
        const entries = await options.ports.listDirectory(
          stepCaptureDir(options.dir, stepId, options.iteration),
          context
        );
        return entries.some((entry) => ATTEMPT_FILE.test(entry)) ? stepId : undefined;
      } catch {
        return undefined;
      }
    })
  );

  return {
    runId: manifest.runId,
    dir: options.dir,
    ...(manifest.origin ? { origin: manifest.origin } : {}),
    flow: manifest.flow,
    startedAt: manifest.startedAt,
    state: result ? 'complete' : active.has(manifest.runId) ? 'running' : 'interrupted',
    status: result?.status,
    summary: result?.summary,
    result,
    capturedSteps: captured.filter((stepId): stepId is string => stepId !== undefined),
    description,
    source,
    params: inputs?.params,
    vars: inputs?.vars
  };
};

export const readCapture = async (options: ReadCaptureOptions): Promise<StepCapture> => {
  const file = path.join(
    stepCaptureDir(options.dir, options.stepId, options.iteration),
    attemptFile(options.attempt)
  );
  const capture = await readJson<StepCapture>(options.ports.readFile, file, readContext(options.dir));

  // Unlike `listRuns`, a missing capture is a caller error rather than a state: the app asks for an
  // attempt it saw in a summary or a directory listing, so nothing there means the two disagree.
  if (!capture) throw new Error(`no capture for ${options.stepId} attempt ${options.attempt} in ${options.dir}`);
  return capture;
};

/**
 * Reading an invocation back — 001 §14.5's `suite.json` over §14.8.5's suite directory.
 *
 * The index/detail split `listRuns` and `readRun` have, one level up: `listSuites` answers which
 * invocations exist and what each of them selected, `readSuite` answers that for one named
 * directory. Both are the same read, because a listing that reported a suite differently from the
 * reader that opens it would be the drift §13.2 keeps the layout in one place to prevent.
 */

type SuitePorts = { readFile: ReadFile; listDirectory: ListDirectory };

/** One run directory, read for the three things a roster line needs: the flow, when, and how it went. */
type ReconstructedRun = {
  runDir: string;
  manifest: RunManifest;
  /** Absent for an interrupted run (002 §10) — a run nobody recorded an outcome for. */
  summary?: RunResult;
  /** §14.5's snapshot, so a rebuilt line names the flow as the suite ran it, not as it is now. */
  source?: string;
};

/**
 * The roster of a suite with no `suite.json`, rebuilt from the run directories inside it.
 *
 * Not a legacy path: a run given no directory of its own mints a suite of one (§14.5) and writes no
 * manifest, so every single-flow run the app makes produces exactly this shape.
 *
 * What it structurally cannot recover is the reason the manifest exists at all — a flow that failed
 * validation (§14.3) never reaches `runFlow` and opens no directory, so it is absent from a listing
 * of them. `partial` says so rather than letting the result read as the whole selection.
 */
const reconstructSuite = async (
  dir: string,
  scopeRoot: string,
  ports: SuitePorts,
  context: FlowContext
): Promise<SuiteIndexEntry | undefined> => {
  let entries: string[];
  try {
    entries = await ports.listDirectory(dir, context);
  } catch {
    return undefined;
  }

  const read = await Promise.all(
    entries
      .filter((entry) => RUN_DIRECTORY.test(entry))
      .map(async (runDir): Promise<ReconstructedRun | undefined> => {
        const target = path.join(dir, runDir);
        const manifest = await readJson<RunManifest>(ports.readFile, path.join(target, 'run.json'), context);
        // Same rule as `listRuns`: §14.5 writes run.json first, so a directory without one is not a
        // run and has no flow to put in a roster.
        if (!manifest) return undefined;

        const summary = await readJson<RunResult>(ports.readFile, path.join(target, 'summary.json'), context);
        const source = await readText(ports.readFile, path.join(target, FLOW_SOURCE_FILE), context);
        return {
          runDir,
          manifest,
          ...(summary ? { summary } : {}),
          ...(source ? { source } : {})
        };
      })
  );

  const runs = read
    .filter((run): run is ReconstructedRun => run !== undefined)
    // Run order, as closely as run directories can report it: the roster of a suite that has a
    // manifest is in path order (§14.1), and start order is what actually happened here.
    .sort((left, right) => left.manifest.startedAt.localeCompare(right.manifest.startedAt));

  // Nothing in here is attributable to a flow, so nothing dates the suite either. The directory
  // name carries a timestamp, but reading one back would be a second, lossy spelling of §14.5's
  // naming — it has no sub-second part — and would date a directory holding no evidence it ran.
  if (!runs.length) return undefined;

  const flows = new Map<string, SuiteFlowRecord>();
  for (const run of runs) {
    // An interrupted run has no outcome anybody recorded (002 §10). Left out rather than called
    // `cancelled`: a rerun would then be re-running a flow on the strength of a guess, and a
    // reader would be told the suite reached a conclusion it never reached.
    if (!run.summary) continue;
    // One line per flow, the last attempt winning — §14.8's rule that the final attempt is the
    // outcome, applied to what an interrupted `--retries` invocation leaves in a suite. Re-`set`
    // keeps the flow at the position of its first run, which is where the roster would have it.
    flows.set(pathKey(run.manifest.flow), {
      ...flowIdentity(scopeRoot, run.manifest.flow, run.source),
      outcome: run.summary.status,
      runDir: run.runDir
    });
  }

  return {
    dir,
    startedAt: runs[0].manifest.startedAt,
    // Every run in a suite came from the one invocation, so the first one's `origin` is the suite's
    // — and without it the app's own single-flow suites would be unattributable in a list where the
    // runs inside them each say exactly who started them.
    ...(runs[0].manifest.origin ? { origin: runs[0].manifest.origin } : {}),
    flows: [...flows.values()],
    partial: true
  };
};

const suiteAt = async (
  dir: string,
  scopeRoot: string,
  ports: SuitePorts,
  context: FlowContext
): Promise<SuiteIndexEntry | undefined> => {
  const manifest = await readJson<SuiteManifest>(ports.readFile, path.join(dir, SUITE_MANIFEST_FILE), context);
  // Absent, unparseable and parsing to something that is not a roster are one answer, for
  // `readJson`'s reason: a half-written file from a killed process is not different enough from a
  // missing one to be worth trusting halfway, and the run directories are still there to rebuild from.
  if (manifest && Array.isArray(manifest.flows)) {
    return { dir, ...manifest };
  }
  return reconstructSuite(dir, scopeRoot, ports, context);
};

/**
 * Which invocations have run in this scope, newest first.
 *
 * By `startedAt` rather than by directory name, for `listRuns`'s reason: the name carries a
 * truncated timestamp, so two suites started in the same second would order by their id suffix. A
 * capture root that does not exist yet is an empty list, again matching `listRuns` — a scope nobody
 * has run anything in is the ordinary state, not an error.
 */
export const listSuites = async (options: ListSuitesOptions): Promise<SuiteIndexEntry[]> => {
  const root = path.join(options.scopeRoot, CAPTURE_DIRNAME);
  const context = readContext(options.scopeRoot);

  let entries: string[];
  try {
    entries = await options.ports.listDirectory(root, context);
  } catch {
    return [];
  }

  const suites = await Promise.all(
    entries
      .filter((entry) => SUITE_DIRECTORY.test(entry))
      .map((entry) => suiteAt(path.join(root, entry), options.scopeRoot, options.ports, context))
  );

  return suites
    .filter((suite): suite is SuiteIndexEntry => suite !== undefined)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
};

/**
 * One suite by directory — what a user naming a suite to re-run gets.
 *
 * Throws for a directory that is not one, the way `readRun` does and for the same reason: a caller
 * asking about a specific directory has named something, and answering with an empty roster would
 * report a mistyped path as an invocation that ran nothing.
 */
export const readSuite = async (options: ReadSuiteOptions): Promise<SuiteIndexEntry> => {
  const suite = await suiteAt(
    options.dir,
    options.scopeRoot,
    options.ports,
    readContext(options.scopeRoot)
  );

  if (!suite) {
    throw new Error(`${options.dir} is not a suite directory: no ${SUITE_MANIFEST_FILE} and no runs to rebuild one from`);
  }
  return suite;
};
