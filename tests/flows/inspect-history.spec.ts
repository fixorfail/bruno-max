import * as path from 'path';
import { test, expect } from '../../playwright';
import {
  buildCommonLocators,
  flowNodeStates,
  installStoredRuns,
  openFlow,
  openFlowsSection,
  openStepDetail,
  openStepTab,
  runFlow,
  selectStep
} from '../utils/page';

/**
 * 002-C §6 — U4: inspection and history.
 *
 * §9's pane reads captures rather than events, and §10 opens a stored run into the same view a live
 * one uses. The stored half runs against a committed `.bruno-runs/` written by `bru flow run`, which
 * makes these a regression test on 001 §14.5's layout as well as on the app.
 */
const STORED_RUNS = path.join(__dirname, 'fixtures', 'runs');

test.describe('U4 — inspection and history', () => {
  // The history cases install a capture directory and restart the app so it is bound to their own
  // copy of the workspace; the inspection ones run a flow end to end first.
  test.describe.configure({ timeout: 90_000 });

  test('U4.1 opens a step on its materialized request and its response', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');
    await runFlow(page);

    await selectStep(page, 'create_order');

    await test.step('the request tab shows the request as it was materialized', async () => {
      await openStepTab(page, 'request');

      await expect(flows.detail.row('Method')).toContainText('POST');
      await expect(flows.detail.row('URL')).toContainText('http://localhost:8081/api/echo/json');
    });

    await test.step('including a value seeded from the OpenAPI document that the flow file never mentions', async () => {
      await expect(flows.detail.body('request')).toContainText('web-checkout');
    });

    await test.step('a step declaring no headers of its own still shows the ones it sent', async () => {
      await expect(flows.detail.headers()).toContainText('Headers');
      await expect(flows.detail.headers()).toContainText(/content-type/i);
      await expect(flows.detail.headers()).toContainText('application/json');
    });

    await test.step('the response tab shows status, headers and body', async () => {
      await openStepTab(page, 'response');

      await expect(flows.detail.row('Status')).toContainText('200');
      await expect(flows.detail.headers()).toContainText('content-type');
      await expect(flows.detail.body('response')).toContainText('web-checkout');
    });

    await test.step('including the Authorization an auth profile produced, which the flow never wrote', async () => {
      await selectStep(page, 'read_order');
      await openStepTab(page, 'request');

      await expect(flows.detail.headers()).toContainText(/authorization/i);

      await selectStep(page, 'create_order');
    });

    await test.step('and both bodies are visible rather than merely present in the DOM', async () => {
      await openStepTab(page, 'response');
      const response = await flows.detail.body('response').boundingBox();
      expect(response!.height, 'the response body has a rendered box').toBeGreaterThan(0);
      expect(response!.width).toBeGreaterThan(0);

      await openStepTab(page, 'request');
      const request = await flows.detail.body('request').boundingBox();
      expect(request!.height, 'the request body has a rendered box').toBeGreaterThan(0);
      expect(request!.width).toBeGreaterThan(0);
    });
  });

  test('U4.1a clears the selection when the selected step is clicked again', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');
    await runFlow(page);

    await selectStep(page, 'create_order');
    await expect(flows.detail.root()).toBeVisible();
    await expect(flows.graph.node('create_order')).toHaveClass(/selected/);

    await test.step('clicking a different node moves the selection rather than clearing it', async () => {
      await selectStep(page, 'read_order');

      await expect(flows.detail.step()).toHaveText('read_order');
      await expect(flows.graph.node('create_order')).not.toHaveClass(/selected/);
    });

    await test.step('clicking the selected node closes the pane and leaves nothing selected', async () => {
      await selectStep(page, 'read_order');

      await expect(flows.detail.root()).toHaveCount(0);
      await expect(flows.graph.allNodes().locator('.selected')).toHaveCount(0);

      // The pointer is still over the node it just deselected, and §5.3's focus answers to a hover
      // as well as to a selection — so the dimming is asked about from off the drawing.
      await page.mouse.move(0, 0);
      await expect(flows.graph.root()).not.toHaveAttribute('data-focus', /.+/);
      await expect(flows.graph.dimmed()).toHaveCount(0);
    });
  });

  test('U4.4 lists a step\'s declared outputs on the response tab, directly above the body', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');
    await runFlow(page);

    await selectStep(page, 'create_order');
    await openStepTab(page, 'response');

    await test.step('each declared output is listed with the value extracted for it', async () => {
      await expect(flows.detail.outputs()).toContainText('Outputs');
      await expect(flows.detail.outputs()).toContainText('orderId');
      await expect(flows.detail.outputs()).toContainText('ord_1');
    });

    await test.step('with nothing between the outputs and the body', async () => {
      const outputs = await flows.detail.outputs().boundingBox();
      const body = await flows.detail.body('response').boundingBox();

      expect(outputs!.y).toBeLessThan(body!.y);
      await expect(
        flows.detail.outputs().locator('xpath=following-sibling::*[1]')
      ).toHaveAttribute('data-testid', 'flow-step-body-response');
    });

    await test.step('and it appears on no other tab', async () => {
      await openStepTab(page, 'request');
      await expect(flows.detail.outputs()).toHaveCount(0);

      await openStepTab(page, 'assertions');
      await expect(flows.detail.outputs()).toHaveCount(0);
    });
  });

  test('U4.5 opens a stored run into the same view, U4.6 unchanged, and U4.7 lists only its own flow\'s runs', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    expect(workspaceFixturePath, 'the workspace fixture must be present').toBeTruthy();
    // Placed as if downloaded from a build artifact: the committed directory is copied in whole and
    // nothing about its layout is rewritten.
    await installStoredRuns(STORED_RUNS, workspaceFixturePath!);

    const app = await restartApp({});
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');

    await test.step('U4.7 the selector lists this flow\'s run and no other flow\'s', async () => {
      await expect(flows.toolbar.runSelector().locator('option')).toHaveCount(2);
      await expect(flows.toolbar.runSelector().locator('option').nth(0)).toHaveText('current');
      await expect(flows.toolbar.runSelector().locator('option').nth(1)).toContainText('passed · 3/3');
    });

    await test.step('opening it renders the same graph and the same node states', async () => {
      await flows.toolbar.runSelector().selectOption({ index: 1 });

      await expect(flows.run.status()).toHaveText('passed');
      expect(await flowNodeStates(page)).toEqual({
        create_order: 'success',
        read_order: 'success',
        audit_order: 'success'
      });
      await expect(flows.toolbar.runOrigin()).toContainText('cli');
    });

    await test.step('and a run recorded before RunResult.duration existed shows no elapsed time', async () => {
      // The committed summary carries no `duration`. Nothing is drawn for it rather than a zero,
      // which would claim the run took no time at all (U6.7).
      await expect(flows.run.total()).toHaveText('3 steps');
      await expect(flows.run.elapsed()).toHaveCount(0);
    });

    await test.step('and the step detail reads the captures the run wrote', async () => {
      await selectStep(page, 'create_order');
      await openStepTab(page, 'request');
      await expect(flows.detail.row('URL')).toContainText('/api/echo/json');

      await openStepTab(page, 'response');
      await expect(flows.detail.body('response')).toContainText('web-checkout');
    });

    await test.step('including a polled step\'s individual attempts', async () => {
      await openFlow(page, 'polling.flow.yml');
      await flows.toolbar.runSelector().selectOption({ index: 1 });

      await selectStep(page, 'settle_order');
      await expect(flows.detail.attempt()).toBeVisible();
      await expect(flows.detail.attempt().locator('option')).toHaveCount(3);

      await openStepTab(page, 'response');
      await expect(flows.detail.body('response')).toContainText('settled');

      await flows.detail.attempt().selectOption('1');
      await expect(flows.detail.body('response')).toContainText('pending');
    });
  });

  test('U4.8 lists an interrupted run and opens it without claiming an outcome', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    expect(workspaceFixturePath, 'the workspace fixture must be present').toBeTruthy();
    await installStoredRuns(STORED_RUNS, workspaceFixturePath!);

    const app = await restartApp({});
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'skips.flow.yml');

    await test.step('the run with no summary.json appears for its flow, marked interrupted', async () => {
      await expect(flows.toolbar.runSelector().locator('option')).toHaveCount(2);
      await expect(flows.toolbar.runSelector().locator('option').nth(1)).toContainText('interrupted');
    });

    await test.step('and opening it shows the steps that completed and no overall status', async () => {
      await flows.toolbar.runSelector().selectOption({ index: 1 });

      // No summary was ever written, so nothing claims an outcome for the run — not `failed`, not
      // `cancelled`.
      await expect(flows.run.summary()).toHaveCount(0);

      // The steps that completed before the process died are drawn as steps this run reached; the
      // ones it never got to are not.
      await expect(flows.graph.nodeStatus('create_order')).not.toHaveText('');
      await expect(flows.graph.nodeStatus('failing_step')).not.toHaveText('');
      await expect(flows.graph.nodeStatus('never_reached')).toHaveText('');
      await expect(flows.graph.node('never_reached')).toHaveAttribute('data-status', 'pending');
    });
  });

  test('U4.11 reaches the raw editor from the row menu, as its own tab', async ({ pageWithUserData: page }) => {
    const { flows, tabs } = buildCommonLocators(page);

    await openFlowsSection(page);

    await test.step('the row menu holds Edit Yaml, and it opens a tab showing the flow\'s text', async () => {
      await flows.section.row('linear.flow.yml').hover();
      await flows.section.menuTrigger('linear.flow.yml').click();
      await expect(flows.section.editYaml('linear.flow.yml')).toHaveText('Edit Yaml');

      await flows.section.editYaml('linear.flow.yml').click();

      await expect(flows.yaml.pane()).toBeVisible();
      await expect(flows.yaml.editor()).toContainText('version: 1');
    });

    await test.step('its tab is marked with an italic file name, and the graph is above the text', async () => {
      await expect(tabs.requestTab('linear.flow.yml')).toBeVisible();
      await expect(tabs.requestTab('linear.flow.yml').locator('.italic')).toBeVisible();

      const graph = await flows.graph.root().boundingBox();
      const editor = await flows.yaml.editor().boundingBox();
      expect(graph!.y).toBeLessThan(editor!.y);
    });

    await test.step('and the row itself still opens the run view, as a second tab', async () => {
      await openFlow(page, 'linear.flow.yml');

      await expect(tabs.requestTab('Linear checkout')).toBeVisible();
      await expect(tabs.requestTab('linear.flow.yml')).toBeVisible();
    });
  });

  test('U4.18 folds a flow\'s directory into the sidebar', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);

    await test.step('the folder row is listed and nothing inside it is', async () => {
      await expect(flows.section.folder('company')).toBeVisible();
      await expect(flows.section.row('company/create-company.flow.yml')).toHaveCount(0);

      const folder = await flows.section.folder('company').boundingBox();
      const flow = await flows.section.row('linear.flow.yml').boundingBox();
      expect(folder!.y, 'folders sit above the flows beside them').toBeLessThan(flow!.y);
    });

    await test.step('opening it reveals what is inside, and clicking again closes it', async () => {
      await flows.section.folder('company').click();
      await expect(flows.section.row('company/create-company.flow.yml')).toBeVisible();

      await flows.section.folder('company').click();
      await expect(flows.section.row('company/create-company.flow.yml')).toHaveCount(0);
    });

    await test.step('a nested flow opens exactly as a top-level one does', async () => {
      await flows.section.folder('company').click();
      await openFlow(page, 'company/create-company.flow.yml');

      await expect(flows.graph.node('create_company')).toBeVisible();
      await expect(flows.section.menuTrigger('company/create-company.flow.yml')).toBeAttached();
    });

    await test.step('and the scripts and fixtures fold under their own labels', async () => {
      await expect(flows.section.subgroup('scripts')).toHaveText('Scripts');
      await expect(flows.section.subgroup('fixtures')).toHaveText('Fixtures');
      await expect(flows.section.row('helpers.js')).toBeVisible();
      await expect(flows.section.row('rows.csv')).toBeVisible();
    });
  });

  test('U4.10 degrades a capture-disabled run honestly, and only its own two tabs', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');
    await runFlow(page, { capture: false });
    await expect(flows.run.status()).toHaveText('passed');

    await openStepDetail(page, 'create_order');

    await test.step('the request and response tabs say the run captured nothing', async () => {
      await openStepTab(page, 'request');
      await expect(flows.detail.absence()).toHaveText('Captures were disabled for this run');
      await expect(flows.detail.body('request')).toHaveCount(0);

      await openStepTab(page, 'response');
      await expect(flows.detail.absence()).toHaveText('Captures were disabled for this run');
    });

    await test.step('the outcomes that arrive in StepResult still render', async () => {
      // Outputs come with the step's result rather than out of the capture, so the run with least
      // else to show is not also the one that loses them.
      await expect(flows.detail.outputs()).toContainText('orderId');

      await openStepTab(page, 'assertions');
      await expect(flows.detail.assertionRow('res.status eq 200')).toBeVisible();
      await expect(flows.detail.absence()).toHaveCount(0);

      await openStepTab(page, 'validation');
      await expect(flows.detail.absence()).toHaveCount(0);
    });
  });

  test.fixme(
    'U4.10 leaves a finished run\'s captures alone when capture is turned off for the next one — missing hook: §7.1 removed the setting this asks to be changed',
    async () => {
      // The converse half of U4.10 has the reader open a step's request on a captured run and *then*
      // uncheck capture, asserting what is on screen is unaffected. U3.5a is the decision that made
      // that ungestureable: capture is a kind of run, chosen on the control, and there is no box to
      // uncheck between two runs. The property it was protecting — that the pane reads the run's own
      // capture directory rather than a setting for the next run — has no control left to falsify it
      // with from the UI.
    }
  );
});
