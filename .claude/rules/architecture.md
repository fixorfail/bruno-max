---
paths:
  - "packages/**/*"
  - "package.json"
---

# Architecture & Fork Boundaries

Internal `@usebruno/*` dependencies (from each `package.json`) form a strict DAG. **New code must
respect it** — a cyclic or upward dependency is an architectural bug, not a convenience.

The full monorepo map (build tools, request pipeline, sandbox, file formats, core data-model
types, dependency versions) is the on-demand reference `.claude/reference/architecture.md` — read
it before non-trivial cross-package or architectural work.

## Fork isolation — keep custom code out of upstream files

This repository is a **fork of Bruno's open-source repository** (`usebruno/bruno`) and merges
regularly from upstream `main`. Every line of fork-authored code living inside a file upstream also
edits becomes a merge conflict — re-paid at every merge, indefinitely. Minimizing that footprint is
a design constraint on new work, not a cleanup task to schedule later.

**Where new code goes, in order of preference:**

1. **A new fork-owned package** — directory `packages/bruno-max-*`, package name `@bruno-max/*`.
   Conflicts with nothing, and the distinct scope and prefix prevent a collision if upstream later
   ships a package of the same name.
2. **A new fork-owned directory inside an existing package** — e.g. `packages/bruno-app/src/fork/`.
   Upstream will never create it, so it can never conflict.
3. **An extension point upstream already provides.** Some seams need no upstream edit at all —
   `bruno-cli` uses `yargs.commandDir('commands')`, so a new command file auto-registers.
4. **A single delegating line in an upstream file** — only when there is no alternative.

**When an upstream file genuinely must change:**

- The line **delegates** to fork-owned code and contains no feature logic. One line calling into a
  fork registry beats twenty lines of inlined behavior: the conflict surface becomes trivial to
  re-apply after a merge.
- Place it at a stable, low-churn point in the file.
- Prefer a **registry** that later fork features can also register into, so the *second* feature
  costs zero new upstream edits. The indirection is paid once; the saving recurs at every merge.
- **Record it.** A feature's spec under `docs/specs/` must carry a manifest of every upstream file
  it touches, so the list can be re-checked after each upstream merge.

**Avoid upstream's shared data-model layers.** `bruno-lang`'s grammar, `bruno-filestore`'s
serializers, and `bruno-schema`'s Yup schemas are among the files upstream changes most often. A
new artifact type that owns its own format and validation sidesteps that entire class of conflict —
`docs/specs/001-api-flows.md` §13.4 is a worked example, including its touchpoint manifest.

A design that is slightly more awkward but confines itself to fork-owned files is usually the better
trade here, because the alternative cost is paid again at every single merge.

## Dependency direction & ownership boundaries

- **Leaf libs — zero internal `@usebruno/*` deps:** bruno-common, bruno-lang, bruno-query,
  bruno-requests, bruno-graphql-docs, bruno-schema, bruno-schema-types, bruno-toml.
- **Mid consumers:** bruno-js → (common, query); bruno-converters → (common, schema; schema-types
  as devDep); bruno-filestore → (common, lang; schema-types as devDep).
- **Top consumers (things flow *into* them, never out):** bruno-cli → (common, converters,
  filestore, js, lang, requests); bruno-electron → (common, converters, filestore, js, lang,
  requests, schema); bruno-app → (common, converters, graphql-docs, schema).

Guardrails this enforces:

1. **bruno-common is the browser-safe base leaf.** It runs in the web renderer (`bruno-app`), not
   just Node, so it must stay platform-neutral: no Node built-ins (`fs`, `path`, `os`, `crypto`,
   `child_process`, `node:*`) and no dependency that itself pulls in Node. It currently ships with
   zero runtime dependencies — keep it that way. It also depends on no other `@usebruno/*` package;
   a util that needs Node or another bruno package belongs in a different package.
2. **No shared/library package may import bruno-app or bruno-electron.** Renderer- or
   Electron-specific code must not be pushed down into a lib to make it importable upward.
3. **bruno-js must stay Electron-free.** It runs in both the Electron main process *and* the CLI
   (bruno-cli → js). Adding an `electron`/IPC import to bruno-js breaks the CLI. Sandbox logic
   belongs in bruno-js; host wiring belongs in bruno-electron.
4. **bruno-schema-types is types-only** (a *devDependency* of converters/filestore, built with
   plain `tsc`). Import types from it; never add runtime code or a runtime import of it.
5. **bruno-schema (Yup) and bruno-schema-types (TS types) are distinct and both live.** app +
   converters use `@usebruno/schema` for runtime validation; filestore + converters use
   `@usebruno/schema-types` for compile-time types. A data-model change usually touches both.

## Declared dependencies must match real imports

A package's `package.json` is the contract; workspace hoisting hides breaches of it. Declare every
import in the manifest of the package that imports it — one resolving only because a sibling or the
root happens to pull it in is a latent break. Test- and build-only packages belong in
`devDependencies`; anything in `dependencies` ships to users with its transitive tree. Drop a
declaration when the change removes its last consumer.
