import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../playwright';
import {
  addVariableOverride,
  buildCommonLocators,
  flowNodeStates,
  openFlow,
  openFlowsSection,
  openRunConfiguration,
  openStepTab,
  recordFlowRunEvents,
  runFlow,
  selectFlowEnvironment,
  selectStep
} from '../utils/page';

/**
 * 002-C §8 — the regressions no single scenario owns.
 *
 * Each of these has a wrong implementation that every other test in this suite passes: bodies
 * attached to events, an unbatched stream, a secret masked in the pane and not in the panel CI
 * reads, a renderer that grew a parser of its own, and a status word the UI invented.
 */

/**
 * 001 §5.2's default `config.capturePreviewBytes` — the cap a `step:end` preview is cut at, and so
 * the largest body any payload on this channel may carry. The fixtures declare no override, which is
 * what makes the default the number to hold them to.
 */
const PREVIEW_BYTES = 8192;

/** 001 §14.6's terminal statuses, verbatim. `pending` is a node nothing has reported on yet. */
const TERMINAL_STATUSES = ['success', 'failed', 'skipped', 'cancelled'];

/** 001 §14.6's reasons, verbatim. */
const REASONS = [
  'condition-false',
  'unmet-dependency',
  'unresolved-dependency',
  'run-cancelled',
  'assertion-failed',
  'unexpected-status',
  'invalid-request',
  'schema-validation-failed',
  'transport-error',
  'max-duration-exceeded',
  'retries-exhausted',
  'file-read-failed',
  'script-error',
  'subflow-failed'
];

test.describe('Regressions not owned by a single scenario', () => {
  test.describe.configure({ timeout: 90_000 });

  test('R2 batches the event stream, and loses nothing doing it', async ({ restartApp }) => {
    // The channel is instrumented in the main process, so the app has to be the one this test holds
    // a handle to — `pageWithUserData` hands back a page rather than the application behind it.
    const app = await restartApp({});
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

    const { flows } = buildCommonLocators(page);
    const recorded = await recordFlowRunEvents(app);

    try {
      await openFlowsSection(page);
      await openFlow(page, 'fulfillment.flow.yml');
      await runFlow(page);

      // The stream is what is under test, so the stream is what says the run is over: 001 §13.2
      // guarantees `run:end` is last, and reading before it arrives would count half a run's events
      // and call the batching correct on the strength of it.
      const terminated = async () =>
        (await recorded.messages()).flatMap((message) => message.events).some((event) => event.type === 'run:end');
      await expect.poll(terminated).toBe(true);

      const messages = await recorded.messages();
      const events = messages.flatMap((message) => message.events);

      await test.step('the run produces materially fewer messages than events', async () => {
        expect(events.length, 'the run produced events').toBeGreaterThan(0);
        expect(messages.length).toBeLessThan(events.length);
      });

      await test.step('and every event still arrives', async () => {
        const started = events.filter((event) => event.type === 'step:start');
        const ended = new Set(events.filter((event) => event.type === 'step:end').map((event) => event.id));

        // A step that was skipped ends without ever starting — 001 §14.6's `unmet-dependency` is
        // reported on a step that never ran — so the two counts are not equal by construction. What
        // must hold is that nothing was dropped in between.
        expect(started.length).toBeGreaterThan(0);
        for (const event of started) {
          expect([...ended], `${event.id} announced a start and an end`).toContain(event.id);
        }

        for (const stepId of Object.keys(await flowNodeStates(page))) {
          expect([...ended], `the graph drew ${stepId}, so its end arrived`).toContain(stepId);
        }

        expect(events.filter((event) => event.type === 'run:start')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'iteration:start')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'iteration:end')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'run:end')).toHaveLength(1);
      });

      await test.step('and the step pane reads its body from the capture, not from the stream', async () => {
        await selectStep(page, 'create_order');
        await openStepTab(page, 'response');
        await expect(flows.detail.body('response')).toContainText('web-checkout');
      });
    } finally {
      await recorded.restore();
    }
  });

  test('R1 carries no body over the cap, and masks the ones it carries', async ({ restartApp }) => {
    // Instrumented in the main process, so the app has to be the one this test holds a handle to.
    const app = await restartApp({});
    const page = await app.firstWindow();
    await page.locator('[data-app-state="loaded"]').waitFor({ timeout: 30000 });

    const { flows } = buildCommonLocators(page);
    const recorded = await recordFlowRunEvents(app);

    /** Every string anywhere in a recorded payload — a body attached to any field, not only to a preview. */
    const strings = (value: unknown): string[] => {
      if (typeof value === 'string') return [value];
      if (Array.isArray(value)) return value.flatMap(strings);
      return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    };

    const previewsOf = (messages: { events: { preview?: { request?: string; response?: string } }[] }[]) =>
      messages
        .flatMap((message) => message.events)
        .flatMap((event) => [event.preview?.request, event.preview?.response])
        .filter((preview): preview is string => typeof preview === 'string');

    // The stream says when a run is over, for R2's reason: reading before `run:end` would judge the
    // boundary on half a run's messages.
    const runsEnded = async () =>
      (await recorded.messages())
        .flatMap((message) => message.events)
        .filter((event) => event.type === 'run:end').length;

    try {
      await openFlowsSection(page);

      await test.step('run a flow whose body is far larger than the cap', async () => {
        await openFlow(page, 'overrides.flow.yml');
        // `region` is interpolated into the request body and echoed back by the operation, so both
        // halves of the attempt are an order of magnitude past `capturePreviewBytes`. Without a body
        // that large the cap holds vacuously and the implementation this pins against passes.
        await openRunConfiguration(page);
        await addVariableOverride(page, 'region', 'W'.repeat(PREVIEW_BYTES * 3));
        await runFlow(page);
      });

      await expect.poll(runsEnded).toBe(1);
      const afterLargeBody = await recorded.messages();

      await test.step('the previews are cut at config.capturePreviewBytes', async () => {
        const previews = previewsOf(afterLargeBody);
        expect(previews.length, '001-C R9.4 puts a masked, capped preview on step:end').toBeGreaterThan(0);
        // The body was big enough to be cut, so a preview reaching the cap is what says the cut
        // happened here rather than that the payload was small all along.
        expect(previews.some((preview) => Buffer.byteLength(preview, 'utf8') > PREVIEW_BYTES - 16)).toBe(true);
      });

      await test.step('and nothing else on the wire carries the body either', async () => {
        for (const message of afterLargeBody) {
          for (const text of strings(message)) {
            expect(Buffer.byteLength(text, 'utf8'), `a payload string is within the ${PREVIEW_BYTES}-byte cap`)
              .toBeLessThanOrEqual(PREVIEW_BYTES);
          }
        }
      });

      await test.step('and the step pane still shows the whole body, read from the capture', async () => {
        await selectStep(page, 'create_order');
        await openStepTab(page, 'response');
        await expect(flows.detail.body('response')).toContainText('WWWW');
      });

      await test.step('run a flow whose request carries a secret', async () => {
        await openFlow(page, 'redaction.flow.yml');
        // The secret lives in this environment; an unresolved `{{secretToken}}` would satisfy the
        // masking half by never being a secret at all.
        await selectFlowEnvironment(page, 'Local');
        await runFlow(page);
      });

      await expect.poll(runsEnded).toBe(2);
      const messages = await recorded.messages();

      await test.step('every body the channel carries is masked', async () => {
        expect(JSON.stringify(messages)).not.toContain('your_secret_token');
        // Masked rather than merely absent: a preview that dropped the header instead of masking it
        // would pass the assertion above and hide the redaction failing.
        expect(previewsOf(messages).some((preview) => preview.includes('••••'))).toBe(true);
      });
    } finally {
      await recorded.restore();
    }
  });

  test('R3 holds redaction in the app, in the capture it read, and in the network panel', async ({
    pageWithUserData: page
  }) => {
    const { flows, devtools, environment } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'redaction.flow.yml');

    await test.step('run it against the environment holding the secret', async () => {
      await page.getByTestId('flow-environment').click();
      await environment.listOption('Local').click();
      await runFlow(page);
    });

    await test.step('the step pane shows the header redacted, with no way to reveal it', async () => {
      await selectStep(page, 'read_order');
      await openStepTab(page, 'request');

      await expect(flows.detail.headers()).toContainText(/authorization/i);
      // Masked rather than absent: an unresolved variable would also fail a "does not contain the
      // secret" check, and would prove nothing about redaction.
      await expect(flows.detail.row('Authorization')).toContainText('••••');
      await expect(flows.detail.headers()).not.toContainText('your_secret_token');
      await expect(flows.detail.headers().getByRole('button')).toHaveCount(0);
    });

    await test.step('and the header the flow itself named is masked too, not only the built-in denylist', async () => {
      await expect(flows.detail.headers()).toContainText(/x-legacy-key/i);
      await expect(flows.detail.row('X-Legacy-Key')).toContainText('••••');
    });

    await test.step('the DevTools network tab shows the same masking', async () => {
      await devtools.trigger().click();
      await devtools.networkTab().click();

      const row = devtools.networkRows().filter({ hasText: '/api/echo/headers' }).first();
      await expect(row).toBeVisible();
      await row.click();

      await expect(devtools.requestHeadersTable()).toBeVisible();
      await expect(devtools.requestHeaders.value('Authorization')).not.toContainText('your_secret_token');
      await expect(devtools.requestHeaders.value('X-Legacy-Key')).not.toContainText('your_secret_token');
    });
  });

  test('R4 computes no semantics in the renderer', async () => {
    // A structural claim rather than a behavioural one, so it needs no app.
    // `packages/bruno-app/src/fork/flows/noYamlParser.spec.js` is its unit-level twin; this is the
    // conformance suite's own copy, over the whole tree as §8 words it.
    const root = path.join(__dirname, '..', '..', 'packages', 'bruno-app', 'src', 'fork', 'flows');
    const yamlPackages = ['js-yaml', 'yaml', 'yaml-js', 'yamljs'];

    const files = (await fs.promises.readdir(root, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.jsx?$/.test(entry.name) && !entry.name.endsWith('.spec.js'))
      .map((entry) => path.join((entry as unknown as { parentPath: string }).parentPath, entry.name));

    expect(files.length, 'the flows tree has modules to check').toBeGreaterThan(0);

    for (const file of files) {
      const source = await fs.promises.readFile(file, 'utf8');
      for (const parser of yamlPackages) {
        expect(source, `${path.relative(root, file)} must not import a YAML parser`).not.toMatch(
          new RegExp(`(from|require\\()\\s*['"]${parser}['"]`)
        );
      }
    }
  });

  test('R6 uses the engine\'s statuses and reasons verbatim', async ({ pageWithUserData: page }) => {
    const { flows } = buildCommonLocators(page);

    await openFlowsSection(page);
    await openFlow(page, 'fulfillment.flow.yml');
    await runFlow(page);

    const reported = await flows.graph.root().evaluate((graph) =>
      [...graph.querySelectorAll('g.node')]
        .map((node) => ({
          status: node.getAttribute('data-status'),
          text: (node.querySelector('.node-status')?.textContent || '').trim()
        }))
        .filter((node) => node.text !== ''));

    expect(reported.length, 'the run reported on its steps').toBeGreaterThan(0);

    await test.step('no step whose end was received reads pending, running or retrying', async () => {
      for (const node of reported) {
        expect(TERMINAL_STATUSES, `${node.text} is a terminal status`).toContain(node.status);
      }
    });

    await test.step('and every reason drawn beside one is one the engine wrote', async () => {
      const reasons = reported
        .map((node) => node.text.split(' · ')[1])
        .filter((reason): reason is string => Boolean(reason));

      expect(reasons.length, 'the run produced at least one reason').toBeGreaterThan(0);
      for (const reason of reasons) {
        expect(REASONS, `${reason} is one of 001 §14.6's reasons`).toContain(reason);
      }
    });

    await test.step('and the status word beside it is the step\'s own, not the flow\'s', async () => {
      const statuses = reported.map((node) => node.text.split(' · ')[0]);
      expect(statuses).not.toContain('passed');
      expect(statuses).not.toContain('cancelled · run');
    });
  });

  test.fixme(
    'R5 keeps the upstream touchpoint set matching the manifest — awaiting a stable upstream merge base to diff against',
    async () => {
      // §12.1's manifest is a list of upstream files this fork may touch, and the assertion is a
      // `git diff` against the merge base with `usebruno/bruno` main. Nothing in the repository
      // records which commit that is, so the check would pin whatever the developer's local remote
      // happens to hold — and pass or fail on that rather than on the manifest.
    }
  );
});
