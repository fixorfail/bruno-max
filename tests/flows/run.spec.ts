import { test, expect } from '../../playwright';
import {
  addVariableOverride,
  buildCommonLocators,
  cancelFlowRun,
  flowNodeStates,
  openFlow,
  openFlowYamlEditor,
  openFlowsSection,
  openRunConfiguration,
  openStepDetail,
  openStepTab,
  requestFlowCancel,
  runFlow,
  selectStep,
  startFlowRun,
  waitForFlowRun
} from '../utils/page';

/**
 * 002-C §4 — U2: a live run.
 *
 * The engine decides what happens; these assert that the graph shows it — that two branches are in
 * flight at once, that a poll reads as a poll rather than as a hang, that the four skip reasons stay
 * four different things, and that a cancel is not a failure.
 */
test.describe('U2 — a live run', () => {
  // Every test here runs a real flow against `bruno-tests`, and several of them deliberately hold a
  // step in flight with `wait-for` so a concurrency, a poll or a cancel can be observed. That work
  // is genuinely long, on top of an Electron launch — it is not a masked flake.
  test.describe.configure({ timeout: 90_000 });

  test('U2.1 advances steps in dependency order', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'sequential.flow.yml');

    await test.step('no node enters running before its parents are terminal', async () => {
      await startFlowRun(page);
      await expect(flows.graph.node('wait_left')).toHaveAttribute('data-status', 'running');

      // Read every node in one pass: the waiting steps hold the run for a few seconds and the states
      // are a single claim about that moment, not four claims about four of them. `rejoin` waits on
      // both of them, so it is the one whose turn has demonstrably not come.
      expect(await flowNodeStates(page)).toEqual({
        create_order: 'success',
        wait_left: 'running',
        wait_right: 'running',
        rejoin: 'pending'
      });
    });

    await test.step('and each node ends success', async () => {
      await waitForFlowRun(page);

      expect(await flowNodeStates(page)).toEqual({
        create_order: 'success',
        wait_left: 'success',
        wait_right: 'success',
        rejoin: 'success'
      });
    });
  });

  test('U2.2 shows concurrent branches in flight together', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'parallel.flow.yml');

    await startFlowRun(page);

    await expect(flows.graph.node('wait_left')).toHaveAttribute('data-status', 'running');
    await expect(flows.graph.node('wait_right')).toHaveAttribute('data-status', 'running');

    await waitForFlowRun(page);
  });

  test('U2.3 shows a poll\'s attempts, and settles it to success', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'polling.flow.yml');

    await startFlowRun(page);

    await test.step('the node counts its attempts while it polls', async () => {
      await expect(flows.graph.nodeAttempts('settle_order')).toHaveText(/attempt \d\/10/);
    });

    await test.step('and carries the in-flight halo in the retry colour throughout', async () => {
      await expect(flows.graph.node('settle_order')).toHaveAttribute('data-status', 'retrying');
      await expect(flows.graph.nodeHalo('settle_order')).toBeAttached();
    });

    await test.step('the step detail\'s spinner turns for the whole poll', async () => {
      await selectStep(page, 'settle_order');
      await expect(flows.detail.inFlight()).toBeVisible();
    });

    await test.step('and it settles to success rather than to retries-exhausted', async () => {
      await waitForFlowRun(page);

      await expect(flows.graph.node('settle_order')).toHaveAttribute('data-status', 'success');
      await expect(flows.graph.nodeStatus('settle_order')).toHaveText('success');
      await expect(flows.graph.nodeAttempts('settle_order')).toHaveCount(0);
      await expect(flows.detail.inFlight()).toHaveCount(0);
    });
  });

  test('U2.4 distinguishes each skip reason', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'skips.flow.yml');

    await startFlowRun(page);

    await test.step('the three reasons a run reaches on its own are each shown as themselves', async () => {
      await expect(flows.graph.nodeStatus('skipped_by_condition')).toHaveText('skipped · condition-false');
      await expect(flows.graph.nodeStatus('skipped_by_parent')).toHaveText('skipped · unmet-dependency');
      await expect(flows.graph.nodeStatus('skipped_unresolved')).toHaveText('skipped · unresolved-dependency');
    });

    await test.step('and unmet-dependency is not presented as a failure', async () => {
      await expect(flows.graph.node('skipped_by_parent')).toHaveAttribute('data-status', 'skipped');
      await expect(flows.graph.node('failing_step')).toHaveAttribute('data-status', 'failed');
    });

    await test.step('and the fourth — a step the run never reached — reads run-cancelled', async () => {
      await expect(flows.graph.node('slow_step')).toHaveAttribute('data-status', 'running');
      await cancelFlowRun(page);

      await expect(flows.graph.nodeStatus('never_reached')).toHaveText('skipped · run-cancelled');
      await expect(flows.graph.node('never_reached')).toHaveAttribute('data-status', 'skipped');
    });
  });

  test('U2.4a names the reference an unresolved-dependency never got, and U2.4b marks it on its edge', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');
    await runFlow(page);

    await test.step('the run is failed while no node is red', async () => {
      await expect(flows.run.status()).toHaveText('failed');
      await expect(flows.graph.allNodes().filter({ has: page.locator('[data-status="failed"]') })).toHaveCount(0);
    });

    await test.step('hovering the skipped node names the reference that was never produced', async () => {
      await expect(flows.graph.nodeTitle('archive_receipt')).toContainText(
        'never produced: steps.book_shipment.trackingId'
      );
    });

    await test.step('and selecting it shows the same message above the step detail\'s tabs', async () => {
      await selectStep(page, 'archive_receipt');
      await expect(flows.detail.message()).toContainText('never produced: steps.book_shipment.trackingId');
    });

    await test.step('U2.4b marks the data edge the value should have travelled', async () => {
      await expect(flows.graph.edgeMark('data', 'book_shipment', 'archive_receipt')).toHaveText('✗');
      await expect(flows.graph.edgeTitle('data', 'book_shipment', 'archive_receipt')).toContainText(
        'never produced: steps.book_shipment.trackingId'
      );
    });

    await test.step('and leaves the second data edge into the same consumer unmarked', async () => {
      await expect(flows.graph.edgeMark('data', 'create_order', 'archive_receipt')).toHaveCount(0);
      await expect(flows.graph.edge('data', 'create_order', 'archive_receipt')).not.toHaveClass(/edge-unproduced/);
    });
  });

  test('U2.4c names the step the verdict fell on, and opens the step detail on it', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');
    await runFlow(page);

    await test.step('the summary reads failed beside 0 failed, and names the cause', async () => {
      await expect(flows.run.status()).toHaveText('failed');
      await expect(flows.run.summary()).toContainText('0 failed');
      await expect(flows.run.cause('archive_receipt')).toBeVisible();
    });

    await test.step('clicking it opens the step detail on that step', async () => {
      await flows.run.cause('archive_receipt').click();

      await expect(flows.detail.step()).toHaveText('archive_receipt');
      await expect(flows.detail.status()).toHaveText('skipped · unresolved-dependency');
      await expect(flows.graph.node('archive_receipt')).toHaveClass(/selected/);
    });

    await test.step('and a passing run names no cause at all', async () => {
      await openFlow(page, 'linear.flow.yml');
      await runFlow(page);

      await expect(flows.run.status()).toHaveText('passed');
      await expect(flows.run.summary().locator('.run-cause')).toHaveCount(0);
    });
  });

  test('U2.11 reports the flow in flow vocabulary and the steps in step vocabulary', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');
    await runFlow(page);

    await test.step('a fully green run reports passed, and no step reports passed', async () => {
      await expect(flows.run.status()).toHaveText('passed');

      const states = await flowNodeStates(page);
      expect(Object.values(states)).toEqual(['success', 'success', 'success']);
      expect(Object.values(states)).not.toContain('passed');
    });

    await test.step('a run with one failed step reports failed on both, in each one\'s own words', async () => {
      await openFlow(page, 'skips.flow.yml');
      await startFlowRun(page);

      await expect(flows.graph.node('failing_step')).toHaveAttribute('data-status', 'failed');
      await expect(flows.graph.nodeStatus('failing_step')).toHaveText('failed · unexpected-status');

      await cancelFlowRun(page);
    });
  });

  test('U2.8 keeps a run going when its tab is closed', async ({ pageWithUserData: page }) => {
    const { flows, tabs } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'parallel.flow.yml');
    await startFlowRun(page);

    await expect(flows.graph.node('wait_left')).toHaveAttribute('data-status', 'running');

    await test.step('closing the tab does not cancel the run', async () => {
      await tabs.closeTab('Parallel branches').click({ force: true });
      await expect(tabs.requestTab('Parallel branches')).toHaveCount(0);
    });

    await test.step('and reopening the flow shows the run, still in progress or completed', async () => {
      await openFlow(page, 'parallel.flow.yml');
      await waitForFlowRun(page);

      await expect(flows.run.status()).toHaveText('passed');
      expect(await flowNodeStates(page)).toEqual({
        create_order: 'success',
        wait_left: 'success',
        wait_right: 'success',
        rejoin: 'success'
      });
    });
  });

  test('U2.5 stops a poll where it is, and leaves the run cancelled rather than failed', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'cancel.flow.yml');

    await startFlowRun(page);

    // A poll's delay is where a run spends nearly all of its time (001 §11.1 allows 30 seconds of
    // it), so this is the moment a cancel has to act on rather than at the end of the sleep. The
    // second attempt is what says the first delay has elapsed and the step is polling.
    await expect(flows.graph.node('poll_settlement')).toHaveAttribute('data-status', 'retrying');

    const cancelledAt = Date.now();
    await cancelFlowRun(page);

    await test.step('the run stops during the delay rather than when it would have elapsed', async () => {
      // The fixture's delay is 3000ms and the cancel lands just after an attempt returned, so a run
      // that served out the sleep could not be back inside it.
      expect(Date.now() - cancelledAt).toBeLessThan(3000);
    });

    await test.step('the node that was polling ends cancelled', async () => {
      await expect(flows.graph.node('poll_settlement')).toHaveAttribute('data-status', 'cancelled');
      await expect(flows.graph.nodeStatus('poll_settlement')).toHaveText('cancelled · run-cancelled');
    });

    await test.step('the node the run never reached reads run-cancelled, which is a skip', async () => {
      await expect(flows.graph.node('after_poll')).toHaveAttribute('data-status', 'skipped');
      await expect(flows.graph.nodeStatus('after_poll')).toHaveText('skipped · run-cancelled');
    });

    await test.step('and the flow\'s own status word is cancelled, not failed', async () => {
      await expect(flows.run.status()).toHaveText('cancelled');
    });
  });

  test(
    'U2.6 and U6.5 show the cleanup state while a cancelled-accepting step runs',
    async ({ pageWithUserData: page }) => {
      const { flows } = buildCommonLocators(page);

      // The window is observable here because the cleanup step's request is bounded by 001 §11.3's
      // grace rather than by the run's own signal: `release_hold` holds the response for two
      // seconds, so §7.1's cleanup state is on screen rather than passed through.
      await openFlowsSection(page);
      await openFlow(page, 'cleanup.flow.yml');

      await startFlowRun(page);
      await expect(flows.graph.node('poll_settlement')).toHaveAttribute('data-status', 'retrying');

      await requestFlowCancel(page);

      await test.step('the control stops offering Cancel and says it is cleaning up', async () => {
        await expect(flows.run.cleanup()).toBeVisible();
        await expect(flows.run.cleanup()).toContainText('Cleaning up');
        await expect(flows.run.cancel()).toHaveCount(0);
        await expect(flows.run.button()).toHaveCount(0);
      });

      await test.step('the cleanup step runs, and completes', async () => {
        await expect(flows.graph.node('release_hold')).toHaveAttribute('data-status', 'running');

        await waitForFlowRun(page);
        await expect(flows.graph.node('release_hold')).toHaveAttribute('data-status', 'success');
      });

      await test.step('and the run ends cancelled with the control back to Run', async () => {
        await expect(flows.graph.node('poll_settlement')).toHaveAttribute('data-status', 'cancelled');
        await expect(flows.run.status()).toHaveText('cancelled');
        await expect(flows.run.button()).toBeEnabled();
        await expect(flows.run.cleanup()).toHaveCount(0);
      });
    }
  );

  test('U2.5 ends a `wait-for` step that was in flight as cancelled', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'sequential.flow.yml');

    await startFlowRun(page);

    // Both branches hold a response for three seconds, so the cancel lands on requests that are
    // genuinely on the wire — the other half of 001 §11.3, where the case above lands in a delay.
    await expect(flows.graph.node('wait_left')).toHaveAttribute('data-status', 'running');
    await expect(flows.graph.node('wait_right')).toHaveAttribute('data-status', 'running');

    await cancelFlowRun(page);

    await test.step('the interrupted requests read as cancelled rather than as failures', async () => {
      await expect(flows.graph.node('wait_left')).toHaveAttribute('data-status', 'cancelled');
      await expect(flows.graph.nodeStatus('wait_left')).toHaveText('cancelled · run-cancelled');
      await expect(flows.graph.node('wait_right')).toHaveAttribute('data-status', 'cancelled');
    });

    await test.step('the step below them is a skip, and the run itself is cancelled', async () => {
      await expect(flows.graph.node('rejoin')).toHaveAttribute('data-status', 'skipped');
      await expect(flows.graph.nodeStatus('rejoin')).toHaveText('skipped · run-cancelled');
      await expect(flows.run.status()).toHaveText('cancelled');
    });

    await test.step('and the step that had already settled keeps its verdict', async () => {
      await expect(flows.graph.node('create_order')).toHaveAttribute('data-status', 'success');
    });
  });

  test('U2.7 keeps each iteration of a dataset run independent, and U6.6 shows all of them at once', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'dataset.flow.yml');

    await startFlowRun(page);

    await test.step('U6.6 a chip per row, more than one of them running at a time', async () => {
      await expect(flows.iterations.strip()).toBeVisible();
      await expect(flows.iterations.chip(0)).toHaveAttribute('data-status', 'running');
      await expect(flows.iterations.chip(1)).toHaveAttribute('data-status', 'running');
      await expect(flows.iterations.chip(2)).toHaveAttribute('data-status', 'running');
    });

    await waitForFlowRun(page);

    await test.step('each finished row carries its own outcome word', async () => {
      await expect(flows.iterations.chip(0)).toHaveAttribute('data-status', 'passed');
      await expect(flows.iterations.chip(1)).toHaveAttribute('data-status', 'failed');
      await expect(flows.iterations.chip(2)).toHaveAttribute('data-status', 'passed');
    });

    await test.step('U2.7 the graph draws one row at a time, and the failing row leaves the others passing', async () => {
      await expect(flows.toolbar.iteration()).toBeVisible();

      await flows.iterations.chip(0).click();
      await expect(flows.toolbar.iteration()).toHaveValue('0');
      expect(await flowNodeStates(page)).toEqual({ hold_open: 'success', create_order: 'success' });

      await flows.iterations.chip(1).click();
      await expect(flows.toolbar.iteration()).toHaveValue('1');
      expect(await flowNodeStates(page)).toEqual({ hold_open: 'success', create_order: 'failed' });
      await expect(flows.graph.nodeStatus('create_order')).toHaveText('failed · assertion-failed');

      await flows.iterations.chip(2).click();
      await expect(flows.toolbar.iteration()).toHaveValue('2');
      expect(await flowNodeStates(page)).toEqual({ hold_open: 'success', create_order: 'success' });
    });

    await test.step('and the selector draws the row it is set to', async () => {
      // By position: the rows are labelled from 1, so every option's label is the value of the one
      // before it and selecting by either string picks the wrong row half the time.
      await flows.toolbar.iteration().selectOption({ index: 1 });

      await expect(flows.toolbar.iteration()).toHaveValue('1');
      await expect(flows.graph.node('create_order')).toHaveAttribute('data-status', 'failed');
    });
  });

  test('U6.1 carries a variable override and a named dataset into the run', async ({ pageWithUserData: page }) => {
    const { flows, environment } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'overrides.flow.yml');

    await test.step('without an override the run resolves the environment\'s own value', async () => {
      await page.getByTestId('flow-environment').click();
      await environment.listOption('Staging').click();

      await runFlow(page);
      await openStepDetail(page, 'create_order');
      await openStepTab(page, 'request');
      await expect(flows.detail.body('request')).toContainText('staging');
    });

    await test.step('an override takes precedence over the tier that defined it', async () => {
      await openRunConfiguration(page);
      await addVariableOverride(page, 'region', 'override-eu');
      // A row nobody has typed a name into is a row somebody is still filling, not an override of
      // the empty string — so it is added and left blank, and the run below must be unaffected.
      await flows.configuration.addOverride().click();

      // The step stays selected across the run — §9's pane re-reads on the new run's captures, so
      // clicking it again would clear the selection rather than refresh it (U4.1a).
      await runFlow(page);
      await openStepTab(page, 'request');
      await expect(flows.detail.body('request')).toContainText('override-eu');
      await expect(flows.run.status()).toHaveText('passed');
    });

    await test.step('and a named dataset iterates that file rather than the one the flow declares', async () => {
      await openRunConfiguration(page);
      await flows.configuration.dataset().fill('./fixtures/orders.csv');

      await runFlow(page);

      // The flow declares no `dataset:` at all, so three iterations is the file being read.
      await expect(flows.iterations.chip(2)).toBeVisible();
      await expect(flows.toolbar.iteration().locator('option')).toHaveCount(3);
    });
  });

  test('U6.7 says how much ran and how long it took', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');
    await runFlow(page);

    await expect(flows.run.total()).toHaveText('3 steps');
    await expect(flows.run.summary()).toContainText('3 passed');
    await expect(flows.run.summary()).toContainText('0 failed');
    await expect(flows.run.summary()).toContainText('0 skipped');
    await expect(flows.run.summary()).toContainText('0 cancelled');
    await expect(flows.run.status()).toHaveText('passed');

    // 001 §13.2's `RunResult.duration`, not a stopwatch the view started — which is why a run that
    // recorded none shows nothing here rather than a zero (U4.5).
    await expect(flows.run.elapsed()).toHaveText(/^\d+(\.\d+)?s$|^\d+m \d+s$/);
  });

  test('U6.4 carries the run mark on the tab and the sidebar row, and clears both when the flow is opened', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'skips.flow.yml');
    await startFlowRun(page);
    // The fixture's slow step holds the run open for the rest of this step; waiting for it is what
    // makes the marks below a claim about a run in flight rather than about one that may not have
    // reached the view yet.
    await expect(flows.graph.node('slow_step')).toHaveAttribute('data-status', 'running');

    await test.step('a running indicator stands on the tab and the row while the run executes', async () => {
      // Read from another tab: a mark on the tab you are looking at is the case that needed no mark.
      await openFlowYamlEditor(page, 'skips.flow.yml');

      await expect(flows.tabMark('Skip reasons')).toHaveAttribute('data-status', 'running');
      await expect(flows.section.rowRunMark('skips.flow.yml')).toHaveClass(/running/);
    });

    await test.step('§4.3\'s raw editor tab carries no mark at any point', async () => {
      await expect(flows.tabMark('skips.flow.yml')).toHaveCount(0);
    });

    await test.step('and it becomes a fail mark when the run ends red', async () => {
      await expect(flows.tabMark('Skip reasons')).toHaveAttribute('data-status', 'failed', { timeout: 30000 });
      await expect(flows.section.rowRunMark('skips.flow.yml')).toHaveClass(/failed/);
    });

    await test.step('opening the flow clears both', async () => {
      await openFlow(page, 'skips.flow.yml');

      await expect(flows.tabMark('Skip reasons')).toHaveCount(0);
      await expect(flows.section.rowRunMark('skips.flow.yml')).toHaveCount(0);
    });

    await test.step('and running it again brings them back', async () => {
      await startFlowRun(page);
      await openFlowYamlEditor(page, 'skips.flow.yml');

      await expect(flows.tabMark('Skip reasons')).toHaveAttribute('data-status', 'failed', { timeout: 30000 });
      await expect(flows.section.rowRunMark('skips.flow.yml')).toHaveClass(/failed/);
    });
  });

  test('U2.10 keeps a run visible in the sidebar with no tab open', async ({ pageWithUserData: page }) => {
    const { flows, tabs } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'skips.flow.yml');
    await startFlowRun(page);
    await expect(flows.graph.node('slow_step')).toHaveAttribute('data-status', 'running');

    await test.step('closing the tab leaves the row showing the run in progress', async () => {
      await tabs.closeTab('Skip reasons').click({ force: true });
      await expect(tabs.requestTab('Skip reasons')).toHaveCount(0);

      await expect(flows.section.rowRunMark('skips.flow.yml')).toHaveClass(/running/);
    });

    await test.step('and the row carries the failure mark once the run ends red', async () => {
      await expect(flows.section.rowRunMark('skips.flow.yml')).toHaveClass(/failed/, { timeout: 30000 });
    });

    await test.step('reopening the flow clears it', async () => {
      await openFlow(page, 'skips.flow.yml');
      await expect(flows.section.rowRunMark('skips.flow.yml')).toHaveCount(0);
    });
  });
});
