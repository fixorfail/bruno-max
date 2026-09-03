/**
 * The capture directory — 001 §14.5.
 *
 * The engine owns the layout: it computes every path, decides what a run directory contains, and
 * applies retention. A host supplies `WriteFile`, `ListDirectory` and `RemoveDirectory` and nothing
 * more (§13.2). That division is what lets `readCapture` (002 §11.2) read back what either host
 * produced — a host-side writer would put one declared layout in two implementations and let the
 * CLI and the app produce directories neither can fully read.
 *
 * Redaction (§14.4) is applied on the way in, never after: §14.5 requires that a secret is not
 * written into a file buffer and then removed from it.
 */
import * as path from 'path';
import { createHash } from 'crypto';

import { createRedactor, type Redactor } from './redact';
import type {
  CapturedBody,
  CapturedPart,
  CapturedRequest,
  CapturedResponse,
  FlowSnapshot,
  RunManifest,
  StepCapture,
  SuiteManifest
} from './types/capture';
import type { RunOrigin, Scope } from './types/options';
import type { EnginePorts, FlowContext } from './types/ports';
import type { ExecutedResponse, MaterializedRequest, RequestBody } from './types/request';
import type { AssertionResult, RunResult, StepResult } from './types/result';

/**
 * The layout's own names, exported because `history.ts` reads back what this module writes and a
 * reader that recomputed either half would be the second implementation §13.2 exists to prevent.
 */
export const CAPTURE_DIRNAME = '.bruno-runs';

export const RUN_DIRECTORY = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{4}$/;

/**
 * A CLI invocation's report directory (§14.8.5), which shares the capture root with the runs but is
 * not one of them.
 *
 * The `suite-` prefix is the whole of what keeps the two apart: `RUN_DIRECTORY` is anchored on a
 * digit, so no suite directory can ever match it — which is what makes `listRuns` skip these and
 * `prune` refuse to delete them. A suite directory belongs to the CLI; the engine only names it.
 */
export const SUITE_DIRECTORY = /^suite-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{4}$/;

/**
 * The roster of the invocation that owns a suite directory (§14.5) — named here, beside the
 * directory it sits in, so `history.ts` reads back the file this module's format describes.
 */
export const SUITE_MANIFEST_FILE = 'suite.json';

/** §14.5's snapshot of the flow the run executed — the graph a viewer draws, and the text it came from. */
export const FLOW_DESCRIPTION_FILE = 'flow.json';
export const FLOW_SOURCE_FILE = 'flow.yml';
/** §12.5's params the run was started with, secrets already masked — 002 §5.6's inputs node. */
export const RUN_INPUTS_FILE = 'inputs.json';

/**
 * What `run.json` records so a reader can tell a run apart from the flow's current text without
 * reading either. Content rather than mtime: a file restored from a backup, or checked out again,
 * is the same flow.
 */
export const flowDigest = (source: string): string => createHash('sha256').update(source).digest('hex');

/** An ISO instant as a directory name: no colons, and no sub-second part to make one run unfindable. */
const pathSafeTimestamp = (startedAt: string): string => startedAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');

/** `2026-08-05T14-22-01Z-a3f9` — the start time made path-safe, plus the runId's first four hex. */
const runDirectoryName = (startedAt: string, runId: string): string =>
  `${pathSafeTimestamp(startedAt)}-${runId.replace(/-/g, '').slice(0, 4)}`;

/** An id may legally spell one of these (§5.2's charset allows it) and Windows would refuse it. */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_SEGMENT = 64;

/**
 * §14.5: one flat directory per step id. A sub-flow's `auth/login` becomes `auth__login` so a run
 * directory lists as the ids it holds rather than having to be walked.
 */
const stepSegment = (stepId: string): string => {
  const flat = stepId.replace(/\//g, '__');
  const safe = RESERVED_DEVICE.test(flat) ? `${flat}_` : flat;
  if (safe.length <= MAX_SEGMENT) return safe;
  return `${safe.slice(0, MAX_SEGMENT - 8)}-${createHash('sha1').update(stepId).digest('hex').slice(0, 7)}`;
};

/** `iteration` is absent for a flow with no `dataset:`, which nests nothing (§14.5). */
export const stepCaptureDir = (runDir: string, stepId: string, iteration?: number): string =>
  path.join(runDir, ...(iteration === undefined ? [] : [`iteration-${iteration}`]), stepSegment(stepId));

export const attemptFile = (attempt: number): string => `attempt-${attempt}.json`;

/** The reader's half of the name above — 002 §11.2's `capturedSteps` finds a step by its presence. */
export const ATTEMPT_FILE = /^attempt-\d+\.json$/;

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/json': '.json',
  'application/xml': '.xml',
  'application/zip': '.zip',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'image/png': '.png',
  'image/jpeg': '.jpg'
};

const extensionFor = (contentType?: string): string =>
  EXTENSIONS[String(contentType).split(';')[0].trim().toLowerCase()] || '.bin';

const headerValue = (headers: Record<string, string | string[]>, name: string): string | undefined => {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found === undefined ? undefined : String(Array.isArray(found[1]) ? found[1][0] : found[1]);
};

const capturedPart = (part: { name: string } & Record<string, any>): CapturedPart =>
  part.kind === 'field'
    ? { name: part.name, kind: 'field', value: part.value, contentType: part.contentType }
    : {
        name: part.name,
        kind: 'file',
        sourcePath: part.file.sourcePath,
        filename: part.file.filename,
        contentType: part.file.contentType,
        byteLength: part.file.bytes.length
      };

/**
 * A request's binary body is always a file source (§7.5), so it is captured by reference for the
 * same reason a multipart file part is: the content is already in the repository, and copying it in
 * would put the fixture corpus into every run's artifact (§14.5).
 */
const capturedRequestBody = (body: RequestBody): CapturedBody | undefined => {
  switch (body.kind) {
    case 'none':
      return undefined;
    case 'json':
      return { kind: 'text', contentType: 'application/json', text: JSON.stringify(body.value) };
    case 'text':
      return { kind: 'text', contentType: body.contentType, text: body.value };
    case 'urlencoded':
      return {
        kind: 'text',
        contentType: 'application/x-www-form-urlencoded',
        text: new URLSearchParams(body.fields.map((field) => [field.name, field.value])).toString()
      };
    case 'multipart':
      return { kind: 'multipart', parts: body.parts.map(capturedPart) };
    case 'binary':
      return {
        kind: 'upload',
        sourcePath: body.file.sourcePath,
        filename: body.file.filename,
        contentType: body.file.contentType,
        byteLength: body.file.bytes.length
      };
  }
};

/**
 * `sentHeaders` is what the host reports having actually written (§13.2's `requestHeaders`), and it
 * wins: a capture of "the request" that omitted the content type and the auth header the host added
 * is a record of something that was never sent. Redaction applies either way — §14.4 governs the
 * artifact, not the provenance of what goes into it.
 */
const capturedRequest = (
  request: MaterializedRequest,
  redactor: Redactor,
  sentHeaders?: Record<string, string>
): CapturedRequest => {
  const query = new URLSearchParams(request.query.map((entry) => [entry.name, entry.value])).toString();
  return {
    method: request.method,
    url: query ? `${request.url}?${query}` : request.url,
    headers: redactor.headers(sentHeaders || request.headers),
    body: capturedRequestBody(request.body)
  };
};

type Artifact = (bytes: Buffer, contentType: string | undefined, role: 'request' | 'response') => string;

const capturedResponse = (
  response: ExecutedResponse,
  redactor: Redactor,
  artifact: Artifact
): CapturedResponse => {
  const contentType = headerValue(response.headers, 'content-type');
  const textual = !contentType || TEXTUAL.test(contentType);

  let body: CapturedBody | undefined;
  if (!textual && response.bytes) {
    body = {
      kind: 'binary',
      contentType,
      byteLength: response.bytes.length,
      file: artifact(response.bytes, contentType, 'response')
    };
  } else if (response.bytes) {
    body = { kind: 'text', contentType, text: response.bytes.toString('utf8') };
  } else if (response.body !== undefined && response.body !== null) {
    // No raw bytes means the host handed back a parsed value only; re-serializing is the closest
    // record available, and §14.5 would rather store that than drop the body.
    body = {
      kind: 'text',
      contentType,
      text: typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
    };
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: redactor.headers(response.headers),
    body,
    responseTimeMs: response.responseTimeMs
  };
};

export type AttemptRecord = {
  stepId: string;
  /** Nests the capture only when the flow has a dataset (§14.5). */
  iteration?: number;
  attempt: number;
  startedAt: string;
  durationMs: number;
  request?: MaterializedRequest;
  response?: ExecutedResponse;
  assertions: AssertionResult[];
  validation?: StepResult['validation'];
};

export type Capture = {
  /** Where the run's directory lives, for `RunResult.captureDir`. */
  readonly dir: string;
  /**
   * Prunes to retention, writes `run.json` and — when the flow could be described — the snapshot
   * beside it, and ignores the capture root on first creation.
   */
  start(snapshot?: FlowSnapshot): Promise<void>;
  /**
   * §7.3's `vars:` as *this* iteration resolved them — 002 §5.6's inputs node, for a run being read
   * back.
   *
   * Handed in rather than re-derived, because re-resolving would not reproduce them: `{{$guid}}`
   * generates a fresh value on every evaluation, so a second pass would record an id no step ever
   * used. Accumulated here and written by `finish`, since the values do not exist until the run is
   * under way and an iteration is the unit that has one set of them.
   */
  vars(iteration: number, values: Record<string, unknown>): void;
  /** Returns the step's directory, for `StepResult.capturePath`. */
  attempt(record: AttemptRecord): Promise<string>;
  finish(result: RunResult): Promise<void>;
};

/** §7.4's boundary: the collection or workspace root that owns the flows, and the capture with them. */
const scopeRootOf = (scope: Scope): string => scope.collectionRoot || scope.workspaceRoot;

/**
 * The ports want a context, and the helpers below run outside any run — the same minimum
 * `history.ts` builds for the readers.
 */
const hostContext = (scope: Scope): FlowContext => ({
  runId: '',
  flow: '',
  scope,
  signal: new AbortController().signal
});

/**
 * Where a run's artifacts go — `--capture-dir` when a host set one, and §14.5's default beneath the
 * scope root otherwise.
 */
export const resolveCaptureRoot = (scope: Scope, dir?: string): string =>
  dir || path.join(scopeRootOf(scope), CAPTURE_DIRNAME);

/**
 * `<captureRoot>/suite-2026-08-05T14-22-01Z-a3f9` — where one `bru flow run` invocation puts the
 * report files it was asked for (§14.8.5).
 *
 * Named here rather than by the CLI because the naming is §14.5's, down to the path-safe timestamp
 * a run directory uses: a second spelling of it would be a second layout, and this one shares a
 * directory with the runs. `SUITE_DIRECTORY` says why the prefix matters.
 */
export const resolveSuiteDirectory = (captureRoot: string, startedAt: string, suiteId: string): string =>
  path.join(captureRoot, `suite-${pathSafeTimestamp(startedAt)}-${suiteId.slice(0, 4)}`);

/** Every JSON file under the capture root looks the same on disk: two-space, one trailing newline. */
const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/**
 * §14.5's `suite.json`, into the suite directory the host opened.
 *
 * **A host's call, not the engine's.** The engine runs one flow and never sees the invocation
 * around it (§13.2), while the roster is precisely a fact about the invocation — which flows were
 * selected, including the ones that never ran. So the CLI writes its own and the app's suite runner
 * writes its own, and what lives here is the *format*: two hosts spelling a roster separately would
 * produce two `listSuites` has to tell apart.
 *
 * Written through the ports like everything else this module writes — the engine touches no `fs`.
 */
export const writeSuiteManifest = async ({
  dir,
  manifest,
  ports,
  context
}: {
  dir: string;
  manifest: SuiteManifest;
  ports: Pick<EnginePorts, 'writeFile'>;
  context: FlowContext;
}): Promise<void> => {
  await ports.writeFile(path.join(dir, SUITE_MANIFEST_FILE), jsonBytes(manifest), context);
};

/**
 * §14.5's on-creation write, as a step a host can take on its own.
 *
 * Skipped when `dir` relocated the output, since the entry names the default location — and written
 * at most once, because an author who deleted the line meant to.
 */
export const ensureCaptureIgnored = async ({
  scope,
  dir,
  ports
}: {
  scope: Scope;
  dir?: string;
  ports: Pick<EnginePorts, 'readFile' | 'writeFile'>;
}): Promise<void> => {
  if (dir) return;

  const context = hostContext(scope);
  const file = path.join(scopeRootOf(scope), '.gitignore');
  let existing = '';
  try {
    existing = (await ports.readFile(file, context)).toString('utf8');
  } catch {
    /* no .gitignore yet — the write below creates one */
  }

  const entry = `${CAPTURE_DIRNAME}/`;
  if (existing.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === CAPTURE_DIRNAME)) return;

  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await ports.writeFile(file, Buffer.from(`${existing}${separator}${entry}\n`), context);
};

export type CaptureSetup = {
  ports: Pick<EnginePorts, 'readFile' | 'writeFile' | 'listDirectory'>;
  context: FlowContext;
  /**
   * Write run directories directly here, with no suite of their own — for a host that has already
   * opened a suite for several flows (§14.8.5). `--capture-dir` supplies it too, which is the same
   * statement: the caller has decided where runs go. When absent, this run opens a suite of one
   * beneath `<scopeRoot>/.bruno-runs` (§14.5).
   */
  dir?: string;
  startedAt: string;
  /** §14.5's manifest field, copied through as the host gave it — the engine reads no part of it. */
  origin?: RunOrigin;
  redactHeaders: string[];
};

const writeJson = (
  setup: CaptureSetup,
  file: string,
  value: unknown
): Promise<void> => setup.ports.writeFile(file, jsonBytes(value), setup.context);

/**
 * Whether this is the first thing to be written under the capture root, which is the only question
 * §14.5's `.gitignore` write turns on.
 *
 * Nothing here is ever deleted: a capture directory is gitignored and grows with every run, and
 * clearing it is the user's. Silently removing runs from a directory that may be being archived is
 * a worse failure than the growth it would save.
 */
const captureRootIsNew = async (setup: CaptureSetup, root: string): Promise<boolean> => {
  try {
    return (await setup.ports.listDirectory(root, setup.context)).length === 0;
  } catch {
    // Nothing has been written here yet.
    return true;
  }
};

export const createCapture = (setup: CaptureSetup): Capture => {
  const root = resolveCaptureRoot(setup.context.scope, setup.dir);
  /**
   * A host that supplied `dir` has already opened a suite for the flows it is running (§14.8.5) and
   * writes its runs straight into it. A run on its own opens a suite of one, so every run in the
   * capture root sits at the same depth whichever host produced it.
   *
   * Minted from the run's own id, so a suite of one and the run inside it carry the same four hex —
   * `suite-…-a3f9/…-a3f9` reads as one thing rather than as two unrelated names.
   */
  const suite = setup.dir ? undefined : resolveSuiteDirectory(root, setup.startedAt, setup.context.runId);
  const dir = path.join(suite || root, runDirectoryName(setup.startedAt, setup.context.runId));
  const redactor = createRedactor(setup.redactHeaders);
  /** What `start` recorded, held so `finish` can rewrite the file with the vars beside it. */
  let startedWithParams: Record<string, unknown> | undefined;
  // Keyed by iteration the way the step directories are: under a dataset each row resolves its own
  // `vars:`, so there is no single set to record (§7.3).
  const resolvedVars: Record<number, Record<string, unknown>> = {};

  return {
    dir,

    vars: (iteration, values) => {
      resolvedVars[iteration] = values;
    },

    /**
     * The snapshot is optional because recording history must never be able to fail a run: a flow
     * that executes but cannot be described (an OpenAPI document that would not load, say) still
     * runs, and records everything else. What it loses is the ability to be read back against the
     * flow as it was, which 002 §10 reports rather than papering over.
     */
    start: async (snapshot) => {
      const created = await captureRootIsNew(setup, root);
      const manifest: RunManifest = {
        runId: setup.context.runId,
        flow: setup.context.flow,
        startedAt: setup.startedAt,
        ...(setup.origin ? { origin: setup.origin } : {}),
        flowHash: snapshot && flowDigest(snapshot.source)
      };
      await writeJson(setup, path.join(dir, 'run.json'), manifest);

      if (snapshot) {
        startedWithParams = snapshot.params;
        await Promise.all([
          writeJson(setup, path.join(dir, FLOW_DESCRIPTION_FILE), snapshot.description),
          setup.ports.writeFile(path.join(dir, FLOW_SOURCE_FILE), Buffer.from(snapshot.source, 'utf8'), setup.context),
          // Already masked by `maskedParams` — nothing is redacted after serialization here (§14.5).
          // Written now as well as at `finish` so an interrupted run still says what it was started
          // with; the vars are not resolved yet and that version simply has none.
          writeJson(setup, path.join(dir, RUN_INPUTS_FILE), { params: snapshot.params })
        ]);
      }

      if (created) {
        // A capture directory holds response data that has no business in a repository, and the
        // moment it first appears is the only moment anything knows to say so.
        await ensureCaptureIgnored({ scope: setup.context.scope, dir: setup.dir, ports: setup.ports });
      }
    },

    attempt: async (record) => {
      const target = stepCaptureDir(dir, record.stepId, record.iteration);
      // A binary body is written out as a sibling and the capture only names it, so the two writes
      // are collected here and both settle before the JSON that points at one of them lands.
      const siblings: Promise<void>[] = [];
      const artifact: Artifact = (bytes, contentType, role) => {
        const name = `attempt-${record.attempt}.${role}${extensionFor(contentType)}`;
        siblings.push(setup.ports.writeFile(path.join(target, name), bytes, setup.context));
        return name;
      };

      const capture: StepCapture = {
        stepId: record.stepId,
        iteration: record.iteration === undefined ? 0 : record.iteration,
        attempt: record.attempt,
        startedAt: record.startedAt,
        durationMs: record.durationMs,
        request: record.request && capturedRequest(record.request, redactor, record.response?.requestHeaders),
        response: record.response && capturedResponse(record.response, redactor, artifact),
        assertions: record.assertions,
        validation: record.validation
      };

      await Promise.all(siblings);
      await writeJson(setup, path.join(target, attemptFile(record.attempt)), capture);
      return target;
    },

    finish: async (result) => {
      await writeJson(setup, path.join(dir, 'summary.json'), result);
      // Rewritten rather than appended: the vars only exist once the run is under way, and the
      // version `start` wrote is the same params with nothing beside them.
      if (startedWithParams !== undefined) {
        await writeJson(setup, path.join(dir, RUN_INPUTS_FILE), { params: startedWithParams, vars: resolvedVars });
      }
    }
  };
};
