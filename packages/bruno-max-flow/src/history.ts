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
  RUN_DIRECTORY,
  attemptFile,
  flowDigest,
  stepCaptureDir
} from './capture';
import type { RunManifest, StepCapture } from './types/capture';
import type { FlowDescription } from './types/describe';
import type {
  ListRunsOptions,
  ReadCaptureOptions,
  ReadRunOptions,
  RunIndexEntry,
  StoredRun
} from './types/options';
import type { FlowContext, ReadFile } from './types/ports';
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

/** Windows paths are case-insensitive, so a filter that compared them exactly would miss on it. */
const samePath = (left: string, right: string): boolean => {
  const [a, b] = [path.resolve(left), path.resolve(right)];
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

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

  const runs = await Promise.all(
    entries
      .filter((entry) => RUN_DIRECTORY.test(entry))
      .map(async (entry): Promise<RunIndexEntry | undefined> => {
        const dir = path.join(root, entry);
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
            flow: manifest.flow,
            startedAt: manifest.startedAt,
            state: active.has(manifest.runId) ? 'running' : 'interrupted',
            flowChanged: changedSince(manifest)
          };
        }

        return {
          runId: manifest.runId,
          dir,
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
    flow: manifest.flow,
    startedAt: manifest.startedAt,
    state: result ? 'complete' : active.has(manifest.runId) ? 'running' : 'interrupted',
    status: result?.status,
    summary: result?.summary,
    result,
    capturedSteps: captured.filter((stepId): stepId is string => stepId !== undefined),
    description,
    source
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
