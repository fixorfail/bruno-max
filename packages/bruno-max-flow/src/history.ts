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

import { CAPTURE_DIRNAME, RUN_DIRECTORY, attemptFile, stepCaptureDir } from './capture';
import type { RunManifest, StepCapture } from './types/capture';
import type { ListRunsOptions, ReadCaptureOptions, RunIndexEntry } from './types/options';
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

export const listRuns = async (options: ListRunsOptions): Promise<RunIndexEntry[]> => {
  const root = path.join(options.scopeRoot, CAPTURE_DIRNAME);
  const context = readContext(options.scopeRoot);

  let entries: string[];
  try {
    entries = await options.ports.listDirectory(root, context);
  } catch {
    return [];
  }

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
            state: active.has(manifest.runId) ? 'running' : 'interrupted'
          };
        }

        return {
          runId: manifest.runId,
          dir,
          flow: manifest.flow,
          startedAt: manifest.startedAt,
          state: 'complete',
          status: summary.status,
          summary: summary.summary
        };
      })
  );

  // Newest first (002 §10), by `startedAt` rather than by directory name: the name carries a
  // truncated timestamp, so two runs inside the same second would order by their id suffix.
  return runs
    .filter((entry): entry is RunIndexEntry => entry !== undefined)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
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
