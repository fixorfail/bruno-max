/**
 * The delegation surface must load in **either** evaluation order.
 *
 * Fork components import `addTab` from `slices/tabs.js`, so anything that made `tabs.js` import
 * `registry.js` back — the registry pulls in the whole component tree — was a cycle: whichever
 * module the bundler reached first left the other's binding `undefined`. It fails at module init
 * with "undefined is not iterable", in only one of the two orders, which is the kind of break that
 * passes locally and fails on someone else's machine.
 *
 * `tabs.js` no longer imports fork code at all, and `fork/tabTypes.js` is a leaf for anything that
 * later needs to. Both orders below must stay green.
 */

const expectBothLoaded = (registry, tabs) => {
  expect(typeof tabs.addTab).toBe('function');
  expect(tabs.NON_CLOSABLE_TAB_TYPES).toEqual(expect.arrayContaining(['workspaceOverview']));
  expect(registry.forkReducers.flows).toBeDefined();
  expect(registry.forkSidebarSections).toHaveLength(1);
};

/**
 * The registry's **eager** import graph must contain no upstream module.
 *
 * `providers/ReduxStore/index.js` imports this file for its reducers, and fork components
 * legitimately import upstream ones (`StepDetail` uses `components/CodeEditor`, which reaches the
 * store). Eagerly importing the components closes that loop, and the failure is silent: the store's
 * module is entered while this one is mid-evaluation, `forkReducers` reads as `undefined`, and
 * `{...undefined}` is legal — so the app builds a store with no `flows` reducer and breaks
 * somewhere else entirely. `React.lazy` keeps the components out of this graph.
 */
describe('the fork registry import graph', () => {
  const fs = require('fs');
  const path = require('path');

  const FORK_ROOT = path.join(process.cwd(), 'src', 'fork');
  const UPSTREAM = /^(components|providers|utils|ui|themes|hooks|api|assets|pageComponents)\//;

  const resolveLocal = (from, specifier) => {
    const target = path.resolve(path.dirname(from), specifier);
    for (const candidate of [target, `${target}.js`, path.join(target, 'index.js')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return undefined;
  };

  const eagerImports = (entry, seen = new Set()) => {
    if (seen.has(entry)) return [];
    seen.add(entry);

    const source = fs.readFileSync(entry, 'utf8');
    // Static imports only — a `lazy(() => import(...))` is deliberately not followed, because it is
    // exactly what keeps the component graph out of this module's evaluation.
    const specifiers = [...source.matchAll(/^import\s+[^;]*?from\s+'([^']+)';/gm)].map((match) => match[1]);

    return specifiers.flatMap((specifier) => {
      if (!specifier.startsWith('.')) return [{ from: entry, specifier }];
      const local = resolveLocal(entry, specifier);
      return local ? eagerImports(local, seen) : [];
    });
  };

  it('reaches no upstream module', () => {
    const offenders = eagerImports(path.join(FORK_ROOT, 'registry.js')).filter((entry) =>
      UPSTREAM.test(entry.specifier)
    );

    expect(offenders).toEqual([]);
  });
});

describe('the fork registry', () => {
  it('loads when the registry is evaluated first', () => {
    jest.isolateModules(() => {
      const registry = require('fork/registry');
      const tabs = require('providers/ReduxStore/slices/tabs');
      expectBothLoaded(registry, tabs);
    });
  });

  it('loads when the tabs slice is evaluated first', () => {
    jest.isolateModules(() => {
      const tabs = require('providers/ReduxStore/slices/tabs');
      const registry = require('fork/registry');
      expectBothLoaded(registry, tabs);
    });
  });

  it('recognises a flow tab and nothing else', () => {
    const { isForkTab } = require('fork/registry');

    expect(isForkTab({ type: 'flow' })).toBe(true);
    expect(isForkTab({ type: 'collection-settings' })).toBe(false);
    expect(isForkTab(undefined)).toBe(false);
  });
});
