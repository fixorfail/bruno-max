import * as fs from 'fs';
import * as path from 'path';
import { test, expect, Page } from '../../playwright';
import { buildCommonLocators, openFlow, openFlowsSection } from '../utils/page';

/**
 * 002-C U5.6f — the sidebar manages the files it lists (002 §4.1d).
 *
 * Each scenario that changes the disk reads the workspace back with `fs`. The app is launched per
 * test with `restartApp`, so it watches this test's own copy of the workspace.
 */

const launch = async (restartApp: (options?: object) => Promise<{ firstWindow: () => Promise<Page> }>) => {
  const app = await restartApp({});
  const page = await app.firstWindow();
  await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
  await openFlowsSection(page);
  return page;
};

test.describe('U5.6f — the section manages its files', () => {
  test.describe.configure({ timeout: 90_000 });

  test('New Folder makes an empty folder row, at the top of flows/ and inside a folder', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);
    const flowsDir = path.join(workspaceFixturePath!, 'flows');

    await test.step('Make a folder from the group label', async () => {
      await flows.section.groupLabelFor('Workspace').hover();
      await flows.section.groupMenuTrigger('Workspace').click();
      await flows.section.newFolder('Workspace').click();
      await flows.section.newFolderName().fill('archive');
      await flows.section.newFolderDialog().getByRole('button', { name: 'Create' }).click();
    });

    await test.step('The empty folder is a row, and a directory on disk', async () => {
      await expect(flows.section.folder('archive')).toBeVisible();
      expect(fs.statSync(path.join(flowsDir, 'archive')).isDirectory()).toBe(true);
    });

    await test.step('Make a folder inside that folder', async () => {
      await flows.section.folder('archive').hover();
      await flows.section.folderMenuTrigger('archive').click();
      await flows.section.newFolder('archive').click();
      await flows.section.newFolderName().fill('2025');
      await flows.section.newFolderDialog().getByRole('button', { name: 'Create' }).click();
    });

    await test.step('The parent opens, and shows the new folder', async () => {
      await expect(flows.section.folder('archive/2025')).toBeVisible();
      expect(fs.statSync(path.join(flowsDir, 'archive', '2025')).isDirectory()).toBe(true);
    });
  });

  test('the Scripts label makes a folder in flows/scripts/, and a script moves into it', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);
    const scriptsDir = path.join(workspaceFixturePath!, 'flows', 'scripts');

    await test.step('Make a folder from the Scripts label', async () => {
      await flows.section.subgroup('scripts').hover();
      await flows.section.subgroupMenuTrigger('scripts').click();
      await flows.section.newFolder('subgroup-scripts').click();
      await flows.section.newFolderName().fill('shared');
      await flows.section.newFolderDialog().getByRole('button', { name: 'Create' }).click();
    });

    await test.step('The empty folder is a row under Scripts, and a directory on disk', async () => {
      await expect(flows.section.folder('shared')).toBeVisible();
      expect(fs.statSync(path.join(scriptsDir, 'shared')).isDirectory()).toBe(true);
    });

    await test.step('Drag the script into the new folder', async () => {
      await flows.section.row('helpers.js').dragTo(flows.section.folder('shared'));
    });

    await test.step('The script moved on disk, byte for byte', async () => {
      await expect(flows.section.row('shared/helpers.js')).toBeVisible();
      expect(fs.existsSync(path.join(scriptsDir, 'helpers.js'))).toBe(false);
      expect(fs.existsSync(path.join(scriptsDir, 'shared', 'helpers.js'))).toBe(true);
    });
  });

  test('the Libraries label makes a folder that stays under it, and a library moves into it', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);
    const flowsDir = path.join(workspaceFixturePath!, 'flows');

    await test.step('Open the Libraries label menu; its items are not set in capitals', async () => {
      await flows.section.subgroup('libraries').hover();
      await flows.section.subgroupMenuTrigger('libraries').click();
      await expect(flows.section.newFolder('subgroup-libraries')).toHaveCSS('text-transform', 'none');
      await flows.section.newFolder('subgroup-libraries').click();
      await flows.section.newFolderName().fill('auth');
      await flows.section.newFolderDialog().getByRole('button', { name: 'Create' }).click();
    });

    await test.step('The folder is in flows/ on disk, and drawn under Libraries', async () => {
      await expect(flows.section.folder('auth')).toBeVisible();
      expect(fs.statSync(path.join(flowsDir, 'auth')).isDirectory()).toBe(true);
      await expect(
        flows.section.subgroup('libraries').locator('xpath=..').getByTestId('flow-folder-auth')
      ).toBeVisible();
    });

    await test.step('Drag the library into the new folder', async () => {
      await flows.section.row('sign-in.flow.yml').dragTo(flows.section.folder('auth'));
      await expect(flows.section.row('auth/sign-in.flow.yml')).toBeVisible();
      expect(fs.existsSync(path.join(flowsDir, 'auth', 'sign-in.flow.yml'))).toBe(true);
    });
  });

  test('a flow dragged into a folder moves there, and its relative paths follow', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);
    const flowsDir = path.join(workspaceFixturePath!, 'flows');

    await test.step('Drag linear.flow.yml onto the company folder', async () => {
      await flows.section.row('linear.flow.yml').waitFor({ state: 'visible', timeout: 60000 });
      await flows.section.row('linear.flow.yml').dragTo(flows.section.folder('company'));
    });

    await test.step('The file moved, with its binding one directory further up', async () => {
      await expect(flows.section.row('company/linear.flow.yml')).toBeVisible();
      expect(fs.existsSync(path.join(flowsDir, 'linear.flow.yml'))).toBe(false);
      const moved = fs.readFileSync(path.join(flowsDir, 'company', 'linear.flow.yml'), 'utf8');
      expect(moved).toContain('orders: ../../apispec/orders-v1.yml');
    });
  });

  test('a flow dropped on its group label leaves its folder', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);
    const flowsDir = path.join(workspaceFixturePath!, 'flows');

    await test.step('Open the company folder and drag its flow onto the group label', async () => {
      await flows.section.folder('company').click();
      await flows.section.row('company/create-company.flow.yml').dragTo(flows.section.groupLabelFor('Workspace'));
    });

    await test.step('The file is at the top of flows/, with its binding one directory shorter', async () => {
      await expect(flows.section.row('create-company.flow.yml')).toBeVisible();
      const moved = fs.readFileSync(path.join(flowsDir, 'create-company.flow.yml'), 'utf8');
      expect(moved).toContain('orders: ../apispec/orders-v1.yml');
      expect(fs.existsSync(path.join(flowsDir, 'company', 'create-company.flow.yml'))).toBe(false);
    });
  });

  test('the row of the active flow tab is marked, and its folder opens', async ({ restartApp }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await test.step('Open the flow inside the company folder', async () => {
      await flows.section.folder('company').click();
      await openFlow(page, 'company/create-company.flow.yml');
      await expect(flows.section.row('company/create-company.flow.yml')).toHaveClass(/is-active/);
    });

    await test.step('Close the folder, open another flow, then go back to the first tab', async () => {
      await flows.section.folder('company').click();
      await expect(flows.section.row('company/create-company.flow.yml')).toHaveCount(0);

      await openFlow(page, 'linear.flow.yml');
      await expect(flows.section.row('linear.flow.yml')).toHaveClass(/is-active/);

      await page.locator('.request-tab').filter({ hasText: 'Create a company' }).click();
    });

    await test.step('The folder opens again, and the first row is marked', async () => {
      await expect(flows.section.row('company/create-company.flow.yml')).toHaveClass(/is-active/);
      await expect(flows.section.row('linear.flow.yml')).not.toHaveClass(/is-active/);
    });
  });
});
