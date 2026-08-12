# Specs

Design specifications for substantial features in this fork. A spec is written **before**
implementation and is the reference the implementation is reviewed against.

## Convention

- One file per feature: `NNN-short-slug.md`, numbered in the order they were started.
- Every spec opens with a **Status** block (`Draft` / `Accepted` / `Implemented` / `Superseded`),
  an owner, and the date it was last revised.
- Specs describe **behavior and contracts** — file formats, execution semantics, CLI surface,
  data model. They do not prescribe UI layout unless the UI *is* the contract.
- Decisions that were considered and rejected belong in the spec, with the reason. A spec that
  only records the winning option loses the argument that produced it.
- Open questions stay in the document under **Open Questions** until they are resolved, then move
  into the body. A spec with unresolved questions is still useful; a spec that hides them is not.
- **A spec long enough to need navigating carries its own entry point** — a short "How to read
  this" after the status block, with a section index, reading paths for the different people who
  arrive at it, and an explicit list of which parts are *contracts* others depend on. Past a few
  hundred lines a reader cannot tell load-bearing commitments from supporting reasoning, and the
  document's own author is the only person who can mark the difference.
- **Future work** is its own section, kept distinct from non-goals and rejected alternatives. The
  three answer different questions — *outside the feature's purpose*, *considered and decided
  against*, and *wanted but not now* — and collapsing them loses the reason each item is where it
  is. Every entry carries why it was deferred and what adopting it would take; an item leaves by
  being specified, and its row is deleted rather than left behind.

## Standing constraint: this is a fork

`bruno-max` is a fork of Bruno's open-source repository and merges regularly from upstream `main`.
Every spec must account for that: keep custom code in fork-owned files and packages, give upstream
files at most a single delegating line, and **enumerate every upstream file the feature touches**
so the list can be re-checked after each merge. `001-api-flows.md` §13.4 is the reference for how
to document this.

## Index

| Spec | Title | Status |
|---|---|---|
| [001](./001-api-flows.md) | API Flows — sequenced, spec-driven request execution | Draft — contracts settled, implementation may start; §18 holds path-local questions |
| [001-C](./001-api-flows-conformance.md) | API Flows — conformance scenarios | Draft — companion to 001 |
| [002](./002-api-flows-ui.md) | API Flows UI — run & observe in the app | Draft — 001 has answered what it owed; one question of its own in §14 |
| [002-C](./002-api-flows-ui-conformance.md) | API Flows UI — conformance scenarios | Draft — companion to 002 |

**Start with [001's "How to read this"](./001-api-flows.md#how-to-read-this)** — it routes by what
you are doing and marks which sections are contracts rather than reasoning.

A spec may have a **conformance companion** (`NNN-slug-conformance.md`) holding the scenarios its
behavior was derived from, written so they can be implemented directly as tests. Where the spec says
what the contract is, the companion says what breaks if it is wrong.
