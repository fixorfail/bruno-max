/**
 * The conformance harness — 001-C §2.
 *
 * `run()` wraps the engine's entry point (001 §13.2) with the ports the scenarios need, and
 * returns the per-step outcome table, the flow status and the exit code, because that triple is
 * what every scenario asserts on. `RunResult` carries no exit code of its own — mapping an outcome
 * to 0–4 is §14.2's and belongs to a host — so the harness stands in for the CLI there.
 *
 * The ports:
 *
 * - **`executeRequest` is a stub keyed by operation id.** Responses are scripted, ordering is
 *   deterministic, and no network is involved. Every dispatch is logged with the sequence in which
 *   it started and settled, which is what F2.3 needs to see a cleanup step racing a booking.
 * - **`readFile` reads the committed fixtures**, with an in-memory overlay so a scenario can run a
 *   variant of a flow without a near-duplicate file on disk (`variant()` below).
 * - **`clock.sleep` records and returns**, so F4.3's 30-attempt poll costs no wall-clock time and
 *   the delay sequence is asserted by value rather than bounded.
 * - **`runScript` is a real bruno-js runtime.** Several scenarios turn on what a script actually
 *   returns — F4's `find` predicate, F3's derived structured output, the `shouldRetry` polls — so a
 *   stub would assert the engine calls the port and nothing about the behavior they exist to pin.
 * - **`writeFile` / `listDirectory` / `removeDirectory` are an in-memory filesystem**, so §14.5's
 *   capture layout is observable without touching disk. `files` on the report reads it back, and
 *   the same accessor reaches a response stub through `info.files` — which is how R4g2 asserts what
 *   exists *while* a run is still going. `readFile` consults it before the fixtures, so R4o's
 *   `listRuns` and `readCapture` read exactly what the run wrote.
 *
 * Generated values (`{{$randomUUID}}` and friends) are **not** stubbed: R4c asserts the relations
 * between generated values, which hold for any generator and need no seeding hook.
 *
 * **Auth is not a header here.** §13.2 hands the host a declarative `MaterializedRequest.auth` in
 * Bruno's own `Auth` shape and leaves applying it to the host, so a scenario that reads as "assert
 * the Authorization header" asserts on `call.auth` — see `bearerToken()`.
 */
const fs = require('fs');
const path = require('path');
// The node-vm sandbox directly rather than the package root: `@usebruno/js`'s index also pulls in
// the QuickJS runtime, which dynamically imports its wasm variant at load time and needs a Node
// flag Jest is not started with. Selecting a runtime is the host's job either way (§8.2).
const { runScriptInNodeVm } = require('@usebruno/js/src/sandbox/node-vm');

const engine = require('../../src');
const { load, stringify } = require('./flow-yaml');

const FIXTURES = path.join(__dirname, 'fixtures');
const FLOWS = path.join(FIXTURES, 'flows');
const SPECS = path.join(FIXTURES, 'specs');

/**
 * Every `{{...}}` the corpus reads from the environment tier. The base URLs differ per service
 * because F4.1 asserts each request went to the base URL of its own binding, which a shared host
 * would make unfalsifiable.
 */
const DEFAULT_VARS = {
  apiBaseUrl: 'https://shop.example.com',
  ordersBaseUrl: 'https://orders.example.com',
  carrierABaseUrl: 'https://carrier-a.example.com',
  carrierBBaseUrl: 'https://carrier-b.example.com',
  billingBaseUrl: 'https://billing.example.com',
  auditBaseUrl: 'https://audit.example.com',
  userBaseUrl: 'https://user.example.com',
  itemsBaseUrl: 'https://items.example.com',
  externalBaseUrl: 'https://external.example.com',
  regressBaseUrl: 'https://regress.example.com',
  testUserEmail: 'qa@example.com',
  testUserPassword: 'hunter2',
  operatorEmail: 'operator@example.com',
  carrierAApiKey: 'ak_carrier_a',
  carrierBToken: 'tok_carrier_b'
};

/** §14.2. `2` and `3` are reachable only through `validate()` and the CLI's own argument handling. */
const EXIT_CODE = { passed: 0, failed: 1, cancelled: 4 };

const flowPath = (file) => (path.isAbsolute(file) ? file : path.join(FLOWS, file));

/**
 * Method + path-template index over the fixture specs, so a dispatch is attributable to an
 * operation even if the engine leaves `MaterializedRequest.operation` off — the field is optional
 * in §13.2, and a harness that silently failed to identify a request would report every scenario
 * as an unstubbed operation.
 */
const buildOperationIndex = () => {
  const routes = [];
  for (const file of fs.readdirSync(SPECS).filter((f) => f.endsWith('.yml'))) {
    const spec = load(path.join(SPECS, file));
    for (const [template, item] of Object.entries(spec.paths || {})) {
      for (const [method, operation] of Object.entries(item)) {
        if (method === 'parameters' || !operation || !operation.operationId) continue;
        routes.push({
          method: method.toUpperCase(),
          pattern: new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}/?$`),
          operationId: operation.operationId
        });
      }
    }
  }
  return routes;
};

const OPERATIONS = buildOperationIndex();

const identify = (request) => {
  if (request.operation && request.operation.operationId) {
    return request.operation.operationId;
  }
  const { pathname } = new URL(request.url);
  const match = OPERATIONS.find((route) => route.method === request.method && route.pattern.test(pathname));
  if (!match) {
    throw new Error(`harness: no fixture operation matches ${request.method} ${request.url}`);
  }
  return match.operationId;
};

/**
 * A stub entry is a response object, a per-call sequence, or a function of the request. The
 * function form is what lets one operation answer differently per dataset row, which F1 needs for
 * an `addProduct` that is 201 for two roles and 403 for the third.
 */
const selectResponse = (entry, request, ctx, info) => {
  if (typeof entry === 'function') return entry(request, ctx, info);
  if (Array.isArray(entry)) return entry[Math.min(info.call, entry.length) - 1];
  return entry;
};

const materializeResponse = (spec) => ({
  status: spec.status === undefined ? 200 : spec.status,
  statusText: spec.statusText,
  headers: spec.headers || { 'content-type': 'application/json' },
  body: spec.body === undefined ? null : spec.body,
  // Optional, exactly as in §13.2: a host supplies raw bytes when it has them, and §14.5's binary
  // capture is only reachable through a stub that does.
  bytes: spec.bytes,
  responseTimeMs: spec.responseTimeMs === undefined ? 1 : spec.responseTimeMs,
  size: { body: 0, headers: 0 }
});

const createPorts = (options) => {
  const overlay = new Map(Object.entries(options.files || {}));
  const controller = new AbortController();
  const log = { calls: [], scripts: [], sleeps: [], reads: [] };

  let tick = 0;
  let clockNow = 0;
  const callCounts = new Map();
  const written = new Map(Object.entries(options.captured || {}).map(([key, value]) => [key, Buffer.from(value)]));
  const removed = [];

  /** The in-memory capture directory, read back the way `listRuns` / `readCapture` would (002 §11.2). */
  const files = {
    paths: () => [...written.keys()].sort(),
    has: (target) => written.has(target),
    read: (target) => written.get(target),
    json: (target) => {
      const found = written.get(target);
      if (!found) throw new Error(`harness: nothing was written to ${target}`);
      return JSON.parse(found.toString('utf8'));
    },
    removed
  };

  /**
   * §13.2 has the engine resolve and contain every path before a port is called, so `target` is
   * expected absolute; a relative one is resolved against the flow that named it rather than
   * against the process's working directory, which would make the failure look like a missing
   * fixture instead of an unresolved path.
   */
  const readFrom = (target, ctx) => {
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(ctx.flow), target);
    // Captures are read back through the same port that reads fixtures (002 §11.2), so the written
    // map is consulted first — R4o's round trip is otherwise a read against a file on disk.
    if (written.has(resolved)) return Buffer.from(written.get(resolved));
    if (overlay.has(resolved)) return Buffer.from(overlay.get(resolved));
    return fs.readFileSync(resolved);
  };

  // The path is logged before the read, so R4d can assert containment on the *port* — a run that
  // read the file and then rejected it has already read it.
  const readFile = async (target, ctx) => {
    log.reads.push(target);
    return readFrom(target, ctx);
  };

  const listDirectory = async (target) => {
    const prefix = target.endsWith(path.sep) ? target : `${target}${path.sep}`;
    const entries = new Set();
    for (const key of written.keys()) {
      if (key.startsWith(prefix)) entries.add(key.slice(prefix.length).split(path.sep)[0]);
    }
    return [...entries].sort();
  };

  /** 002 §11.2's two-port read side, which a scenario also reaches mid-run through `info`. */
  const readRuns = (overrides = {}) =>
    engine.listRuns({ scopeRoot: FIXTURES, ports: { readFile, listDirectory }, ...overrides });

  const executeRequest = async (request, ctx) => {
    const operationId = identify(request);
    const call = (callCounts.get(operationId) || 0) + 1;
    callCounts.set(operationId, call);

    const entry = { operationId, stepId: ctx.stepId, iteration: ctx.iteration, attempt: ctx.attempt };
    const info = {
      ...entry,
      call,
      abort: () => controller.abort(),
      files,
      // R4o's `running` row: a run in flight has to be listable from inside itself, which is the
      // case 002 §10 calls ordinary rather than an edge.
      listRuns: readRuns
    };
    const record = {
      ...entry,
      call,
      method: request.method,
      url: request.url,
      query: request.query,
      headers: request.headers,
      body: request.body,
      json: request.body && request.body.kind === 'json' ? request.body.value : undefined,
      auth: request.auth,
      request,
      startedAt: ++tick,
      settledAt: undefined
    };
    log.calls.push(record);

    const stub = (options.responses || {})[operationId];
    if (stub === undefined) {
      record.settledAt = ++tick;
      throw new Error(`harness: no stubbed response for ${operationId} (step ${ctx.stepId})`);
    }

    try {
      const spec = await selectResponse(stub, request, ctx, info);
      if (spec && spec.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
      }
      return materializeResponse(spec || {});
    } finally {
      record.settledAt = ++tick;
    }
  };

  const readSpec = async (source, ctx) => ({ text: readFrom(source, ctx).toString('utf8'), from: 'file' });

  /**
   * The script's value is carried out through a host object on the context rather than returned,
   * because the sandbox wraps a script in an async closure and discards what it evaluates to —
   * this is the same shape a host implementing `RunScript` has to use.
   */
  const runScript = async (source, args) => {
    const box = { args, result: undefined };
    log.scripts.push({ source, args });
    await runScriptInNodeVm({
      script: `__flow.result = await (${source})(...__flow.args);`,
      context: { __flow: box, console },
      collectionPath: FIXTURES,
      scriptingConfig: {}
    });
    return box.result;
  };

  const clock = {
    now: () => clockNow,
    sleep: async (ms) => {
      log.sleeps.push(ms);
      clockNow += ms;
    }
  };

  const ports = {
    executeRequest,
    readFile,
    readSpec,
    runScript,
    clock,
    listDirectory,
    writeFile: async (target, data) => {
      written.set(target, Buffer.from(data));
    },
    removeDirectory: async (target) => {
      removed.push(target);
      for (const key of [...written.keys()]) {
        if (key === target || key.startsWith(`${target}${path.sep}`)) written.delete(key);
      }
    }
  };

  return { ports, log, controller, files, readRuns };
};

const outcomeOf = (step) => (step.reason ? `${step.status}:${step.reason}` : step.status);

const report = (result, log, files, ports, readRuns) => {
  const iteration = (index) => {
    const found = result.iterations[index];
    if (!found) throw new Error(`harness: the run produced no iteration ${index}`);
    return found;
  };
  const step = (id, index = 0) => {
    const found = iteration(index).steps.find((entry) => entry.id === id);
    if (!found) throw new Error(`harness: the run produced no step ${id} in iteration ${index}`);
    return found;
  };

  return {
    result,
    status: result.status,
    exitCode: EXIT_CODE[result.status],
    iterations: result.iterations,

    /** `{ <stepId>: 'success' | 'skipped:condition-false' | ... }` — one iteration's whole table. */
    table: (index = 0) =>
      Object.fromEntries(iteration(index).steps.map((entry) => [entry.id, outcomeOf(entry)])),
    step,
    outcome: (id, index = 0) => outcomeOf(step(id, index)),

    calls: log.calls,
    callsFor: (operationId) => log.calls.filter((call) => call.operationId === operationId),
    call: (operationId, nth = 1) => {
      const matching = log.calls.filter((call) => call.operationId === operationId);
      if (!matching[nth - 1]) {
        throw new Error(`harness: ${operationId} was dispatched ${matching.length} times, wanted #${nth}`);
      }
      return matching[nth - 1];
    },

    sleeps: log.sleeps,
    scripts: log.scripts,
    reads: log.reads,

    files,
    /** 002 §11.2's readers run against the ports this run wrote through — that is the round trip. */
    listRuns: readRuns,
    readCapture: (options) => engine.readCapture({ dir: result.captureDir, ports, ...options }),
    captureDir: result.captureDir,
    /** Every written path relative to the run's own directory — the layout without its timestamp. */
    layout: () =>
      files
        .paths()
        .filter((target) => target.startsWith(`${result.captureDir}${path.sep}`))
        .map((target) => path.relative(result.captureDir, target))
        .sort()
  };
};

/**
 * Runs a fixture flow. `file` is a name under `fixtures/flows/`, or the absolute path a variant
 * carries.
 *
 * ```js
 * const run = await runFlow('f1-role-matrix.flow.yml', {
 *   responses: { login: { status: 200, body: { data: { access_token: 't' } } } }
 * });
 * ```
 */
const runFlow = async (file, options = {}) => {
  const { ports, log, controller, files, readRuns } = createPorts(options);
  const result = await engine.runFlow({
    entry: flowPath(file),
    scope: { workspaceRoot: FIXTURES },
    ports,
    variables: { environment: DEFAULT_VARS },
    overrides: options.overrides,
    signal: controller.signal,
    onEvent: options.onEvent
  });
  return report(result, log, files, ports, readRuns);
};

/** §13.2's read-only entry — two ports, because validation dispatches nothing. */
const validate = async (file, options = {}) => {
  const { ports } = createPorts(options);
  return engine.validateFlow({
    entry: flowPath(file),
    scope: { workspaceRoot: FIXTURES },
    ports: { readFile: ports.readFile, readSpec: ports.readSpec }
  });
};

/**
 * A committed fixture with an edit applied, served from memory beside the original so its relative
 * `apis:` and `uses:` paths still resolve.
 *
 * The structural scenarios are all of the form "delete this line and assert validation fails"
 * (F3.4, F4.4), so the thing under test is the *difference* from the committed file. Writing the
 * variant out by hand would leave two files to keep in step, and the assertion would stop meaning
 * "the fixture minus this edit" the moment they drifted.
 *
 * ```js
 * const { entry, files } = variant('f3-batch-settlement.flow.yml', (flow) => {
 *   flow.steps.find((step) => step.id === 'submit_settlement').depends = ['get_batch'];
 * });
 * await validate(entry, { files });
 * ```
 */
const variant = (file, mutate) => {
  const source = flowPath(file);
  const document = load(source);
  mutate(document);
  const entry = source.replace(/\.flow\.yml$/, '.variant.flow.yml');
  return { entry, files: { [entry]: stringify(document) } };
};

module.exports = { runFlow, validate, variant, FLOWS };
