import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../playwright';
import { buildCommonLocators, openFlowsSection } from '../utils/page';

/**
 * 002 §4.6a — the connector file in the sidebar.
 *
 * 001 §8.5's `flows/connectors.yml` decides what every flow in the scope extracts, which host each
 * binding calls and which credential it carries, and it is the only listed file that is not a flow,
 * a script or a fixture. That last part is why this spec exists rather than a unit test: each layer
 * had its own idea of what may be listed, opened and read, and a row that drew correctly still
 * refused to open because the IPC guard on the far side had never heard of it.
 */
test.describe('U9 — the connector file', () => {
  test.describe.configure({ timeout: 90_000 });

  test('U9.1 is listed with the libraries, opens as plain YAML, and saves', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    expect(workspaceFixturePath, 'the workspace fixture must be present').toBeTruthy();
    const connectorFile = path.join(workspaceFixturePath!, 'flows', 'connectors.yml');

    // The editor reads and writes through the host, so the app has to be watching *this* test's copy.
    const app = await restartApp({});
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

    const { flows } = buildCommonLocators(page);
    const source = flows.source('flow-connectors');

    await openFlowsSection(page);

    await test.step('the row sits under the Libraries label, with the scope\'s library flows', async () => {
      await expect(flows.section.row('connectors.yml')).toBeVisible();

      const libraries = flows.section.subgroup('libraries');
      const ordinary = flows.section.row('linear.flow.yml');
      expect((await flows.section.row('connectors.yml').boundingBox())!.y)
        .toBeGreaterThan((await libraries.boundingBox())!.y);
      expect((await libraries.boundingBox())!.y).toBeGreaterThan((await ordinary.boundingBox())!.y);
    });

    await test.step('and carries no row menu — there is no meta: to edit and no rename', async () => {
      await flows.section.row('connectors.yml').hover();
      await expect(flows.section.menuTrigger('connectors.yml')).toHaveCount(0);
    });

    await test.step('clicking it opens the file itself, rather than a pane that could not read it', async () => {
      await flows.section.row('connectors.yml').click();

      await expect(source.pane()).toBeVisible();
      await expect(source.filename()).toHaveText('connectors.yml');
      await expect(source.badge()).toHaveText('connector file');
      // The regression: every guard on `renderer:flow-read-source` refused this file, and the pane
      // reported that it could not be read where the document should have been.
      await expect(source.editor()).toContainText('orders: ../apispec/orders-v1.yml');
      await expect(source.pane()).not.toContainText('could not be read');
    });

    await test.step('it is not opened as a flow — no graph, and no flow diagnostics', async () => {
      await expect(flows.yaml.pane()).toHaveCount(0);
      await expect(flows.graph.root()).toHaveCount(0);
    });

    await test.step('an edit saves to the file the run reads', async () => {
      await source.editor().click();
      await page.keyboard.press('ControlOrMeta+End');
      await page.keyboard.type('\n# edited by U9.1\n');

      await expect(source.save()).toBeEnabled();
      await source.save().click();

      await expect(source.state()).toHaveText('Saved');
      await expect
        .poll(() => fs.promises.readFile(connectorFile, 'utf8'))
        .toContain('# edited by U9.1');
    });
  });
});
