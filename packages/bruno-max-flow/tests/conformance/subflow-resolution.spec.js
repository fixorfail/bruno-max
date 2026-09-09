/**
 * R12.1 — a `uses:` target's `workspace:` prefix (001 §12.2), and the containment (§7.4) it still
 * has to answer to.
 *
 * The fixtures live under `fixtures/flows/subflow/`, laid out as a miniature workspace so the
 * distinction the prefix exists for — a collection's own scope root versus the workspace root
 * above it — is a real difference between two directories, not a stand-in:
 *
 * ```
 * subflow/
 *   flows/shared/login.flow.yml          # WORKSPACE scope
 *   collections/payments/flows/          # COLLECTION scope — the run/describe/validate scope root
 * ```
 *
 * `run`, `describe` and `validate` each resolve a `uses:` target themselves (`src/run.ts`,
 * `src/describe.ts`, `src/validate.ts`), so the same fixture is asserted through all three —
 * agreeing by construction, since every path shares `resolveSubflowTarget` (`src/files.ts`), but
 * worth pinning as three call sites rather than one.
 */
const path = require('path');

const { describeFlow, runFlow, validate, variant, FLOWS } = require('./harness');

const WORKSPACE_ROOT = path.join(FLOWS, 'subflow');
const COLLECTION_ROOT = path.join(WORKSPACE_ROOT, 'collections', 'payments');
const SCOPE = { workspaceRoot: WORKSPACE_ROOT, collectionRoot: COLLECTION_ROOT };

const flow = (name) => `subflow/collections/payments/flows/${name}`;
const SIGNED_IN = { status: 200, body: { data: { token: 'tok_workspace' } } };

describe('R12.1 — uses: workspace:… resolves from the workspace root (§12.2)', () => {
  it('runs the sub-flow the prefix names', async () => {
    const run = await runFlow(flow('uses-workspace-prefix.flow.yml'), {
      scope: SCOPE,
      responses: { signIn: SIGNED_IN }
    });

    expect(run.outcome('auth')).toBe('success');
    expect(run.step('auth').outputs).toEqual({ token: 'tok_workspace' });
  });

  it('describes the same sub-flow the prefix names', async () => {
    const description = await describeFlow(flow('uses-workspace-prefix.flow.yml'), { scope: SCOPE });

    expect(description.diagnostics).toEqual([]);
    expect(description.nodes.map((entry) => entry.id)).toEqual(['auth', 'auth/login']);
    expect(description.nodes.find((entry) => entry.id === 'auth').kind).toBe('subflow');
  });

  it('validates clean', async () => {
    expect(await validate(flow('uses-workspace-prefix.flow.yml'), { scope: SCOPE })).toEqual([]);
  });
});

describe('R12.1 — a plain relative uses: path still resolves against the invoking file', () => {
  it('runs a sibling sub-flow inside the collection scope root, unprefixed', async () => {
    const run = await runFlow(flow('uses-relative-ok.flow.yml'), {
      scope: SCOPE,
      responses: { signIn: SIGNED_IN }
    });

    expect(run.outcome('auth')).toBe('success');
    expect(run.step('auth').outputs).toEqual({ token: 'tok_workspace' });
  });

  it('validates clean', async () => {
    expect(await validate(flow('uses-relative-ok.flow.yml'), { scope: SCOPE })).toEqual([]);
  });
});

describe('R12.1 — containment (§7.4) still refuses an escape', () => {
  /**
   * Without the prefix, a collection-scoped flow's scope root is the collection itself — the same
   * boundary a `!file` or `bodyFile:` answers to (§7.4) — so the very path `workspace:` is meant to
   * shorten is refused when written without it. Both scenarios are `variant()`s of a committed
   * fixture with only the `uses:` target edited — containment is refused on the path alone, before
   * anything is read, so the escaping target need not exist.
   */
  const relativeEscape = variant(flow('uses-relative-ok.flow.yml'), (document) => {
    document.steps.find((step) => step.id === 'auth').uses = '../../login.flow.yml';
  });

  const workspaceEscape = variant(flow('uses-workspace-prefix.flow.yml'), (document) => {
    document.steps.find((step) => step.id === 'auth').uses = 'workspace:../login.flow.yml';
  });

  it('refuses a plain relative uses: path that climbs out of the collection scope root', async () => {
    const diagnostics = await validate(relativeEscape.entry, { scope: SCOPE, files: relativeEscape.files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'path-outside-scope', stepId: 'auth' })
    );
  });

  it('refuses it at run time too, before the sub-flow is read', async () => {
    await expect(
      runFlow(relativeEscape.entry, { scope: SCOPE, files: relativeEscape.files, responses: { signIn: SIGNED_IN } })
    ).rejects.toThrow(/resolves outside the scope root/);
  });

  it('refuses a workspace: path that climbs out of the workspace root', async () => {
    const diagnostics = await validate(workspaceEscape.entry, { scope: SCOPE, files: workspaceEscape.files });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'path-outside-scope', stepId: 'auth' })
    );
  });

  it('refuses it at run time too, before the sub-flow is read', async () => {
    await expect(
      runFlow(workspaceEscape.entry, { scope: SCOPE, files: workspaceEscape.files, responses: { signIn: SIGNED_IN } })
    ).rejects.toThrow(/resolves outside the scope root/);
  });
});
