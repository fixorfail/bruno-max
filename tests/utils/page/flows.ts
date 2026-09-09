import * as fs from 'fs';
import * as path from 'path';
import { test, ElectronApplication, Locator, Page } from '../../../playwright';
import { buildEnvironmentLocators } from './environments';

/**
 * The API Flows section, the flow tab and its step detail — 002 §4–§10.
 *
 * One module for the whole feature because the sidebar row, the graph and the pane are read together
 * in every scenario: a spec selects a flow, runs it, and asks what a node says about it.
 */

export type FlowEdgeKind = 'sequence' | 'depends' | 'data' | 'slot-read' | 'slot-write';

export const buildFlowLocators = (page: Page) => {
  const section = page.locator('.flows-section');
  const graph = page.getByTestId('flow-graph');
  const detail = page.getByTestId('flow-step-detail');

  return {
    /** §4.1's sidebar section. Collapsed on launch — `openFlowsSection` is what opens it. */
    section: {
      root: () => section,
      header: () => section.locator('.section-header'),
      body: () => section.locator('.sidebar-section-body'),
      empty: () => section.locator('.flows-empty'),
      groupLabel: (label: string) => section.locator('.flow-group-label').filter({ hasText: label }),
      subgroup: (key: 'libraries' | 'scripts' | 'fixtures') => page.getByTestId(`flow-subgroup-${key}`),
      /** Rows and folders are identified by their bucket-relative path, as the section builds them. */
      row: (relativePath: string) => page.getByTestId(`flow-row-${relativePath}`),
      rowName: (relativePath: string) => page.getByTestId(`flow-row-${relativePath}`).locator('.flow-name'),
      rowRunMark: (relativePath: string) => page.getByTestId(`flow-row-${relativePath}`).locator('.flow-run-mark'),
      folder: (relativePath: string) => page.getByTestId(`flow-folder-${relativePath}`),
      menuTrigger: (relativePath: string) =>
        page.getByTestId(`flow-row-${relativePath}`).getByTestId('flow-menu-trigger'),
      editYaml: (relativePath: string) => page.getByTestId(`flow-edit-yaml-${relativePath}`),
      properties: (relativePath: string) => page.getByTestId(`flow-properties-${relativePath}`),
      duplicate: (relativePath: string) => page.getByTestId(`flow-duplicate-${relativePath}`),
      renameScript: (relativePath: string) => page.getByTestId(`script-rename-${relativePath}`),
      search: () => page.getByTestId('flows-search'),
      add: () => page.getByTestId('flows-header-add'),
      run: () => page.getByTestId('flows-header-run'),
      actions: () => page.getByTestId('flows-header-actions')
    },

    /** §4.2's header above a flow tab's strip. */
    header: {
      root: () => page.getByTestId('flow-tab-header'),
      title: () => page.getByTestId('flow-tab-header').locator('.flow-header-title'),
      environment: () => page.getByTestId('flow-tab-header').locator('.flow-header-environment')
    },

    /** §5's drawing. Node state is read off `data-status`, never off a colour. */
    graph: {
      root: () => graph,
      viewport: () => page.getByTestId('flow-graph-viewport'),
      node: (stepId: string) => page.getByTestId(`flow-node-${stepId}`),
      nodeStatus: (stepId: string) => page.getByTestId(`flow-node-${stepId}`).locator('.node-status'),
      nodeAttempts: (stepId: string) => page.getByTestId(`flow-node-${stepId}`).locator('.node-attempts'),
      /** The node's own hover — §8.2's message. Its footer carries a second `<title>` naming the API. */
      nodeTitle: (stepId: string) => page.getByTestId(`flow-node-${stepId}`).locator(':scope > title'),
      nodeHalo: (stepId: string) => page.getByTestId(`flow-node-halo-${stepId}`),
      nodeHint: (stepId: string) => page.getByTestId(`flow-node-hint-${stepId}`),
      nodeFooter: (stepId: string) => page.getByTestId(`flow-node-footer-${stepId}`),
      nodeMarkers: (stepId: string) => page.getByTestId(`flow-node-${stepId}`).locator('.node-marker'),
      /** One marker by the thing it marks — §5.1's `when`, `retry`, `uses`, slot and join glyphs. */
      nodeMarker: (key: 'when' | 'retry' | 'subflow' | 'negative' | 'slot' | 'join' | 'connector', stepId: string) =>
        page.getByTestId(`flow-node-marker-${key}-${stepId}`),
      nodeBadge: (stepId: string) => page.getByTestId(`flow-node-${stepId}`).locator('.node-badge'),
      nodePreStrip: (stepId: string) => page.getByTestId(`flow-node-pre-${stepId}`),
      allNodes: () => graph.locator('g.node'),
      edge: (kind: FlowEdgeKind, from: string, to: string) => page.getByTestId(`flow-edge-${kind}-${from}-${to}`),
      allEdges: () => graph.locator('g.edge'),
      /** §5.3's focus fades everything not touching the focused step. */
      dimmed: () => graph.locator('.dimmed'),
      edgeLabel: (kind: FlowEdgeKind, from: string, to: string) =>
        page.getByTestId(`flow-edge-${kind}-${from}-${to}`).locator('.edge-label'),
      edgeTitle: (kind: FlowEdgeKind, from: string, to: string) =>
        page.getByTestId(`flow-edge-${kind}-${from}-${to}`).locator('title'),
      edgeMark: (kind: FlowEdgeKind, from: string, to: string) =>
        page.getByTestId(`flow-edge-${kind}-${from}-${to}`).locator('.edge-mark'),
      slot: (name: string) => page.getByTestId(`flow-slot-${name}`),
      allSlots: () => graph.locator('g.slot'),
      stage: (name: string) => page.getByTestId(`flow-stage-${name}`),
      stageRule: (name: string) => page.getByTestId(`flow-stage-rule-${name}`),
      legend: () => page.getByTestId('flow-legend'),
      legendEntry: (api: string) => page.getByTestId('flow-legend').locator('.flow-legend-entry').filter({ hasText: api }),
      inputs: () => page.getByTestId('flow-inputs'),
      input: (name: string) => page.getByTestId(`flow-input-${name}`),
      variable: (name: string) => page.getByTestId(`flow-var-${name}`),
      exports: () => page.getByTestId('flow-exports'),
      export: (name: string) => page.getByTestId(`flow-export-${name}`)
    },

    /** §5.3's layer toggles, §10's selector and §6's warning count. */
    toolbar: {
      dataEdges: () => page.locator('.flow-toolbar label').filter({ hasText: 'Data edges' }).locator('input'),
      slotEdges: () => page.getByTestId('flow-toggle-slot-edges'),
      iteration: () => page.locator('.flow-toolbar label').filter({ hasText: 'Iteration' }).locator('select'),
      runSelector: () => page.getByTestId('flow-run-selector'),
      runOrigin: () => page.getByTestId('flow-run-origin'),
      warnings: () => page.getByTestId('flow-warnings'),
      warningsList: () => page.getByTestId('flow-warnings-list')
    },

    /** §8.3's per-iteration strip, above the graph the selector draws one row of. */
    iterations: {
      strip: () => page.getByTestId('flow-iteration-strip'),
      chip: (index: number) => page.getByTestId(`flow-iteration-${index}`)
    },

    /** §6's error list, above the graph and blocking the run. */
    diagnostics: {
      root: () => page.getByTestId('flow-diagnostics'),
      fromRun: () => page.getByTestId('flow-run-diagnostics'),
      line: (code: string) => page.getByTestId('flow-diagnostics').locator('.diagnostic').filter({ hasText: code }),
      /** §6's anchor: the control that opens §4.3's editor on the line the diagnostic names. */
      anchor: (line: number) => page.getByTestId(`flow-diagnostic-line-${line}`)
    },

    /** §7.1's one control, and §8.4's summary beside it. */
    run: {
      button: () => page.getByTestId('flow-run'),
      /**
       * The control between runs. It is disabled from the click until `run:start` and replaced by
       * Cancel from there to `run:end`, so an enabled **Run** is the one state that means no run of
       * this flow is in flight — including for a run too short to catch Cancel on screen.
       */
      idle: () => page.locator('[data-testid="flow-run"]:not(:disabled)'),
      options: () => page.getByTestId('flow-run-options'),
      withoutCapture: () => page.getByTestId('flow-run-without-capture'),
      cancel: () => page.getByTestId('flow-cancel'),
      /** §7.1's state between the cancel and the end of 001 §11.3's grace window. */
      cleanup: () => page.getByTestId('flow-cleanup'),
      summary: () => page.getByTestId('flow-run-summary'),
      status: () => page.getByTestId('flow-run-summary').locator('.run-status'),
      total: () => page.getByTestId('flow-run-total'),
      elapsed: () => page.getByTestId('flow-run-elapsed'),
      cause: (stepId: string) => page.getByTestId(`flow-run-cause-${stepId}`)
    },

    /** §7.2's panel, beside the control it configures. */
    configuration: {
      toggle: () => page.getByTestId('flow-run-configuration-toggle'),
      panel: () => page.getByTestId('flow-run-configuration'),
      summary: () => page.getByTestId('flow-run-configuration-summary'),
      addOverride: () => page.getByTestId('flow-config-variable-add'),
      overrideRows: () => page.getByTestId('flow-config-variables').locator('.run-config-row'),
      overrideName: (index: number) => page.getByTestId(`flow-config-variable-name-${index}`),
      overrideValue: (index: number) => page.getByTestId(`flow-config-variable-value-${index}`),
      dataset: () => page.getByTestId('flow-config-dataset'),
      concurrency: () => page.getByTestId('flow-config-concurrency'),
      param: (name: string) => page.getByTestId(`flow-config-param-${name}`)
    },

    /** §9's step pane. */
    detail: {
      root: () => detail,
      step: () => detail.locator('.detail-step'),
      status: () => detail.locator('.detail-status'),
      unreported: () => page.getByTestId('flow-step-unreported'),
      inFlight: () => page.getByTestId('flow-step-in-flight'),
      message: () => page.getByTestId('flow-step-message'),
      attempt: () => page.getByTestId('flow-step-attempt'),
      tab: (name: 'request' | 'response' | 'assertions' | 'validation') => page.getByTestId(`flow-step-tab-${name}`),
      body: (side: 'request' | 'response') => page.getByTestId(`flow-step-body-${side}`),
      expandSubflow: () => page.getByTestId('flow-step-expand-subflow'),
      empty: () => detail.locator('.detail-empty'),
      /** What the body area says in place of a capture — §9's five different absences. */
      absence: () => detail.locator('.detail-body-area > .detail-empty').first(),
      assertions: () => detail.locator('.detail-table'),
      headers: () => detail.locator('.detail-headers'),
      outputs: () => detail.locator('.detail-outputs'),
      row: (label: string) => detail.locator('.detail-row').filter({ has: page.locator('.detail-label', { hasText: label }) }),
      assertionRow: (expression: string) => detail.locator('.detail-table tr').filter({ hasText: expression })
    },

    /** §4.3's raw editor. */
    yaml: {
      pane: () => page.getByTestId('flow-yaml-pane'),
      editor: () => page.getByTestId('flow-yaml-pane').locator('.yaml-editor'),
      save: () => page.getByTestId('flow-yaml-save'),
      invalid: () => page.getByTestId('flow-yaml-invalid'),
      diverged: () => page.getByTestId('flow-yaml-diverged'),
      diagnostics: () => page.getByTestId('flow-yaml-diagnostics'),
      diagnostic: (index: number) => page.getByTestId(`flow-yaml-diagnostic-${index}`),
      /** §6's mark in the editor's own gutter, on the one-based line the diagnostic names. */
      gutterMarker: (line: number) => page.getByTestId(`flow-gutter-${line}`)
    },

    /**
     * §4.1 and §4.2's run mark, on the tab in the strip.
     *
     * Found by the tab it is on rather than by the flow's path: the mark's own testid carries the
     * absolute pathname, which a spec can only reconstruct from the fixture directory the app
     * happens to have been launched against — and the app is worker-scoped, so that is not always
     * this test's copy.
     */
    tabMark: (tabName: string) =>
      page.locator('.request-tab').filter({ hasText: tabName }).locator('.flow-tab-mark')
  };
};

/**
 * §4.1's section starts collapsed — only `collections` is expanded on launch — so every spec that
 * reads a flow row opens it first.
 */
export const openFlowsSection = async (page: Page) => {
  await test.step('Open the API Flows sidebar section', async () => {
    const flows = buildFlowLocators(page);
    // The window reports loaded before the workspace has been opened and its flows watched, so the
    // section itself is what says the sidebar is ready to be read.
    await flows.section.root().waitFor({ state: 'visible', timeout: 60000 });

    const expanded = flows.section.root().locator('.sidebar-section.expanded');
    if (await expanded.count() === 0) {
      await flows.section.header().click();
    }
    await expanded.first().waitFor({ state: 'visible' });
  });
};

/**
 * Opens a flow's run view from its sidebar row and waits for §6's description to have been drawn.
 *
 * A flow that does not parse draws no graph (§6), so the wait is on the tab pane rather than on the
 * drawing — a broken flow still opens, which is the point of that half of §6.
 */
export const openFlow = async (page: Page, relativePath: string) => {
  await test.step(`Open flow ${relativePath}`, async () => {
    const flows = buildFlowLocators(page);
    // The watcher reports the scope's flows after the workspace opens, so the row appears a moment
    // after the section does.
    await flows.section.row(relativePath).waitFor({ state: 'visible', timeout: 60000 });
    await flows.section.row(relativePath).click();
    await flows.header.root().waitFor({ state: 'visible' });
    await flows.run.button().or(flows.run.cancel()).first().waitFor({ state: 'visible' });
  });
};

/** §4.3's raw editor, which is reached from the row menu rather than by opening the flow. */
export const openFlowYamlEditor = async (page: Page, relativePath: string) => {
  await test.step(`Open the YAML editor for ${relativePath}`, async () => {
    const flows = buildFlowLocators(page);
    await flows.section.row(relativePath).hover();
    await flows.section.menuTrigger(relativePath).click();
    await flows.section.editYaml(relativePath).click();
    await flows.yaml.pane().waitFor({ state: 'visible' });
  });
};

/** Starts a run and returns once the engine has one — the control flips to Cancel at `run:start`. */
export const startFlowRun = async (page: Page, options: { capture?: boolean } = {}) => {
  await test.step(`Start a run${options.capture === false ? ' without capture' : ''}`, async () => {
    const flows = buildFlowLocators(page);
    if (options.capture === false) {
      await flows.run.options().click();
      await flows.run.withoutCapture().click();
    } else {
      await flows.run.button().click();
    }
  });
};

/**
 * Waits for a run to be over. The run control is the engine's own answer — 001 §13.2 guarantees a
 * terminal `run:end`, and §7.1's control returns to an enabled **Run** on it.
 *
 * `renderer:flow-run` resolves at `run:start` while the run's *state* reaches the view as one of
 * 002 §8.1's batched events, so an enabled **Run** is also true for the frame between the two.
 * Everything read after this is read through an auto-retrying assertion, which closes that frame;
 * a scenario that needs the run to be demonstrably over — R2 reads the event stream itself — has to
 * ask the run for its own answer rather than asking the control.
 */
export const waitForFlowRun = async (page: Page, options: { timeout?: number } = {}) => {
  await test.step('Wait for the run to end', async () => {
    const flows = buildFlowLocators(page);
    await flows.run.idle().waitFor({ state: 'visible', timeout: options.timeout ?? 60000 });
  });
};

/** The ordinary case: run the open flow and wait for its verdict. */
export const runFlow = async (page: Page, options: { capture?: boolean; timeout?: number } = {}) => {
  await startFlowRun(page, options);
  await waitForFlowRun(page, options);
};

/**
 * Asks for the run in flight to stop (§7.1) and returns as soon as the click has landed.
 *
 * 001 §11.3 allows up to `config.cleanupGrace` between the click and the end of the run, and what
 * the control says during that window is itself under test — so the two halves are separate actions
 * rather than one that waits through the state a scenario is trying to read.
 */
export const requestFlowCancel = async (page: Page) => {
  await test.step('Ask the run to stop', async () => {
    const flows = buildFlowLocators(page);
    await flows.run.cancel().click();
  });
};

/** Cancels the run in flight (§7.1) and waits for the engine to finish its cleanup window. */
export const cancelFlowRun = async (page: Page, options: { timeout?: number } = {}) => {
  await requestFlowCancel(page);
  await waitForFlowRun(page, options);
};

/**
 * §7.2's environment, chosen from §4.2's header — the one control of the run configuration that sits
 * on the flow's own header, where a collection keeps it.
 */
export const selectFlowEnvironment = async (page: Page, name: string) => {
  await test.step(`Select the ${name} environment`, async () => {
    await page.getByTestId('flow-environment').click();
    await buildEnvironmentLocators(page).listOption(name).click();
  });
};

/** §7.2's panel is collapsed until it is opened; every control in it is behind this. */
export const openRunConfiguration = async (page: Page) => {
  await test.step('Open the run configuration', async () => {
    const flows = buildFlowLocators(page);
    if (await flows.configuration.panel().count() === 0) {
      await flows.configuration.toggle().click();
    }
    await flows.configuration.panel().waitFor({ state: 'visible' });
  });
};

/** §7.2's `envVarOverrides`, typed into the row the Add button appends. */
export const addVariableOverride = async (page: Page, name: string, value: string) => {
  await test.step(`Override ${name}`, async () => {
    const flows = buildFlowLocators(page);
    const index = await flows.configuration.overrideRows().count();

    await flows.configuration.addOverride().click();
    await flows.configuration.overrideName(index).fill(name);
    await flows.configuration.overrideValue(index).fill(value);
  });
};

/**
 * The line §4.3's editor is showing, read from the editor itself rather than from the drawing of it:
 * §6's anchor moves the caret, and where the caret is is not something the DOM says on its own.
 */
export const flowYamlCursorLine = async (page: Page): Promise<number> => {
  const flows = buildFlowLocators(page);
  return flows.yaml.editor()
    .locator('.CodeMirror')
    .first()
    .evaluate((element) => (element as unknown as { CodeMirror: { getCursor: () => { line: number } } })
      .CodeMirror.getCursor().line + 1);
};

/** §9's pane opens on the node that is clicked; clicking the same node again clears the selection. */
export const selectStep = async (page: Page, stepId: string) => {
  await test.step(`Select step ${stepId}`, async () => {
    const flows = buildFlowLocators(page);
    await flows.graph.node(stepId).click();
  });
};

/**
 * Opens §9's pane on a step, whatever was selected before.
 *
 * `selectStep` is a click and nothing more, because clicking the selected node is how the selection
 * is cleared (U4.1a) — so a spec that wants the pane open on a step has to know whether it already
 * is. The flows slice keys the selection by path and `electronApp` is worker-scoped, so a flow one
 * test left with a step selected arrives at the next one that way.
 */
export const openStepDetail = async (page: Page, stepId: string) => {
  await test.step(`Open the step detail on ${stepId}`, async () => {
    const flows = buildFlowLocators(page);
    // The node says whether it is the selected one; the pane cannot be asked, because a step with
    // no result renders a bare "has not run in this iteration" and no pane at all.
    const classes = (await flows.graph.node(stepId).getAttribute('class')) || '';

    if (!classes.split(' ').includes('selected')) {
      await flows.graph.node(stepId).click();
    }
    await flows.detail.root().waitFor({ state: 'visible' });
  });
};

export const openStepTab = async (page: Page, name: 'request' | 'response' | 'assertions' | 'validation') => {
  await test.step(`Open the step's ${name} tab`, async () => {
    const flows = buildFlowLocators(page);
    await flows.detail.tab(name).click();
  });
};

/** The `data-status` of every node currently drawn, keyed by step id — §8.2's states, read as text. */
export const flowNodeStates = async (page: Page): Promise<Record<string, string>> =>
  page.getByTestId('flow-graph').evaluate((graph) =>
    Object.fromEntries(
      [...graph.querySelectorAll('g.node')].map((node) => [
        (node.getAttribute('data-testid') || '').replace('flow-node-', ''),
        node.getAttribute('data-status')
      ])
    ));

/**
 * Installs 002-C §2's committed run directory as the scope's own `.bruno-runs/`.
 *
 * The fixture was produced by `bru flow run --capture-dir`, so the only thing about it that cannot
 * be committed is where it ran: 001 §14.5 records the flow's absolute path in `run.json`, which is
 * what `listRuns` filters a flow's history on. Those paths are held as `{{workspaceRoot}}` in the
 * committed copy and resolved here — the layout, the captures and the snapshots are the engine's
 * own bytes, which is what makes the fixture a regression test on the capture format.
 */
export const installStoredRuns = async (fixtureDir: string, scopeRoot: string) => {
  const captureRoot = path.join(scopeRoot, '.bruno-runs');
  await fs.promises.cp(fixtureDir, captureRoot, { recursive: true });

  const files = await fs.promises.readdir(captureRoot, { recursive: true, withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const pathname = path.join((file as unknown as { parentPath: string }).parentPath || captureRoot, file.name);
    const content = await fs.promises.readFile(pathname, 'utf8');
    if (!content.includes('{{workspaceRoot}}')) continue;
    await fs.promises.writeFile(
      pathname,
      content.replaceAll('{{workspaceRoot}}', scopeRoot.split(path.sep).join('/')),
      'utf8'
    );
  }

  return captureRoot;
};

/**
 * 001 §14.5's inline copy of a step's last attempt, as `step:end` carries it — each half cut at
 * `config.capturePreviewBytes` and masked before the cut.
 */
export type RecordedRunEvent = {
  type: string;
  id?: string;
  preview?: { request?: string; response?: string };
};

export type RecordedRunEvents = {
  /** One entry per `main:flow-run-event` message, in the order the main process sent them. */
  messages: () => Promise<{ runId: string; events: RecordedRunEvent[] }[]>;
  restore: () => Promise<void>;
};

/**
 * Records what crosses the `main:flow-run-event` channel — 002-C §8's R1 and R2.
 *
 * Both are claims about the *boundary* rather than about anything on screen: that a payload never
 * carries a response body, and that the stream is batched. Neither is visible from the renderer, and
 * a run that attaches bodies to its events renders exactly like one that does not — which is the
 * whole reason those regressions are worth pinning.
 *
 * The patch is on the main process's `webContents.send`, so it must be put back: `electronApp` is
 * worker-scoped and outlives the test that installed it.
 */
export const recordFlowRunEvents = async (app: ElectronApplication): Promise<RecordedRunEvents> => {
  await app.evaluate(({ BrowserWindow }) => {
    const scope = globalThis as Record<string, any>;
    const contents = BrowserWindow.getAllWindows()[0].webContents;

    scope.__flowRunEventMessages = [];
    scope.__flowRunEventSend = contents.send.bind(contents);
    contents.send = (channel: string, ...args: unknown[]) => {
      if (channel === 'main:flow-run-event') {
        scope.__flowRunEventMessages.push(JSON.stringify(args[0]));
      }
      return scope.__flowRunEventSend(channel, ...args);
    };
  });

  return {
    messages: async () => {
      const recorded: string[] = await app.evaluate(() => (globalThis as Record<string, any>).__flowRunEventMessages);
      return recorded.map((message) => JSON.parse(message));
    },
    restore: () =>
      app.evaluate(({ BrowserWindow }) => {
        const scope = globalThis as Record<string, any>;
        BrowserWindow.getAllWindows()[0].webContents.send = scope.__flowRunEventSend;
        delete scope.__flowRunEventMessages;
        delete scope.__flowRunEventSend;
      })
  };
};

/** The rendered box of an SVG element, in the graph's own coordinates. */
export const nodeBox = async (node: Locator) => {
  const box = await node.boundingBox();
  if (!box) {
    throw new Error('expected the node to be rendered');
  }
  return box;
};
