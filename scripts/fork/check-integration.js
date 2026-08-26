#!/usr/bin/env node
/**
 * Fork integration guard.
 *
 * Upstream merges fail loudly when two sides edit the same lines, but they fail *silently*
 * when a merge simply drops one of the single delegating lines this fork threads into
 * upstream files (see "Fork isolation" in .claude/rules/architecture.md). Nothing conflicts,
 * the unit tests still pass, and the feature just quietly stops being reachable.
 *
 * This asserts every one of those seams is still present, still wired to a live call site,
 * and that the build/config plumbing the fork depends on survived. Run it on every
 * upstream sync PR.
 *
 * Usage: node scripts/fork/check-integration.js
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

/**
 * Paths the fork owns outright. Everything else is an upstream file, where a reference to
 * fork code must be a delegating line listed in DELEGATIONS below.
 */
const FORK_OWNED = [
  'packages/bruno-max-flow/',
  'packages/bruno-app/src/fork/',
  'packages/bruno-electron/src/ipc/flow/',
  'packages/bruno-electron/src/app/flowsWatcher',
  'packages/bruno-cli/src/fork/',
  'packages/bruno-cli/tests/fork/',
  'packages/bruno-cli/src/commands/flow.js'
];

/**
 * The delegating lines this fork threads into upstream files. `symbols` must each be bound by
 * an import/require of `module` *and* referenced somewhere else in the file — an import that
 * survives a merge with its call site removed is just as broken as a missing import.
 */
const DELEGATIONS = [
  { file: 'packages/bruno-app/src/providers/App/useIpcEvents.js', module: 'fork/registry', symbols: ['registerForkIpcEvents'] },
  { file: 'packages/bruno-app/src/providers/ReduxStore/index.js', module: 'fork/registry', symbols: ['forkReducers'] },
  { file: 'packages/bruno-app/src/components/Sidebar/index.js', module: 'fork/registry', symbols: ['forkSidebarSections'] },
  { file: 'packages/bruno-app/src/components/RequestTabPanel/index.js', module: 'fork/registry', symbols: ['isForkTab', 'ForkTabPane'] },
  { file: 'packages/bruno-app/src/components/Devtools/Console/index.js', module: 'fork/registry', symbols: ['selectDevtoolsRequests'] },
  { file: 'packages/bruno-app/src/components/Devtools/Console/NetworkTab/index.js', module: 'fork/registry', symbols: ['selectDevtoolsRequests'] },
  { file: 'packages/bruno-app/src/components/RequestTabs/index.js', module: 'fork/tabTypes', symbols: ['isForkTab'] },
  { file: 'packages/bruno-app/src/components/RequestTabs/index.js', module: 'fork/tabGroup', symbols: ['tabsSharingStripWith'] },
  { file: 'packages/bruno-app/src/components/RequestTabs/index.js', module: 'fork/registry', symbols: ['ForkTabHeader'] },
  { file: 'packages/bruno-app/src/components/RequestTabs/RequestTab/SpecialTab.js', module: 'fork/registry', symbols: ['ForkTabLabel'] },
  { file: 'packages/bruno-app/src/components/RequestTabs/RequestTab/index.js', module: 'fork/tabTypes', symbols: ['FORK_TAB_TYPES'] },
  {
    file: 'packages/bruno-electron/src/index.js',
    module: './ipc/flow',
    symbols: ['registerFlowIpc'],
    // The flow host must also be torn down on quit, or runs outlive the window.
    alsoMatch: [/require\(['"]\.\/ipc\/flow['"]\)\.shutdown\(\)/]
  }
];

/**
 * Build and config plumbing. A dropped alias here doesn't remove a feature — it breaks the
 * app build outright, so these are worth catching before CI spends 40 minutes finding out.
 */
const WIRING = [
  {
    what: "bruno-app jsconfig.json resolves the 'fork/*' alias (rsbuild reads this via source.tsconfigPath)",
    file: 'packages/bruno-app/jsconfig.json',
    check: (raw) => Boolean(JSON.parse(raw).compilerOptions?.paths?.['fork/*'])
  },
  {
    what: 'bruno-app jest.config.js loads the fork jest setup',
    file: 'packages/bruno-app/jest.config.js',
    check: (raw) => raw.includes('src/fork/jest.setup.js')
  },
  {
    what: 'root package.json lists the bruno-max-flow workspace',
    file: 'package.json',
    check: (raw) => (JSON.parse(raw).workspaces || []).includes('packages/bruno-max-flow')
  },
  {
    what: 'root package.json defines build:bruno-max-flow',
    file: 'package.json',
    check: (raw) => Boolean(JSON.parse(raw).scripts?.['build:bruno-max-flow'])
  },
  {
    what: 'bruno-cli depends on @bruno-max/flow',
    file: 'packages/bruno-cli/package.json',
    check: (raw) => Boolean(JSON.parse(raw).dependencies?.['@bruno-max/flow'])
  },
  {
    what: 'bruno-electron depends on @bruno-max/flow',
    file: 'packages/bruno-electron/package.json',
    check: (raw) => Boolean(JSON.parse(raw).dependencies?.['@bruno-max/flow'])
  },
  {
    what: 'bruno-app depends on @dagrejs/dagre (flow graph layout)',
    file: 'packages/bruno-app/package.json',
    check: (raw) => Boolean(JSON.parse(raw).dependencies?.['@dagrejs/dagre'])
  },
  {
    what: 'CI setup action builds bruno-max-flow',
    file: '.github/actions/common/setup-node-deps/action.yml',
    check: (raw) => raw.includes('build:bruno-max-flow')
  },
  {
    what: 'scripts/setup.js builds bruno-max-flow for fresh clones',
    file: 'scripts/setup.js',
    check: (raw) => raw.includes('build:bruno-max-flow')
  },
  {
    what: 'eslint.config.js covers packages/bruno-max-flow',
    file: 'eslint.config.js',
    check: (raw) => raw.includes('packages/bruno-max-flow')
  }
];

const errors = [];
const warnings = [];

const read = (rel) => {
  const abs = path.join(repoRoot, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
};

/** Lines that bind `module`, e.g. `import { x } from 'fork/registry'` or `require('./ipc/flow')`. */
const importLinesFor = (lines, module) => {
  const quoted = new RegExp(`['"]${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
  return lines
    .map((text, i) => ({ text, i }))
    .filter(({ text }) => quoted.test(text) && /^\s*(import|const|let|var)\b|\brequire\s*\(/.test(text));
};

for (const { file, module, symbols, alsoMatch } of DELEGATIONS) {
  const raw = read(file);
  if (raw === null) {
    errors.push(`${file}: missing entirely (expected it to delegate to '${module}')`);
    continue;
  }

  const lines = raw.split('\n');
  const importLines = importLinesFor(lines, module);

  if (importLines.length === 0) {
    errors.push(`${file}: no longer imports '${module}' — the delegating line was dropped, likely by an upstream merge`);
    continue;
  }

  const importLineNums = new Set(importLines.map(({ i }) => i));

  for (const symbol of symbols) {
    const bound = importLines.some(({ text }) => new RegExp(`\\b${symbol}\\b`).test(text));
    if (!bound) {
      errors.push(`${file}: imports '${module}' but no longer binds '${symbol}'`);
      continue;
    }

    const usedElsewhere = lines.some(
      (text, i) => !importLineNums.has(i) && new RegExp(`\\b${symbol}\\b`).test(text)
    );
    if (!usedElsewhere) {
      errors.push(`${file}: imports '${symbol}' from '${module}' but never uses it — the call site was dropped`);
    }
  }

  for (const pattern of alsoMatch || []) {
    if (!pattern.test(raw)) {
      errors.push(`${file}: expected to match ${pattern}`);
    }
  }
}

for (const { what, file, check } of WIRING) {
  const raw = read(file);
  if (raw === null) {
    errors.push(`${file}: missing entirely (${what})`);
    continue;
  }
  let ok = false;
  try {
    ok = check(raw);
  } catch (err) {
    errors.push(`${file}: could not be parsed (${what}) — ${err.message}`);
    continue;
  }
  if (!ok) errors.push(`${file}: ${what} — no longer true`);
}

/**
 * Drift detection: a fork reference in an upstream file that isn't a known delegation means
 * the manifest above is stale. Warn rather than fail, so adding a seam doesn't break CI before
 * the author gets a chance to record it.
 */
const declared = new Set(DELEGATIONS.map(({ file }) => file));
const isForkOwned = (rel) => FORK_OWNED.some((prefix) => rel.startsWith(prefix));

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) out.push(path.relative(repoRoot, abs));
  }
  return out;
};

for (const rel of walk(path.join(repoRoot, 'packages'))) {
  if (isForkOwned(rel) || declared.has(rel)) continue;
  const raw = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  if (/from ['"]fork\/|require\(['"]fork\/|@bruno-max\//.test(raw)) {
    warnings.push(`${rel}: references fork code but is not in DELEGATIONS — add it to ${path.relative(repoRoot, __filename)}`);
  }
}

for (const warning of warnings) console.warn(`warning  ${warning}`);

if (errors.length > 0) {
  console.error(`\nFork integration check FAILED — ${errors.length} problem(s):\n`);
  for (const error of errors) console.error(`  error  ${error}`);
  console.error('\nAn upstream merge most likely dropped a fork seam. Restore the delegating line');
  console.error('or, if the upstream file moved, re-thread it and update DELEGATIONS.\n');
  process.exit(1);
}

console.log(
  `Fork integration check passed — ${DELEGATIONS.length} delegation points, ${WIRING.length} wiring invariants` +
    (warnings.length > 0 ? `, ${warnings.length} warning(s)` : '')
);
