/**
 * The CLI's half of the engine boundary — 001 §13.2.
 *
 * `@bruno-max/flow` sends no HTTP, touches no `fs` and selects no script runtime; this is where a
 * host supplies all three. The engine owns *when* and *what*, a host owns *how*, which is what
 * keeps the CLI and the app from drifting on flow semantics while each keeps its own transport.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runScriptInNodeVm } = require('@usebruno/js/src/sandbox/node-vm');

/**
 * §6.4 hands over Bruno's own `Auth` shape rather than a header, so applying it stays the host's —
 * unchanged from how a request carries it today. The modes below are the ones a flow can currently
 * resolve; the signing modes go through the existing interceptors when flows reach them.
 */
const applyAuth = (auth, headers, query) => {
  if (!auth || auth.mode === 'none') return;

  if (auth.mode === 'bearer') {
    headers.Authorization = `Bearer ${auth.bearer.token}`;
    return;
  }
  if (auth.mode === 'basic') {
    const { username, password } = auth.basic;
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
    return;
  }
  if (auth.mode === 'apikey') {
    const { key, value, placement } = auth.apikey;
    if (placement === 'queryparams') query.push({ name: key, value });
    else headers[key] = value;
    return;
  }
  throw new Error(`the CLI does not apply ${auth.mode} auth for flows yet`);
};

const bodyForAxios = (body) => {
  switch (body.kind) {
    case 'none':
      return { data: undefined, contentType: undefined };
    case 'json':
      return { data: body.value, contentType: 'application/json' };
    case 'text':
      return { data: body.value, contentType: body.contentType };
    case 'urlencoded':
      return {
        data: new URLSearchParams(body.fields.map((field) => [field.name, field.value])).toString(),
        contentType: 'application/x-www-form-urlencoded'
      };
    default:
      throw new Error(`the CLI does not send a ${body.kind} body for flows yet`);
  }
};

const executeRequest = async (request, ctx) => {
  const headers = { ...request.headers };
  const query = [...request.query];
  applyAuth(request.auth, headers, query);

  const { data, contentType } = bodyForAxios(request.body);
  if (contentType && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = contentType;
  }

  const startedAt = Date.now();
  const response = await axios({
    method: request.method,
    url: request.url,
    params: new URLSearchParams(query.map((entry) => [entry.name, entry.value])),
    headers,
    data,
    signal: ctx.signal,
    timeout: ctx.timeoutMs,
    // The engine judges the status (§10.1); axios treating a 4xx as a rejection would turn a
    // negative test into a transport error.
    validateStatus: () => true,
    transformResponse: (raw) => raw
  });

  const text = typeof response.data === 'string' ? response.data : '';
  let parsed = response.data;
  if (text && String(response.headers['content-type'] || '').includes('json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: parsed,
    bytes: text ? Buffer.from(text) : undefined,
    responseTimeMs: Date.now() - startedAt,
    size: { body: text.length, headers: 0 }
  };
};

/**
 * The script's value comes back through a host object on the context, because the sandbox wraps a
 * script in an async closure and discards what it evaluates to.
 */
const runScript = (collectionPath) => async (source, args) => {
  const box = { args, result: undefined };
  await runScriptInNodeVm({
    script: `__flow.result = await (${source})(...__flow.args);`,
    context: { __flow: box, console },
    collectionPath,
    scriptingConfig: {}
  });
  return box.result;
};

const readSpec = async (source) => {
  if (/^https?:\/\//.test(source)) {
    const response = await axios.get(source, { transformResponse: (raw) => raw });
    return { text: response.data, from: 'network' };
  }
  return { text: fs.readFileSync(source, 'utf8'), from: 'file' };
};

const createPorts = ({ collectionPath }) => ({
  executeRequest,
  readFile: async (target) => fs.promises.readFile(target),
  writeFile: async (target, data) => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
  },
  listDirectory: async (target) => fs.promises.readdir(target),
  removeDirectory: async (target) => fs.promises.rm(target, { recursive: true, force: true }),
  readSpec,
  runScript: runScript(collectionPath)
});

module.exports = { createPorts, applyAuth, bodyForAxios };
