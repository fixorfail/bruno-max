const { loader } = require('../sandbox/quickjs');
const { createManagedQuickJsContext, marshallToVm } = require('../sandbox/quickjs/utils');
const addConsoleShimToContext = require('../sandbox/quickjs/shims/console');

/**
 * Runs every QuickJS job already queued, then reports the handle's settled state.
 *
 * quickjs-emscripten's own promise resolution never progresses a genuinely pending promise in this
 * sandbox's sync-release build (`RELEASE_SYNC`, `sandbox/quickjs/index.js`) on its own — nothing
 * drives its job queue for it. The app's own script closure gets away without this because every
 * wrapped script's first line is `await bru.sleep(0)` (`utils/sandbox.js`): resolving that
 * host-bridged deferred is what makes the sandbox drain its queue as a side effect. A value-returning
 * script has no such shim to open on, so this drains the queue itself between checks. A value that
 * was never a promise settles on the first check — `getPromiseState` reports it `fulfilled` with
 * `notAPromise: true` rather than requiring the caller to tell promises and plain values apart first.
 */
/**
 * `vm.dump` turns a QuickJS `Error` into a plain `{name, message, stack}` object, not an `Error`
 * instance — the same thing `executeQuickJsVm`'s own error path returns as-is (`sandbox/quickjs/
 * index.js`). A caller awaiting this runner gets a real rejection either way, so it is reconstructed
 * as an actual `Error` here, the shape every other throw in this codebase already is.
 */
const toError = (dumped) => {
  if (dumped instanceof Error) {
    return dumped;
  }
  const error = new Error((dumped && typeof dumped === 'object' && dumped.message) || String(dumped));
  if (dumped && typeof dumped === 'object' && dumped.name) {
    error.name = dumped.name;
  }
  return error;
};

const settle = async (vm, handle) => {
  for (;;) {
    while (vm.runtime.hasPendingJob()) {
      vm.runtime.executePendingJobs();
    }
    const state = vm.getPromiseState(handle);
    if (state.type !== 'pending') {
      return state;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/**
 * Evaluates `source` to a function inside the QuickJS sandbox, calls it with `args`, and returns
 * the awaited, marshalled-out value — the one thing bruno-js's own QuickJS closure does not do.
 *
 * `wrapScriptInClosure`'s QuickJS wrapper (`utils/sandbox.js`) always resolves to the fixed string
 * `'done'`, and `executeQuickJsVmAsync` (`sandbox/quickjs/index.js`) disposes the resolved handle
 * without ever calling `vm.dump` on it — both are correct for a pre/post-request or test script,
 * which reports through the `bru`/`test` shims rather than a return value. A caller whose script
 * *is* an expression — an output, a `when:`, a retry predicate — needs the value itself, so this
 * runner skips that closure and dumps the result instead of discarding it.
 */
const runScriptInQuickJsForValue = async ({ source, args = [], console: consoleFn } = {}) => {
  const quickJsModule = await loader();
  const managedQuickJsContext = createManagedQuickJsContext(quickJsModule);
  const { vm } = managedQuickJsContext;

  try {
    consoleFn && addConsoleShimToContext(vm, consoleFn);

    const evaluated = vm.evalCodeRetained(`(${source})`, 'flow-script.js');
    if (evaluated.error) {
      const error = toError(vm.dump(evaluated.error));
      evaluated.error.dispose();
      throw error;
    }

    const fnHandle = evaluated.value;
    try {
      const argHandles = args.map((value) => marshallToVm(value, vm));
      const called = vm.callFunction(fnHandle, vm.global, ...argHandles);
      if (called.error) {
        const error = toError(vm.dump(called.error));
        called.error.dispose();
        throw error;
      }

      const state = await settle(vm, called.value);
      // `getPromiseState` hands back the very same handle when `called.value` was never a promise
      // (`notAPromise: true`) — disposing both would free it twice, so only a genuine promise
      // handle, distinct from its own settled value, needs disposing here as well.
      if (state.value !== called.value) {
        called.value.dispose();
      }

      if (state.type === 'rejected') {
        const error = toError(vm.dump(state.error));
        state.error.dispose();
        throw error;
      }

      const value = vm.dump(state.value);
      state.value.dispose();
      return value;
    } finally {
      fnHandle.dispose();
    }
  } finally {
    await managedQuickJsContext.waitForPendingDeferreds();
    managedQuickJsContext.dispose();
  }
};

module.exports = { runScriptInQuickJsForValue };
