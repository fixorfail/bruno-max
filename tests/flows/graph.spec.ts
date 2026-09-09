import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../playwright';
import { buildCommonLocators, openFlow, openFlowsSection, selectStep } from '../utils/page';

/**
 * 002-C §3 — U1: the graph reads correctly.
 *
 * Nothing here runs a flow. What is under test is the drawing the description produces: which edges
 * exist and what `rank` each node gets are 001-C's (002-C §9), and these assert that a sequence edge
 * *looks* different from a declared one, that a slot goes through a glyph, and that the columns are
 * the ones the engine handed over.
 */
test.describe('U1 — the graph reads correctly', () => {
  test('U1.1 draws the implicit sequence, and marks it as a sequence rather than a declared edge', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');

    await test.step('every consecutive pair of a flow declaring no depends: is joined', async () => {
      await expect(flows.graph.edge('sequence', 'create_order', 'read_order')).toBeAttached();
      await expect(flows.graph.edge('sequence', 'read_order', 'audit_order')).toBeAttached();
    });

    await test.step('and the edges are sequence edges, not declared ones', async () => {
      await expect(flows.graph.edge('sequence', 'create_order', 'read_order')).toHaveClass(/edge-sequence/);
      await expect(flows.graph.edge('depends', 'create_order', 'read_order')).toHaveCount(0);
    });
  });

  test('U1.9 draws a linear flow as one row, left to right', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'linear.flow.yml');

    const boxes = await Promise.all(
      ['create_order', 'read_order', 'audit_order'].map((id) => flows.graph.node(id).boundingBox())
    );

    expect(boxes.every((box) => box !== null)).toBe(true);
    expect(new Set(boxes.map((box) => box!.y)).size, 'every node shares one vertical position').toBe(1);
    expect(boxes[1]!.x, 'read_order is right of create_order').toBeGreaterThan(boxes[0]!.x);
    expect(boxes[2]!.x, 'audit_order is right of read_order').toBeGreaterThan(boxes[1]!.x);
  });

  test('U1.3 labels a status-conditioned edge, and leaves the ordinary ones unlabelled', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    await expect(flows.graph.edgeLabel('depends', 'quote_primary', 'quote_fallback')).toHaveText('[failed]');
    await expect(flows.graph.edge('depends', 'quote_primary', 'quote_fallback')).toHaveClass(/edge-conditional/);
    await expect(flows.graph.edgeLabel('sequence', 'sign_in', 'create_order')).toHaveCount(0);
  });

  test('U1.5 names a data edge, joins a pair once per output, and toggles off without touching the control edges', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    await test.step('a declared output consumed downstream is drawn and named', async () => {
      await expect(flows.graph.edgeLabel('data', 'create_order', 'quote_primary')).toHaveText('orderId');
    });

    await test.step('a step consuming two of one producer\'s outputs is joined to it twice, each name on its own line', async () => {
      const labels = flows.graph.edgeLabel('data', 'create_order', 'book_shipment');
      await expect(labels).toHaveCount(3);
      await expect(labels).toContainText(['orderId', 'channel', 'body']);

      const rows = await labels.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('dy')));
      expect(new Set(rows).size, 'each label sits on its own line').toBe(rows.length);
    });

    await test.step('turning data edges off leaves the control edges untouched', async () => {
      await flows.toolbar.dataEdges().uncheck();

      await expect(flows.graph.edge('data', 'create_order', 'quote_primary')).toHaveCount(0);
      await expect(flows.graph.edge('sequence', 'sign_in', 'create_order')).toBeAttached();
      await expect(flows.graph.edge('depends', 'quote_primary', 'quote_fallback')).toBeAttached();
    });
  });

  test('U1.6 draws an undeclared dependency as a warning, with a diagnostic to match', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    const raw = flows.graph.edge('data', 'create_order', 'book_shipment').filter({ hasText: 'body' });
    await expect(raw).toHaveClass(/edge-undeclared/);

    await flows.toolbar.warnings().hover();
    await expect(flows.toolbar.warningsList()).toContainText('undeclared-dependency');
    await expect(flows.toolbar.warningsList()).toContainText('steps.create_order.body.channel');
  });

  test('U1.7 draws a shared slot through a glyph, only when asked for', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    await test.step('with the toggle off and nothing focused, no glyph and no slot edge is drawn', async () => {
      await expect(flows.graph.allSlots()).toHaveCount(0);
      await expect(flows.graph.edge('slot-write', 'quoteId', 'quote_primary')).toHaveCount(0);
    });

    await test.step('turning it on draws a glyph per slot, with the writers into it and the reader out of it', async () => {
      await flows.toolbar.slotEdges().check();

      await expect(flows.graph.slot('quoteId')).toBeAttached();
      await expect(flows.graph.slot('carrierRef')).toBeAttached();
      await expect(flows.graph.edge('slot-write', 'quoteId', 'quote_primary')).toBeAttached();
      await expect(flows.graph.edge('slot-write', 'quoteId', 'quote_fallback')).toBeAttached();
      await expect(flows.graph.edge('slot-read', 'quoteId', 'book_shipment')).toBeAttached();
    });

    await test.step('and no edge runs directly from a writer to the reader', async () => {
      await expect(flows.graph.edge('data', 'quote_primary', 'book_shipment')).toHaveCount(0);
      await expect(flows.graph.edge('data', 'quote_fallback', 'book_shipment')).toHaveCount(0);
    });

    await test.step('two slots over the same steps get two glyphs that do not overlap', async () => {
      const quoteId = await flows.graph.slot('quoteId').boundingBox();
      const carrierRef = await flows.graph.slot('carrierRef').boundingBox();

      expect(quoteId).not.toBeNull();
      expect(carrierRef).not.toBeNull();
      const apart
        = quoteId!.x + quoteId!.width <= carrierRef!.x
          || carrierRef!.x + carrierRef!.width <= quoteId!.x
          || quoteId!.y + quoteId!.height <= carrierRef!.y
          || carrierRef!.y + carrierRef!.height <= quoteId!.y;
      expect(apart, 'the two glyphs do not overlap').toBe(true);
    });
  });

  test('U1.8 keeps a sub-flow as one node until it is expanded', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    await test.step('a uses: step is one marked node, and its internals are not drawn', async () => {
      await expect(flows.graph.node('sign_in')).toBeVisible();
      await expect(flows.graph.nodeMarkers('sign_in').filter({ hasText: 'uses' })).toBeVisible();
      await expect(flows.graph.node('sign_in/authenticate')).toHaveCount(0);
    });

    await test.step('selecting it says how to open it, and selecting an ordinary step says nothing', async () => {
      await selectStep(page, 'sign_in');
      await expect(flows.graph.nodeHint('sign_in')).toHaveText('double click to expand');

      await selectStep(page, 'create_order');
      await expect(flows.graph.nodeHint('create_order')).toHaveCount(0);
    });

    await test.step('expanding reveals the internals under namespaced ids, to the right of the container', async () => {
      await flows.graph.node('sign_in').dblclick();

      await expect(flows.graph.node('sign_in/authenticate')).toBeVisible();
      await expect(flows.graph.nodeHint('sign_in')).toHaveCount(0);

      const container = await flows.graph.node('sign_in').boundingBox();
      const inside = await flows.graph.node('sign_in/authenticate').boundingBox();
      expect(inside!.x, 'the sub-flow\'s block continues to the right of its container').toBeGreaterThan(container!.x);
    });

    await test.step('and a band stands behind the steps it drew, with the container ringed in its colour', async () => {
      await expect(page.getByTestId('flow-subflow-band-sign_in')).toBeAttached();
      await expect(page.getByTestId('flow-subflow-ring-sign_in')).toBeAttached();
    });
  });

  test('U1.13 divides the drawing into stages without moving it', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    await test.step('a description carrying three stages draws a named region for each', async () => {
      await expect(flows.graph.stage('setup')).toBeAttached();
      await expect(flows.graph.stage('fulfil')).toBeAttached();
      await expect(flows.graph.stage('teardown')).toBeAttached();
    });

    await test.step('the boundary at the first column has a name and no rule; the later ones have both', async () => {
      await expect(flows.graph.stageRule('setup')).toHaveCount(0);
      await expect(flows.graph.stageRule('fulfil')).toBeAttached();
      await expect(flows.graph.stageRule('teardown')).toBeAttached();
    });

    await test.step('and a rule sits in the gap between the two columns it divides', async () => {
      const rule = Number(await flows.graph.stageRule('fulfil').getAttribute('x1'));
      const before = await flows.graph.node('create_order').boundingBox();
      const after = await flows.graph.node('quote_primary').boundingBox();

      const scale = (after!.x - before!.x);
      expect(scale, 'the two columns are apart').toBeGreaterThan(0);
      expect(Number.isFinite(rule)).toBe(true);
    });

    await test.step('a description with no stages draws neither', async () => {
      await openFlow(page, 'linear.flow.yml');
      await expect(page.locator('g.stage')).toHaveCount(0);
    });
  });

  test('U1.14 draws the interface at both ends of a library flow, and neither on a flow declaring none', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'sign-in.flow.yml');

    await test.step('the inputs panel sits left of rank 0 and the exports panel right of the last rank', async () => {
      await expect(flows.graph.inputs()).toBeAttached();
      await expect(flows.graph.exports()).toBeAttached();

      const inputs = await flows.graph.inputs().boundingBox();
      const exports = await flows.graph.exports().boundingBox();
      const step = await flows.graph.node('authenticate').boundingBox();

      expect(inputs!.x).toBeLessThan(step!.x);
      expect(exports!.x).toBeGreaterThan(step!.x);
    });

    await test.step('each declared param, var and export has a row', async () => {
      await expect(flows.graph.input('email')).toBeVisible();
      await expect(flows.graph.input('region')).toBeVisible();
      await expect(flows.graph.variable('attempt')).toBeVisible();
      await expect(flows.graph.export('token')).toBeVisible();
    });

    await test.step('an export shows its steps.<id>.<output> reference until the step behind it ends', async () => {
      await expect(flows.graph.export('token')).toHaveText('steps.authenticate.token');
    });

    await test.step('a flow declaring neither draws neither panel', async () => {
      await openFlow(page, 'linear.flow.yml');
      await expect(flows.graph.inputs()).toHaveCount(0);
      await expect(flows.graph.exports()).toHaveCount(0);
    });
  });

  test('U1.9b carries the markers on the footer bar, and a key naming the bindings', async ({
    pageWithUserData: page
  }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    await test.step('every node draws a footer bar', async () => {
      await expect(flows.graph.nodeFooter('create_order')).toBeAttached();
      await expect(flows.graph.nodeFooter('quote_primary')).toBeAttached();
    });

    await test.step('a step\'s markers sit there rather than over its name', async () => {
      await expect(flows.graph.nodeMarkers('sign_in').filter({ hasText: 'uses' })).toBeVisible();
      await expect(flows.graph.nodeMarkers('quote_primary').filter({ hasText: '⌸' })).toBeVisible();
    });

    await test.step('the two bindings are tinted differently, and a key over the graph names both', async () => {
      await expect(flows.graph.legend()).toBeVisible();
      await expect(flows.graph.legendEntry('orders')).toBeVisible();
      await expect(flows.graph.legendEntry('carrier')).toBeVisible();

      const orders = await flows.graph.nodeFooter('create_order').evaluate((bar) => (bar as SVGElement).style.fill);
      const carrier = await flows.graph.nodeFooter('quote_primary').evaluate((bar) => (bar as SVGElement).style.fill);
      expect(orders).not.toBe(carrier);
    });

    await test.step('and a declared colour is the one drawn', async () => {
      const carrier = await flows.graph.nodeFooter('quote_primary').evaluate((bar) => (bar as SVGElement).style.fill);
      expect(carrier.replace(/\s/g, '')).toBe('rgb(138,180,248)');
    });

    await test.step('on a one-API fixture the key is still there, with no swatch', async () => {
      await openFlow(page, 'linear.flow.yml');

      await expect(flows.graph.legend()).toBeVisible();
      await expect(flows.graph.legendEntry('orders')).toBeVisible();
      await expect(flows.graph.legend().locator('.flow-legend-swatch')).toHaveCount(0);
    });
  });

  test('U1.12 takes the columns from the engine\'s ranks', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    // The one-step branch (`quote_fallback`) sits in the column its rank names, adjacent to the fork
    // it hangs off, rather than being pushed rightward against the join below it.
    const fork = await flows.graph.node('quote_primary').boundingBox();
    const branch = await flows.graph.node('quote_fallback').boundingBox();
    const join = await flows.graph.node('book_shipment').boundingBox();

    expect(branch!.x).toBeGreaterThan(fork!.x);
    expect(branch!.x).toBeLessThan(join!.x);
  });

  test('U1.4 marks an `any` join at the receiving node, and drops the mark when the join becomes `all`', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    expect(workspaceFixturePath, 'the workspace fixture must be present').toBeTruthy();
    const flowFile = path.join(workspaceFixturePath!, 'flows', 'fulfillment.flow.yml');
    const original = await fs.promises.readFile(flowFile, 'utf8');

    // The mark answers to the file, so the app has to be watching *this* test's copy of it.
    const app = await restartApp({});
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');

    await test.step('the step both branches rejoin at is marked any, and the branches themselves are not', async () => {
      await expect(flows.graph.nodeMarker('join', 'book_shipment')).toHaveText('any');
      await expect(flows.graph.nodeMarker('join', 'quote_primary')).toHaveCount(0);
      await expect(flows.graph.nodeMarker('join', 'quote_fallback')).toHaveCount(0);
    });

    await test.step('and changing the join to all removes it', async () => {
      await fs.promises.writeFile(flowFile, original.replace('      any:\n', '      all:\n'), 'utf8');

      await expect(flows.graph.nodeMarker('join', 'book_shipment')).toHaveCount(0);
      await expect(flows.graph.node('book_shipment')).toBeVisible();
    });
  });
});
