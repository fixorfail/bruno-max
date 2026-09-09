import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../playwright';
import {
  buildCommonLocators,
  flowYamlCursorLine,
  openFlow,
  openFlowYamlEditor,
  openFlowsSection,
  runFlow,
  selectStep,
  startFlowRun,
  waitForFlowRun
} from '../utils/page';

/**
 * 002-C §5 — U3: diagnostics.
 *
 * §6's rule is that errors block a run and warnings do not, and that a flow you cannot open is the
 * one you most wanted to look at. These pin both, plus the surfaces §7.2 puts around a run: the way
 * capture is chosen, how a library flow is listed and where the environment is selected from.
 */
test.describe('U3 — diagnostics', () => {
  // The watcher and capture cases restart the app so they act on their own copy of the fixture, and
  // two of them run a flow end to end.
  test.describe.configure({ timeout: 90_000 });

  test('U3.1 blocks the run on an error and does not block it on a warning', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'unknown-operation.flow.yml');

    await test.step('an unknown operationId disables the run control and is listed above the graph', async () => {
      await expect(flows.run.button()).toBeDisabled();
      await expect(flows.diagnostics.root()).toBeVisible();
      await expect(flows.diagnostics.line('unknown-operation')).toContainText('refundOrder');
    });

    await test.step('a flow whose only problem is a warning runs', async () => {
      await openFlow(page, 'fulfillment.flow.yml');
      await expect(flows.run.button()).toBeEnabled();
    });

    await test.step('and reports it as a count at the end of the toolbar, not as a list', async () => {
      await expect(flows.toolbar.warnings()).toContainText(/\d+ warning/);
      await expect(flows.diagnostics.root()).toHaveCount(0);
      await expect(flows.toolbar.warningsList()).not.toBeInViewport();
    });

    await test.step('hovering the count lists it with its code and line', async () => {
      await flows.toolbar.warnings().hover();
      await expect(flows.toolbar.warningsList()).toContainText('undeclared-dependency');
      await expect(flows.toolbar.warningsList().locator('.diagnostic-line').first()).toContainText(/line \d+/);
    });

    await test.step('focusing it does the same', async () => {
      await page.keyboard.press('Escape');
      await flows.toolbar.warnings().focus();
      await expect(flows.toolbar.warningsList()).toContainText('undeclared-dependency');
    });
  });

  test('U3.2 anchors a diagnostic at its line', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'unknown-operation.flow.yml');

    // The engine anchors a step's diagnostic at the step it belongs to, which is where the reader is
    // sent when they go looking for it.
    const source = await fs.promises.readFile(
      path.join(__dirname, 'fixtures', 'workspace', 'flows', 'unknown-operation.flow.yml'),
      'utf8'
    );
    const line = source.split('\n').findIndex((text) => text.includes('id: refund_order')) + 1;

    await expect(flows.diagnostics.line('unknown-operation')).toContainText(`line ${line}`);
  });

  test('U3.3 badges the nodes a structural diagnostic names', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'cyclic.flow.yml');

    await expect(flows.diagnostics.line('cyclic-dependency')).toBeVisible();
    await expect(flows.graph.nodeBadge('first_step')).toBeAttached();
    await expect(flows.graph.nodeBadge('first_step')).toHaveClass(/error/);
  });

  test('U3.4 opens a flow that does not parse', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'unparseable.flow.yml');

    await expect(flows.diagnostics.line('parse-error').first()).toBeVisible();
    await expect(flows.graph.allNodes()).toHaveCount(0);
    await expect(flows.run.button()).toBeDisabled();
  });

  test('U3.5 clears a diagnostic when the file is fixed on disk', async ({ restartApp, workspaceFixturePath }) => {
    expect(workspaceFixturePath, 'the workspace fixture must be present').toBeTruthy();
    const flowFile = path.join(workspaceFixturePath!, 'flows', 'unknown-operation.flow.yml');
    const original = await fs.promises.readFile(flowFile, 'utf8');

    // `restartApp` binds a fresh app to *this* test's copy of the fixture, which is what makes the
    // edit below one the app is watching.
    const app = await restartApp({});
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

    const { flows } = buildCommonLocators(page);

    try {
      await openFlowsSection(page);
      await openFlow(page, 'unknown-operation.flow.yml');
      await expect(flows.diagnostics.line('unknown-operation')).toBeVisible();

      await fs.promises.writeFile(flowFile, original.replace('refundOrder', 'getOrder'), 'utf8');

      await expect(flows.diagnostics.root()).toHaveCount(0);
      await expect(flows.run.button()).toBeEnabled();
    } finally {
      await fs.promises.writeFile(flowFile, original, 'utf8');
    }
  });

  test('U3.5a treats capture as a kind of run rather than a remembered setting', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    expect(workspaceFixturePath, 'the workspace fixture must be present').toBeTruthy();
    const captureRoot = path.join(workspaceFixturePath!, '.bruno-runs');

    const app = await restartApp({});
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

    const { flows } = buildCommonLocators(page);
    const runDirectories = async () => fs.promises.readdir(captureRoot).catch(() => [] as string[]);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');

    await test.step('Run writes to .bruno-runs/ on one click, with no capture control beside it', async () => {
      expect(await runDirectories()).toEqual([]);
      await expect(page.getByLabel(/capture/i)).toHaveCount(0);

      await runFlow(page);
      await expect(flows.run.status()).toHaveText('passed');
      expect(await runDirectories()).toHaveLength(1);
    });

    await test.step('Run without capture starts a run immediately that writes nothing', async () => {
      await startFlowRun(page, { capture: false });
      await waitForFlowRun(page);

      await expect(flows.run.status()).toHaveText('passed');
      expect(await runDirectories()).toHaveLength(1);
    });

    await test.step('and the next Run captures again', async () => {
      await runFlow(page);
      await expect.poll(runDirectories).toHaveLength(2);
    });

    await test.step('both halves are disabled while the flow has errors', async () => {
      await openFlow(page, 'unknown-operation.flow.yml');

      await expect(flows.run.button()).toBeDisabled();
      await expect(flows.run.options()).toHaveClass(/is-disabled/);
    });
  });

  test('U3.6 groups a library flow apart and asks for its params', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);

    await test.step('a flow declaring meta.library is listed under Libraries, without being opened first', async () => {
      await expect(flows.section.subgroup('libraries')).toHaveText('Libraries');
      await expect(flows.section.row('sign-in.flow.yml')).toBeVisible();

      const libraries = flows.section.subgroup('libraries');
      const ordinary = flows.section.row('linear.flow.yml');
      expect((await libraries.boundingBox())!.y, 'the label sits at the end of its scope\'s group')
        .toBeGreaterThan((await ordinary.boundingBox())!.y);
    });

    await test.step('and its run configuration shows the parameter inputs', async () => {
      await openFlow(page, 'sign-in.flow.yml');

      await expect(flows.graph.input('email')).toBeVisible();
      await expect(flows.graph.input('region')).toBeVisible();
      await flows.graph.input('email').fill('qa@example.com');
      await expect(flows.graph.input('email')).toHaveValue('qa@example.com');
    });
  });

  test('U3.6a lists and labels a flow by the name it declares', async ({ pageWithUserData: page }) => {
    const { flows, tabs } = buildCommonLocators(page);

    await openFlowsSection(page);

    await test.step('a flow declaring meta.name is listed under it and opens into a tab labelled with it', async () => {
      await expect(flows.section.rowName('linear.flow.yml')).toHaveText('Linear checkout');

      await openFlow(page, 'linear.flow.yml');
      await expect(tabs.requestTab('Linear checkout')).toBeVisible();
    });

    await test.step('and its raw editor tab is labelled by the filename', async () => {
      await flows.section.row('linear.flow.yml').hover();
      await flows.section.menuTrigger('linear.flow.yml').click();
      await flows.section.editYaml('linear.flow.yml').click();

      await expect(tabs.requestTab('linear.flow.yml')).toBeVisible();
    });
  });

  test('U3.6b offers the environment from the flow tab\'s own header', async ({ pageWithUserData: page }) => {
    const { flows, environment } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');

    await test.step('the header ends with the app\'s own environment dropdown, in its unselected state', async () => {
      await expect(flows.header.title()).toHaveText('API Flows');
      await expect(page.getByTestId('flow-environment')).toHaveClass(/no-environments/);
      await expect(page.getByTestId('flow-environment')).toContainText('No Environment');
    });

    await test.step('it offers the workspace\'s environments, and choosing one takes effect', async () => {
      await page.getByTestId('flow-environment').click();

      await expect(environment.listOption('Local')).toBeVisible();
      await expect(environment.listOption('Staging')).toBeVisible();

      await environment.listOption('Staging').click();
      await expect(page.getByTestId('flow-environment')).toContainText('Staging');
    });

    await test.step('and choosing no environment is offered, and takes effect', async () => {
      await page.getByTestId('flow-environment').click();
      await environment.listOption('No Environment').click();

      await expect(page.getByTestId('flow-environment')).toContainText('No Environment');
    });
  });

  test('U3.2 and U6.8 take a diagnostic, and a node, to the line they are about', async ({
    pageWithUserData: page
  }) => {
    const { flows, tabs } = buildCommonLocators(page);

    const source = await fs.promises.readFile(
      path.join(__dirname, 'fixtures', 'workspace', 'flows', 'unknown-operation.flow.yml'),
      'utf8'
    );
    const lines = source.split('\n');
    const stepLine = lines.findIndex((text) => text.includes('id: refund_order')) + 1;
    const firstStepLine = lines.findIndex((text) => text.includes('id: create_order')) + 1;

    await openFlowsSection(page);
    await openFlow(page, 'unknown-operation.flow.yml');

    await test.step('clicking the line a diagnostic names opens the editor on that line', async () => {
      await flows.diagnostics.anchor(stepLine).click();

      await expect(flows.yaml.pane()).toBeVisible();
      await expect.poll(() => flowYamlCursorLine(page)).toBe(stepLine);
    });

    await test.step('and clicking it again after the caret has moved goes back', async () => {
      await flows.yaml.editor().click();
      await page.keyboard.press('ControlOrMeta+Home');
      await expect.poll(() => flowYamlCursorLine(page)).toBe(1);

      await tabs.requestTab('Unknown operation').click();
      await flows.diagnostics.anchor(stepLine).click();

      await expect.poll(() => flowYamlCursorLine(page)).toBe(stepLine);
    });

    await test.step('in that editor, clicking a node scrolls the document to that step', async () => {
      await selectStep(page, 'create_order');

      await expect.poll(() => flowYamlCursorLine(page)).toBe(firstStepLine);
    });
  });

  test('U6.12 marks the line a diagnostic is about in the editor\'s gutter', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    const source = await fs.promises.readFile(
      path.join(__dirname, 'fixtures', 'workspace', 'flows', 'unknown-operation.flow.yml'),
      'utf8'
    );
    const stepLine = source.split('\n').findIndex((text) => text.includes('id: refund_order')) + 1;

    await openFlowsSection(page);
    await openFlowYamlEditor(page, 'unknown-operation.flow.yml');

    await test.step('the line the diagnostic names carries an error mark, saying what is on it', async () => {
      await expect(flows.yaml.gutterMarker(stepLine)).toBeVisible();
      await expect(flows.yaml.gutterMarker(stepLine)).toHaveAttribute('data-severity', 'error');
      await expect(flows.yaml.gutterMarker(stepLine)).toHaveAttribute('title', /unknown-operation/);
    });

    await test.step('and clicking it takes the caret there, as §6\'s list does', async () => {
      // From the top of the file, so the caret's arrival is the mark's doing rather than where the
      // editor happened to already be — the tab outlives a test.
      await flows.yaml.editor().click();
      await page.keyboard.press('ControlOrMeta+Home');
      await expect.poll(() => flowYamlCursorLine(page)).toBe(1);

      await flows.yaml.gutterMarker(stepLine).click();

      await expect.poll(() => flowYamlCursorLine(page)).toBe(stepLine);
    });
  });

  test.fixme(
    'U6.8 states a diagnostic that names no position without offering it as a link — missing fixture: the engine positions every diagnostic these flows can produce',
    async () => {
      // `DiagnosticLine` draws the `line N` control only for a diagnostic carrying one, so the rule
      // is implemented; what is missing is a diagnostic that lacks a position. U6.8 names two — a
      // bad `apis:` binding and a scope-root escape — and the engine anchors both at the binding's
      // own line in the `apis:` block, which is better than the scenario assumed. Until some
      // diagnostic arrives without a position there is nothing for this to be about.
    }
  );

  test('U3.6 blocks the run on a required param left empty', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'sign-in.flow.yml');

    // The params live in the slice keyed by the flow's path and the renderer outlives a test, so the
    // empty box is established here rather than assumed — U3.6 above types into this same one.
    await expect(flows.graph.input('email')).toBeVisible();
    await flows.graph.input('email').fill('');

    await test.step('the control refuses the run and names the param it is waiting on', async () => {
      // 001 §12.5 refuses such a run before `run:start`, so the click would only ever reach a
      // refusal the panel beside the control could already state. `region` is required: false with
      // a default and is not part of it.
      await expect(flows.run.button()).toBeDisabled();
      await expect(flows.run.button()).toHaveAttribute('title', 'No value for the required param email');
      await expect(flows.run.options()).toHaveClass(/is-disabled/);
    });

    await test.step('and offers it once the value has been typed', async () => {
      await flows.graph.input('email').fill('qa@example.com');

      await expect(flows.run.button()).toBeEnabled();
      await expect(flows.run.options()).not.toHaveClass(/is-disabled/);
    });
  });

  test.fixme(
    'U3.6c lists a run\'s own diagnostics — missing hook: no way to fail one attempt\'s capture write from a spec',
    async () => {
      // §9's pane now says "This step ran, but its capture was not written", and the tab lists
      // `run.diagnostics`, so both surfaces exist. What the scenario needs is a run in which exactly
      // one attempt's write fails: 001 §14.5 makes an unwritable *capture root* fail `start()`
      // instead — deliberately, so a run does not quietly produce no record — and the per-step
      // directories are named from a timestamp and a run id, so nothing can be made unwritable
      // ahead of time. Racing a chmod against a `wait-for` step is the only route, and a run whose
      // diagnostics depend on winning that race is not a test.
    }
  );
});
