# Arazzo and Bruno Flows

**Status:** Evaluated, no action taken · **Owner:** Jake Campbell · **Date:** 2026-09-01

Does the [Arazzo Specification](https://spec.openapis.org/arazzo/latest.html) — the OpenAPI
Initiative's standard for describing sequences of API calls — have any use in this fork's API Flows
feature ([spec 001](./specs/001-api-flows.md), [spec 002](./specs/002-api-flows-ui.md),
`@bruno-max/flow`)?

This document is the answer. It is deliberately kept out of the specs: 001 §17 records alternatives
that were considered *while designing the format*, and Arazzo was not one of them. Reclassifying it
after the fact would misrepresent how the design happened.

---

## Verdict

**Not as the flow file format. Yes as an export target, if a consumer ever appears. No as an
importer.**

Arazzo and 001 both describe sequences of API calls addressed against OpenAPI documents, and
converged on that central move independently — but they exist for different reasons, which is the
next section and the key to everything after it. Concretely: Arazzo's execution model is an ordered
step list with imperative `onSuccess`/`onFailure` transitions, and 001's is a dependency graph. That
difference is not cosmetic — it decides that Arazzo can be a thing flows are *emitted to*, and
cannot be the thing flows are *stored as*.

Nothing in the repo depends on this decision today. It is written down so the next person to ask
does not have to re-derive it.

---

## The framing that explains every gap below

**Arazzo is a format for describing how an API is used. It is not a format for testing that an API
works.** Everything this document lists as missing follows from that, and almost none of it is an
oversight.

An Arazzo document answers *"what sequence of calls achieves this outcome, and what does each step
need from the last?"* — for documentation, for SDK and client generation, and increasingly as
something an LLM agent can read to learn a multi-call procedure. It is a description of intent,
authored to be portable across independent runners.

A flow answers a different question: *"did this sequence behave correctly just now, and if not,
where and why?"* That question needs things a description format has no reason to carry — a failure
vocabulary, evidence left on disk, cleanup that survives a failure, an escape hatch for logic the
declarative form cannot express.

So the gaps below are not defects in Arazzo. They are the cost of adopting a description format as
an execution format, and they are why the answer is *export to it*, not *store as it*.

---

## What Arazzo is

A JSON/YAML document describing workflows over one or more API descriptions. Version 1.0 shipped
September 2024; **v1.1.0** was released 17 May 2026 and is additive — 1.0 documents remain valid.

The object model, in brief:

- `sourceDescriptions` — the OpenAPI / AsyncAPI / Arazzo documents the workflows draw on.
- `workflows[]` — each with `workflowId`, `inputs` (a JSON Schema), `outputs`, `parameters`,
  `dependsOn`, and an ordered `steps[]`.
- A step references an operation by `operationId`, `operationPath`, `channelPath`, or another
  `workflowId`, and carries `parameters`, `requestBody`, `successCriteria`, `outputs`, `timeout`,
  and `onSuccess` / `onFailure` action lists.
- Actions are `end`, `goto` (a `stepId` or `workflowId`), or — on failure — `retry` with
  `retryAfter` and `retryLimit`.
- `successCriteria` entries are `condition` + `context` + a `type` of `simple`, `regex`,
  `jsonpath` (RFC 9535) or `xpath` (3.1).
- Runtime expressions are `$`-prefixed — `$inputs.x`, `$steps.<id>.outputs.<name>`, `$statusCode`,
  `$response.body#/path` — with RFC 6901 JSON Pointers after `#`, and `{}` for embedding.

---

## Where the two designs agree

This is the part worth recording. 001 was written from Bruno's own problem statement, not from an
existing workflow standard, and it still landed on Arazzo's central idea: reference an operation in
a spec rather than duplicate the request.

| Arazzo | Bruno Flows |
|---|---|
| `sourceDescriptions` | `apis:` — an alias bound to an OpenAPI document (001 §5.2, §6) |
| A step's `operationId` / `operationPath` | `operation: <alias>#<operationId>`, with a `METHOD /path` fallback (001 §6.1) |
| A step's `outputs` | Declared connectors, `outputs:` (001 §8.1) |
| A workflow's `inputs` / `outputs` | A library flow's `params:` / `exports:` (001 §12.1) |
| A step referencing a `workflowId` | `uses:` + `with:` sub-flows (001 §12) |
| `successCriteria` | `assert:` (001 §10.2) |
| `failureActions` of `type: retry`, with `retryAfter` / `retryLimit` | `retry:` — `maxAttempts`, `delay`, `backoff`, `shouldRetry` (001 §11.1) |

Verified against source: `operation:` is split on `#` in
[`document.ts:578`](../packages/bruno-max-flow/src/document.ts); operations are indexed by
`operationId` in [`openapi.ts`](../packages/bruno-max-flow/src/openapi.ts); `params:` normalization
is at [`document.ts:493`](../packages/bruno-max-flow/src/document.ts); `RetryPolicy` at
[`document.ts:123`](../packages/bruno-max-flow/src/document.ts).

### Composition is the one place Arazzo is arguably stronger

Sub-flows are not a gap. A step may target a `workflowId` in place of an operation, workflows
declare `inputs` and `outputs`, and `sourceDescriptions` may reference **another Arazzo document** —
so shared workflows are a first-class, cross-document concern. Two details beat this fork's:

- Workflow `inputs` are a **JSON Schema**, so arguments are typed and validated. 001's `params:` are
  `{ required, default, secret }` and unvalidated ([`document.ts:493`](../packages/bruno-max-flow/src/document.ts)).
- Reuse is by document reference rather than by relative path, so a shared workflow can live behind
  a URL.

Two gaps remain even here:

- **No auth model whatsoever.** Arazzo has no `authProfiles` equivalent, so 001 §6.4 and §12.3 — auth
  profiles resolving in the flow that *defines* them, then inherited into sub-flows — have nowhere to
  live. Each runner supplies its own — Jentic's Arazzo Runner, for one, implements API key, OAuth2,
  basic and bearer itself — so authentication is runner-specific rather than described by the
  document.
- **No `library: true` equivalent.** Nothing marks a workflow as a fragment that should not be
  discovered and run on its own (001 §12.5).

---

## Where Arazzo cannot go

Six divergences. Each is a place 001 committed to something on its own grounds, before Arazzo was
in view, and would have to give up to adopt the format.

**1. The graph.** 001 §9.1 is a DAG: `depends` edges carry status sets drawn from
`success | failed | skipped | cancelled`, joins are `all` or `any`, and cross-branch values move
through statically validated `shared:` slots. Arazzo has an ordered list plus `goto`. It cannot
express an `any` join or a shared slot at all. 001 §17 already rejected a first-class `fallback:`
and dedicated `setup:`/`teardown:` phases *because* the graph subsumes them — adopting Arazzo would
undo the argument that removed them.

**2. Branch selection sits on the wrong step.** `onSuccess`/`onFailure` put the decision on the
step that produced the outcome. 001 §17 rejected exactly this shape under `continueOnFailure`: the
dependent is what knows which outcomes it can tolerate, and there should be one way to say it.

**3. No schema-validation model.** 001 §10.1's `validateRequest`, `validateSchema`, `strictSchema`
and `failOnStatusCode` check the request body and the response against the bound OpenAPI document
automatically. Arazzo asserts only what the author writes; there is nowhere to put these.

**4. Three more expression dialects.** `successCriteria.type` admits `simple`, `regex`, `jsonpath`
and `xpath`. 001 §17 has twice refused to add a *second* dialect — once for
`when: "{{expr}} == value"`, once for a `{{a ?? b}}` coalesce operator — and paths are
`@usebruno/query`'s, not JSONPath. Separately, JSON-Pointer body addressing (`$response.body#/id`)
yields a string, where 001 §7.3's whole-value rule has to yield the typed value: a `{{...}}` that is
the entire scalar resolves to the real object, number or array so it can reach a typed JSON field.

**5. `workflowId` versus path identity.** 001 §5.2 argues explicitly against an `id:` field, because
a second source of identity can disagree with the first — a file renamed without its id, or an id
duplicated across two files. Arazzo requires one.

**6. `!file` and `!...`.** 001 §5.4's YAML local tags resolve to a class instance and a symbol, by
*identity* rather than shape, so no document can forge them. There is no JSON-representable
equivalent. These are the single hardest thing to round-trip.

Two smaller asymmetries: Arazzo has no counterpart for `dataset:` iteration (001 §9.4), and Bruno
has no per-step loop — polling is `retry` + `shouldRetry`, not a loop construct.

---

## What it lacks as a test format

The six items above are model divergences — they decide the storage question. This is the narrower
list: things a test runner needs that a description format has no reason to carry.

- **A failure vocabulary.** Nothing distinguishes an assertion failure from a transport error, a
  schema mismatch, or a step skipped because an upstream one failed. 001 §14.6's `StepReason` set is
  a stable contract precisely so reporters and CI can tell them apart.
- **Static validation.** Nothing proves acyclicity, ancestry, or that a referenced output is ever
  actually produced, before a run starts. Under concurrency those are bugs every time, and 001
  catches them in `validate.ts` rather than discovering them as a flaky run.
- **Retry beyond `retryAfter` / `retryLimit`.** No backoff, no jitter, no predicate — so
  poll-until-condition, the commonest shape in integration testing, is not expressible. 001's
  `shouldRetry` sees the whole step outcome, which is what makes polling first-class.
- **Cleanup guarantees.** No way to say "run this whether the flow passed, failed, or was
  cancelled." 001 expresses it as an ordinary step with a status set on its `depends` (§9.1), plus a
  cancellation grace window (§11.3). Without it, a failed run leaks whatever it created.
- **Run artifacts.** No capture model, no redaction, no reporters. Nothing is left on disk for CI to
  attach or for a human to read afterwards (001 §14.4, §14.5).
- **File handling.** No fixture references and no multipart uploads — 001's `!file`, `bodyFile:` and
  media-type-driven multipart (§7.4, §7.5) have no counterpart.
- **Auth.** Covered above: there is no auth construct at all.
- **Any escape hatch for logic.** No scripting anywhere — no `functions:` library, no `script:`
  connector, no `pre:`, no `shouldRetry` predicate, no `when: { script: ... }`. Everything must
  reduce to `simple` / `regex` / `jsonpath` / `xpath` criteria and JSON-Pointer extraction, so a
  derived or structured output — one script producing several fields from one parse — cannot be
  written at all.

That last one deserves to be read as a design choice rather than an omission: arbitrary JS would
make a document non-portable, and portability across independent runners is the property Arazzo
exists to have. It is a real limit for testing and a coherent decision for a description format —
which is the same tension as every other entry here.

---

## Where it does have use: export

A `.flow.yml` carries strictly more than an Arazzo document needs, so the conversion that loses
information is the one that runs in the direction there is demand for. Emitting `.arazzo.yaml` from
a flow would make flows consumable by the tools that already execute Arazzo — Redocly's Respect,
Specmatic, Jentic's Arazzo Runner (Python, beta), and the `arazzo-runner` npm package (0.0.x, thinly
maintained) — and would give API consumers a vendor-neutral description of a sequence without
handing them Bruno.

Nobody has asked for this. If it is taken up, it needs:

- **A declared loss policy.** `shared:` slots, `dataset:`, `!file`, `pre:` and `script:` connectors,
  per-attempt `timeout`, and 001 §10.1's validation flags have no Arazzo form. The emitter must
  *report* what it dropped rather than write a quietly weaker document that looks complete.
- **A home in fork-owned code.** Per `.claude/rules/architecture.md`, this belongs in
  `packages/bruno-max-*`, not in `packages/bruno-converters`, which is upstream's.

That is the whole of the case. It is not urgent and it should not be designed before real flows show
which constructs they actually lean on.

### Why not import

An Arazzo document's ordered step list converts to a flow of implicit sequence edges and nothing
else — a straight line with no `depends`, no joins, no slots. That is precisely the shape 001's
goal 2 exists to move past, so the output would be a flow nobody would have written. The on-ramp
value is real but small, and it does not justify a parser for a format we would immediately
re-author by hand.

---

## Upstream's position

Upstream tracks this as [usebruno/bruno#2498](https://github.com/usebruno/bruno/issues/2498),
"Implementation of Arazzo Specification v1.0.0" — **open**, assigned, labelled `enhancement`,
`long-term-goal`, `module-importers`.

The `module-importers` label is the useful signal: upstream frames Arazzo as collection *import*,
not as a native workflow format. Whatever it eventually ships there will not collide with this
fork's flows, and adds nothing to 001 §13.4's upstream-touchpoint list.

---

## What was checked

- **In this repo:** a case-insensitive grep for `arazzo` across `docs/`, `packages/` and `.claude/`
  returns no first-party hits. The only occurrences are in `package-lock.json` —
  `@swagger-api/apidom-ns-arazzo-1` and `apidom-parser-adapter-arazzo-{json,yaml}-1`, *optional
  transitive* dependencies of `@swagger-api/apidom-reference` reached through the OpenAPI converter.
  Nothing in source imports them. Arazzo parsing is incidentally present in the dependency tree and
  entirely unused.
- **In the specs:** 001 §3 (non-goals), §17 (rejected alternatives, ~90 rows) and §19 (future work)
  contain no mention of Arazzo, nor of any other prior-art workflow format.
- **In `bruno-converters`:** the package handles Postman, OpenAPI/Swagger, Insomnia, WSDL and
  OpenCollection — collections only. There is no flow converter in either direction, and
  `@bruno-max/flow` does not depend on it.

One claim was **not** verified and is excluded from the reasoning above: several third-party
write-ups state that Bruno already ships Arazzo support. The most specific of them
([API Evangelist, 2026-08-14](https://apievangelist.com/2026/08/14/the-tools-that-actually-execute-your-arazzo-workflows/))
describes read-only GUI viewing rather than execution, and it conflicts with #2498 still being open.
Treat it as unconfirmed.
