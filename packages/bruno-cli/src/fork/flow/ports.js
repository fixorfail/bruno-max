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
const { runScriptInQuickJsForValue } = require('@usebruno/js/src/fork/quickjs-value-runner');
const { runScriptInNodeVm } = require('@usebruno/js/src/sandbox/node-vm');

const { createExecuteRequest } = require('./transport');

/**
 * 001 §8.2: flow scripts run in the sandbox mode a plain request in this collection would get, and
 * §14.1's `--sandbox` is how an invocation says which — the same flag, the same two values and the
 * same `safe` default as `bru run`. Only those two values reach here: `--sandbox` is declared with
 * `choices`, so a third is §14.2's usage error before any flow is read. That is one deliberate
 * difference from `bru run`, whose `getJsSandboxRuntime` treats every value but `safe` as
 * `developer` — a typo there silently escalates a script to `node:vm`, and §8.2's parity promise is
 * about the two sandboxes a request can actually be given, not about what a misspelling should do.
 *
 * `safe` is QuickJS through `runScriptInQuickJsForValue` (`bruno-js/src/fork/quickjs-value-runner.js`),
 * the value-returning entry point the app host uses too: bruno-js's own script closure always
 * resolves to the fixed string `'done'` and discards what a script evaluates to. `node:vm` has no
 * such value-returning entry point either, so `developer` hands the value back through a host object
 * on the context for the same reason.
 */
const createRunScript = ({ collectionPath, sandbox = 'safe' }) => {
  if (sandbox === 'safe') {
    return async (source, args) => runScriptInQuickJsForValue({ source, args, console });
  }

  return async (source, args) => {
    const box = { args, result: undefined };
    await runScriptInNodeVm({
      script: `__flow.result = await (${source})(...__flow.args);`,
      context: { __flow: box, console },
      collectionPath,
      scriptingConfig: {}
    });
    return box.result;
  };
};

const readSpec = async (source) => {
  if (/^https?:\/\//.test(source)) {
    const response = await axios.get(source, { transformResponse: (raw) => raw });
    return { text: response.data, from: 'network' };
  }
  return { text: fs.readFileSync(source, 'utf8'), from: 'file' };
};

const createPorts = ({ collectionPath, sandbox }) => ({
  executeRequest: createExecuteRequest({ collectionPath }),
  readFile: async (target) => fs.promises.readFile(target),
  writeFile: async (target, data) => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, data);
  },
  listDirectory: async (target) => fs.promises.readdir(target),
  removeDirectory: async (target) => fs.promises.rm(target, { recursive: true, force: true }),
  readSpec,
  runScript: createRunScript({ collectionPath, sandbox })
});

module.exports = { createPorts };
