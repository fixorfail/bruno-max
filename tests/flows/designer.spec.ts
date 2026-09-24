import * as fs from 'fs';
import * as path from 'path';
import { test, expect, Page } from '../../playwright';
import {
  addApiBinding,
  addLibraryAfter,
  addStepAfter,
  addStepBefore,
  buildCommonLocators,
  connectSteps,
  openFlow,
  openFlowsSection,
  openFlowYamlEditor,
  openStepEditor,
  runFlow,
  selectStep
} from '../utils/page';

/**
 * 005-C §4–§7 — the canvas edits the document, the editor writes what it names, and one draft sits
 * under both surfaces.
 *
 * Every scenario that writes ends by reading the `.flow.yml` back from the workspace the app opened
 * (005-C §2): asserting on the graph alone would pass a writer that drew the right thing and wrote
 * the wrong file. The app is launched per test against that test's own copy of the workspace —
 * `restartApp` — because the worker-scoped app opens the first test's copy and would write there.
 */

const FIXTURE_FLOWS = path.join(__dirname, 'fixtures', 'workspace', 'flows');

const readFlow = (workspace: string, name: string) => fs.readFileSync(path.join(workspace, 'flows', name), 'utf8');
const committed = (name: string) => fs.readFileSync(path.join(FIXTURE_FLOWS, name), 'utf8');

/** What an edit added and removed, line by line, as a diff would show it — counted, so a line the file already had elsewhere still registers. */
const changedLines = (before: string, after: string) => {
  const count = (text: string) =>
    text.split('\n').reduce((tally, line) => tally.set(line, (tally.get(line) || 0) + 1), new Map<string, number>());
  const was = count(before);
  const now = count(after);
  const diff = (from: Map<string, number>, to: Map<string, number>) =>
    [...from.entries()].flatMap(([line, n]) => Array(Math.max(0, n - (to.get(line) || 0))).fill(line)).map((line) => line.trim());
  return { added: diff(now, was), removed: diff(was, now) };
};

const launch = async (restartApp: (options?: object) => Promise<{ firstWindow: () => Promise<Page> }>) => {
  const app = await restartApp({});
  const page = await app.firstWindow();
  await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });
  await openFlowsSection(page);
  return page;
};

/**
 * Saves the draft — through the button when auto-save is off, otherwise by waiting for it — and
 * saves again if an edit that was still in flight lands after the write (§7.2 makes that ordinary:
 * a field's commit is a round trip, and a save clicked inside it writes the text before it).
 */
const saveDraft = async (page: Page) => {
  const { flows } = buildCommonLocators(page);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await flows.designer.save().isVisible()) {
      await flows.designer.save().click();
    }
    await expect(flows.designer.state()).toHaveText('Saved', { timeout: 10000 });
    await page.waitForTimeout(600);
    if ((await flows.designer.state().textContent()) === 'Saved') {
      return;
    }
  }
};

test.describe('B2 — the canvas edits the document', () => {
  // Each scenario launches its own app against its own workspace copy, which is most of its time.
  test.describe.configure({ timeout: 90_000 });

  test('B2.1 an open flow is editable; its state is said in words', async ({ restartApp }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');

    await expect(flows.designer.editLayer()).toBeAttached();
    await expect(flows.designer.insertAfter('a')).toBeAttached();
    await expect(flows.designer.insertAfter('c')).toBeAttached();
    await expect(flows.designer.state()).toHaveText('Saved');
    await expect(flows.designer.readOnly()).toHaveCount(0);
  });

  test('B2.2 a finished run stays read-only until closed, and Edit flow closes it', async ({ restartApp }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'linear.flow.yml');
    await runFlow(page, { capture: false });

    await expect(flows.designer.readOnly()).toContainText('Reviewing a run');
    await expect(flows.designer.editLayer()).toHaveCount(0);

    await flows.designer.edit().click();

    await expect(flows.designer.state()).toHaveText('Saved');
    await expect(flows.designer.editLayer()).toBeAttached();
  });

  test('B2.3 inserts a picked operation after a step, and the file gains exactly two lines', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await addStepAfter(page, 'a', 'orders', 'getOrder');

    await test.step('the node is drawn between a and b, wired by the sequence, and selected', async () => {
      await expect(flows.graph.node('get_order')).toBeVisible();
      await expect(flows.graph.edge('sequence', 'a', 'get_order')).toBeAttached();
      await expect(flows.graph.edge('sequence', 'get_order', 'b')).toBeAttached();
      await expect(flows.designer.state()).toHaveText('Unsaved changes');
      await expect(flows.graph.node('get_order')).toHaveClass(/selected/);
      await expect(flows.designer.field('id')).toHaveValue('get_order');
    });

    await saveDraft(page);

    await test.step('and the file on disk differs by those two lines', async () => {
      const { added, removed } = changedLines(committed('designer-linear.flow.yml'), readFlow(workspaceFixturePath!, 'designer-linear.flow.yml'));
      expect(removed).toEqual([]);
      expect(added.filter(Boolean)).toEqual(['- id: get_order', 'operation: orders#getOrder']);
    });
  });

  test('B2.12 inserts a library as a uses: step, written relative to the flow', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await addLibraryAfter(page, 'a', 'sign-in.flow.yml');

    await test.step('the node is drawn as a sub-flow between a and b', async () => {
      await expect(flows.graph.node('sign_in')).toBeVisible();
      await expect(flows.graph.nodeMarker('subflow', 'sign_in')).toBeAttached();
      await expect(flows.graph.edge('sequence', 'a', 'sign_in')).toBeAttached();
      await expect(flows.graph.edge('sequence', 'sign_in', 'b')).toBeAttached();
    });

    await saveDraft(page);

    await test.step('and the file names the library by a path relative to the flow', async () => {
      const { added, removed } = changedLines(committed('designer-linear.flow.yml'), readFlow(workspaceFixturePath!, 'designer-linear.flow.yml'));
      expect(removed).toEqual([]);
      expect(added.filter(Boolean)).toEqual(['- id: sign_in', 'uses: ./sign-in.flow.yml']);
    });
  });

  test('B2.13 inserts a new first step from the leading +, and the old first follows it', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await addStepBefore(page, 'a', 'orders', 'createOrder');

    await test.step('the node is drawn first, with a leading a', async () => {
      await expect(flows.graph.node('create_order')).toBeVisible();
      await expect(flows.graph.edge('sequence', 'create_order', 'a')).toBeAttached();
      await expect(flows.designer.insertBefore('create_order')).toBeAttached();
      await expect(flows.designer.insertBefore('a')).toHaveCount(0);
    });

    await saveDraft(page);

    await test.step('and the file gains two lines at the head of steps:, nothing else', async () => {
      const text = readFlow(workspaceFixturePath!, 'designer-linear.flow.yml');
      const { added, removed } = changedLines(committed('designer-linear.flow.yml'), text);
      expect(removed).toEqual([]);
      expect(added.filter(Boolean)).toEqual(['- id: create_order', 'operation: orders#createOrder']);
      expect(text.indexOf('- id: create_order')).toBeLessThan(text.indexOf('- id: a'));
    });
  });

  test('B2.4 an empty flow offers its first request, and gains a steps block', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-empty.flow.yml');

    await expect(flows.designer.insertFirst()).toBeVisible();
    await addStepAfter(page, undefined, 'orders', 'createOrder');

    await expect(flows.graph.node('create_order')).toBeVisible();
    await expect(flows.designer.insertFirst()).toHaveCount(0);
    await saveDraft(page);

    const text = readFlow(workspaceFixturePath!, 'designer-empty.flow.yml');
    expect(text).toMatch(/steps:\n\s+- id: create_order\n\s+operation: orders#createOrder/);
    expect(text.indexOf('apis:')).toBeLessThan(text.indexOf('steps:'));
  });

  test('B2.5 removes a step, and the chain closes over it', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await selectStep(page, 'b');
    await flows.designer.delete('b').click();

    await expect(flows.graph.node('b')).toHaveCount(0);
    await expect(flows.graph.edge('sequence', 'a', 'c')).toBeAttached();
    await saveDraft(page);

    const { added, removed } = changedLines(committed('designer-linear.flow.yml'), readFlow(workspaceFixturePath!, 'designer-linear.flow.yml'));
    expect(added).toEqual([]);
    expect(removed.filter(Boolean)).toEqual(['- id: b', 'operation: orders#getOrder']);
  });

  test('B2.7 a connector dragged between ports writes depends, and B2.8 its control takes it back', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await connectSteps(page, 'a', 'c');

    await test.step('c now declares its dependency on a', async () => {
      await expect(flows.graph.edge('depends', 'a', 'c')).toBeAttached();
      await expect(flows.graph.edge('sequence', 'b', 'c')).toHaveCount(0);
      await saveDraft(page);
      expect(readFlow(workspaceFixturePath!, 'designer-linear.flow.yml')).toMatch(/- id: c\n\s+operation: orders#getOrder\n\s+depends:\n\s+- a\n/);
    });

    await test.step('and removing it from the edge returns c to the sequence, and the file to what it was', async () => {
      await flows.designer.edgeRemove('a', 'c').click();
      await expect(flows.graph.edge('sequence', 'b', 'c')).toBeAttached();
      await saveDraft(page);
      expect(readFlow(workspaceFixturePath!, 'designer-linear.flow.yml')).toBe(committed('designer-linear.flow.yml'));
    });
  });

  test('B2.9 the legend binds a document, and the picker offers it before the file is saved', async ({
    restartApp,
    workspaceFixturePath
  }) => {
    // The dialog pairs the workspace's spec list with the documents the app has loaded by path, so
    // the copied workspace names its documents where they now are.
    const workspaceFile = path.join(workspaceFixturePath!, 'workspace.yml');
    fs.writeFileSync(
      workspaceFile,
      fs.readFileSync(workspaceFile, 'utf8').replace(
        'specs:\n',
        `specs:\n  - name: "Orders API"\n    path: "${path.join(workspaceFixturePath!, 'apispec', 'orders-v1.yml')}"\n  - name: "Carrier API"\n    path: "${path.join(workspaceFixturePath!, 'apispec', 'carrier-v1.yml')}"\n`
      )
    );

    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await addApiBinding(page, 'Carrier API', { alias: 'carrier', color: '#8ab4f8' });

    await expect(flows.designer.legendMenu('carrier')).toBeVisible();
    await expect(flows.designer.state()).toHaveText('Unsaved changes');

    await test.step('the picker lists the new binding before anything is saved', async () => {
      await flows.designer.insertAfter('c').click();
      await expect(flows.designer.pickerApi('carrier')).toBeVisible();
      await flows.designer.pickerApi('carrier').click();
      await expect(flows.designer.picker().locator('.picker-operation').first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(flows.designer.picker()).toHaveCount(0);
    });

    await saveDraft(page);
    const text = readFlow(workspaceFixturePath!, 'designer-linear.flow.yml');
    expect(text).toMatch(/carrier:\n\s+source: \.\.\/apispec\/carrier-v1\.yml\n\s+color: ["']?#8ab4f8["']?\n/);
  });

  test('B2.10 removing a binding a step still calls is refused, with the steps named', async ({ restartApp }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await flows.designer.legendMenu('orders').click();
    await flows.designer.legendRemove('orders').click();

    await expect(flows.designer.refusal()).toContainText('a');
    await expect(flows.designer.state()).toHaveText('Saved');
  });
});

test.describe('B3 — opaque fields', () => {
  // Each scenario launches its own app against its own workspace copy, which is most of its time.
  test.describe.configure({ timeout: 90_000 });

  test('B3.1 a tagged value is named, not edited, and opens the YAML at its line', async ({ restartApp }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-tagged.flow.yml');
    await openStepEditor(page, 'upload');

    await expect(flows.designer.opaqueKey('body')).toContainText('!file');
    await expect(flows.designer.opaqueKey('outputs')).toContainText('!...');

    await flows.designer.openYaml('body').click();
    await expect(flows.yaml.pane()).toBeVisible();
  });

  test('a key this build does not model is kept through an edit to its step, and named', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-unknown-key.flow.yml');
    await openStepEditor(page, 'create');

    await expect(flows.designer.opaqueKey('retryPolicy')).toBeVisible();

    await flows.designer.field('name').fill('Create it');
    await flows.designer.field('name').press('Enter');
    await saveDraft(page);

    const text = readFlow(workspaceFixturePath!, 'designer-unknown-key.flow.yml');
    expect(text).toContain('retryPolicy: aggressive');
    expect(text).toContain('name: Create it');
  });
});

test.describe('B4 — the step editor writes what it names', () => {
  // Each scenario launches its own app against its own workspace copy, which is most of its time.
  test.describe.configure({ timeout: 90_000 });

  test('B4.1 a header committed from the table is one block in the file', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await openStepEditor(page, 'b');
    await flows.designer.editorTab('request').click();

    const headers = flows.designer.table('headers');
    // The table virtualises its rows against the window, and renders them once it is in view.
    await headers.scrollIntoViewIfNeeded();
    await headers.getByPlaceholder('Name').last().fill('X-Trace');
    // The pause commits the name on its own (§6.3); waiting for it keeps the value's commit from
    // racing it, which is the case a person typing never produces and a runner under load does.
    await expect(flows.designer.state()).toHaveText('Unsaved changes');
    // The row that now carries the name is the first data row — `b` declares no headers — rather
    // than the last row, since the table grows a fresh empty row beneath it as the name is typed.
    await headers.getByPlaceholder('Value').first().fill('abc');
    await flows.designer.editorTab('overview').click();
    await saveDraft(page);

    const { added, removed } = changedLines(committed('designer-linear.flow.yml'), readFlow(workspaceFixturePath!, 'designer-linear.flow.yml'));
    expect(removed).toEqual([]);
    expect(added.filter(Boolean)).toEqual(['headers:', 'X-Trace: abc']);
  });

  test('B4.9 a uses: step lists its library\'s exports before its own outputs', async ({ restartApp }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'fulfillment.flow.yml');
    await openStepEditor(page, 'sign_in');
    await flows.designer.editorTab('outputs').click();

    await expect(flows.designer.exports()).toContainText('Exported by ./sign-in.flow.yml');
    await expect(flows.designer.exportRow('token')).toContainText('steps.sign_in.token');
    await expect(flows.designer.exportRow('token')).toContainText('steps.authenticate.token');
    const exportsBox = await flows.designer.exports().boundingBox();
    const outputsBox = await flows.designer.table('outputs').boundingBox();
    expect(exportsBox!.y).toBeLessThan(outputsBox!.y);
  });

  test('B4.10 a script computed before the request is written under pre:', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await openStepEditor(page, 'b');
    await flows.designer.editorTab('scripts').click();

    await flows.designer.scriptAdd().click();
    await flows.designer.scriptName(0).fill('timestamp');
    await flows.designer.scriptEditor(0).click();
    await page.keyboard.type('() => String(Date.now())');
    await expect(flows.designer.state()).toHaveText('Unsaved changes');
    // Leaving the editor commits what it holds (§6.3) before the save, as B4.1 does for its table.
    await flows.designer.editorTab('overview').click();
    await saveDraft(page);

    const text = readFlow(workspaceFixturePath!, 'designer-linear.flow.yml');
    expect(text).toMatch(/pre:\n\s+timestamp: .*Date\.now\(\)/);
  });

  test('B4.11 a shared script is added to the flow\'s functions.use, relative to the flow', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await openStepEditor(page, 'b');
    await flows.designer.editorTab('scripts').click();

    await expect(flows.designer.sharedScripts()).toContainText('uses no shared script');
    await flows.designer.sharedScriptAdd().selectOption({ label: 'flows/scripts/helpers.js' });
    await expect(flows.designer.sharedScript(0)).toContainText('./scripts/helpers.js');
    await saveDraft(page);

    const { added, removed } = changedLines(committed('designer-linear.flow.yml'), readFlow(workspaceFixturePath!, 'designer-linear.flow.yml'));
    expect(removed).toEqual([]);
    expect(added.filter(Boolean)).toEqual(['functions:', 'use: [ ./scripts/helpers.js ]']);

    await flows.designer.sharedScriptRemove(0).click();
    await expect(flows.designer.sharedScripts()).toContainText('uses no shared script');
    await saveDraft(page);
    expect(readFlow(workspaceFixturePath!, 'designer-linear.flow.yml')).toBe(committed('designer-linear.flow.yml'));
  });

  test('B4.3 a flag is three-state, and inherit deletes the key', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await openStepEditor(page, 'c');
    await flows.designer.editorTab('settings').click();

    await expect(flows.designer.flag('failOnStatusCode')).toHaveValue('inherit');
    await flows.designer.flag('failOnStatusCode').selectOption('off');
    await saveDraft(page);
    expect(readFlow(workspaceFixturePath!, 'designer-linear.flow.yml')).toContain('failOnStatusCode: false');

    await flows.designer.flag('failOnStatusCode').selectOption('inherit');
    await saveDraft(page);
    expect(readFlow(workspaceFixturePath!, 'designer-linear.flow.yml')).toBe(committed('designer-linear.flow.yml'));
  });

  test('B4.4 a refused edit stays on the field, and the document stands', async ({ restartApp }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await openStepEditor(page, 'b');

    await flows.designer.field('id').fill('a');
    await flows.designer.field('id').press('Enter');

    await expect(flows.designer.stepRefusal()).toBeVisible();
    await expect(flows.designer.state()).toHaveText('Saved');
  });
});

test.describe('B5 — one draft, two surfaces, and the run control', () => {
  // Each scenario launches its own app against its own workspace copy, which is most of its time.
  test.describe.configure({ timeout: 90_000 });

  test('B5.1 a YAML edit redraws the flow tab before save, and B5.2 a structured edit shows in the YAML', async ({ restartApp }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlowYamlEditor(page, 'designer-linear.flow.yml');
    await expect(flows.yaml.editor()).toContainText('version: 1');

    await test.step('B5.1', async () => {
      await flows.yaml.editor().locator('.CodeMirror').evaluate((element: HTMLElement & { CodeMirror?: { getValue: () => string; setValue: (value: string) => void } }) => {
        const editor = element.CodeMirror!;
        editor.setValue(`${editor.getValue()}\n  - id: d\n    operation: orders#getOrder\n`);
      });

      await openFlow(page, 'designer-linear.flow.yml');
      await expect(flows.graph.node('d')).toBeVisible();
      await expect(flows.designer.state()).toHaveText('Unsaved changes');
    });

    await test.step('B5.2', async () => {
      await selectStep(page, 'd');
      await flows.designer.delete('d').click();
      await expect(flows.graph.node('d')).toHaveCount(0);

      await openFlowYamlEditor(page, 'designer-linear.flow.yml');
      await expect(flows.yaml.editor()).not.toContainText('- id: d');
    });
  });

  test('B5.6 Run saves a dirty draft first', async ({ restartApp, workspaceFixturePath }) => {
    const page = await launch(restartApp);
    const { flows } = buildCommonLocators(page);

    await openFlow(page, 'designer-linear.flow.yml');
    await selectStep(page, 'c');
    await flows.designer.delete('c').click();

    await expect(flows.designer.runSavesFirst()).toHaveText('Save & run');
    await runFlow(page, { capture: false });

    expect(readFlow(workspaceFixturePath!, 'designer-linear.flow.yml')).not.toContain('- id: c');
    await expect(flows.designer.readOnly()).toBeVisible();
  });
});
