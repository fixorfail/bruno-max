/**
 * HTML reporter — 001 §14.1, the same `SuiteResult` the JSON reporter serializes, rendered as one
 * self-contained page: readable offline, safe to attach to a CI build, nothing fetched from a CDN
 * a locked-down pipeline might block. Light/dark tracks `prefers-color-scheme`; expanding a failed
 * or skipped step's detail is a `<details>` element, so the page needs no script at all.
 *
 * Redaction (§14.4) is the engine's job, done before this file ever sees the suite — what this
 * file owes is that nothing it interpolates reaches the page unescaped. A response body or an
 * error message can contain anything a server sent, `escapeHtml` is the only thing standing
 * between that and the page it's rendered into, so every interpolated string goes through it —
 * including JSON already stringified for display.
 *
 * A `--retries` flow that passed after failing keeps its ordinary pass badge — the counts already
 * say it passed — plus a second, distinctly coloured "Flaky" badge and the attempt it passed on,
 * so a reader scanning for red doesn't stop there but can still see which passes weren't clean. A
 * `--retry-failed` suite names what it retried once, in the page header, rather than on every flow.
 */
const fs = require('fs');
const path = require('path');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
const escapedJson = (value) => escapeHtml(JSON.stringify(value, null, 2));

/** A path outside the working directory reads better absolute than as a chain of `..`. */
const forDisplay = (file, cwd) => {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') ? relative : file;
};

const duration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

const FLOW_OUTCOME_LABEL = { passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled', invalid: 'Invalid' };
const STEP_STATUS_LABEL = { success: 'Success', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };

const renderChips = (tags) =>
  tags.length ? `<span class="chips">${tags.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}</span>` : '';

/** The flow's own test-management case id — present only when the flow declared one. */
const renderFlowTestId = (testId) =>
  testId === undefined ? '' : `<span class="chips"><span class="chip">testId: ${escapeHtml(testId)}</span></span>`;

/** Which attempt produced this outcome — present only when `--retries` re-ran the flow. */
const renderAttempt = (attempt) =>
  attempt === undefined ? '' : `<span class="chips"><span class="chip">attempt ${escapeHtml(attempt)}</span></span>`;

/** The host that ran the flow — present only when the host supplied it. */
const renderOrigin = (origin) => {
  if (!origin) return '';
  const entries = [
    ['host', origin.host],
    ['environment', origin.environment],
    ['globalEnvironment', origin.globalEnvironment]
  ].filter(([, value]) => value !== undefined);
  if (!entries.length) return '';
  return `<span class="chips">${entries
    .map(([key, value]) => `<span class="chip">${escapeHtml(key)}: ${escapeHtml(value)}</span>`)
    .join('')}</span>`;
};

/** A step's `meta:` is an open mapping — scalars print as themselves, anything else as its JSON. */
const metaValue = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));

const renderMeta = (meta) => {
  const entries = meta ? Object.entries(meta) : [];
  if (!entries.length) return '';
  return `<span class="chips">${entries
    .map(([key, value]) => `<span class="chip">${escapeHtml(key)}: ${escapeHtml(metaValue(value))}</span>`)
    .join('')}</span>`;
};

const renderDiagnostics = (diagnostics) => {
  if (!diagnostics.length) return '';
  const rows = diagnostics
    .map(
      (entry) => `
      <li class="diagnostic diagnostic-${escapeHtml(entry.severity)}">
        <span class="diagnostic-code">${escapeHtml(entry.code)}</span>
        <span class="diagnostic-message">${escapeHtml(entry.message)}</span>
        ${entry.path ? `<span class="diagnostic-path">${escapeHtml(entry.path)}</span>` : ''}
      </li>`
    )
    .join('');
  return `<ul class="diagnostics">${rows}</ul>`;
};

const renderAssertions = (assertions) => {
  const failed = assertions.filter((entry) => !entry.passed);
  if (!failed.length) return '';
  const rows = failed
    .map(
      (entry) => `
      <li>
        <div class="assertion-expr">${escapeHtml(entry.expr)}</div>
        <div class="assertion-values">
          <span>expected <code>${escapedJson(entry.expected)}</code></span>
          <span>actual <code>${escapedJson(entry.actual)}</code></span>
        </div>
      </li>`
    )
    .join('');
  return `<div class="detail-block"><h5>Assertions</h5><ul class="assertions">${rows}</ul></div>`;
};

const renderSchemaErrors = (validation) => {
  if (!validation) return '';
  const sides = ['request', 'response']
    .flatMap((side) => (validation[side]?.errors || []).map((error) => ({ side, ...error })))
    .filter(Boolean);
  if (!sides.length) return '';
  const rows = sides
    .map((entry) => `<li><span class="schema-side">${escapeHtml(entry.side)}</span> ${escapeHtml(entry.path)} — ${escapeHtml(entry.message)}</li>`)
    .join('');
  return `<div class="detail-block"><h5>Schema errors</h5><ul class="schema-errors">${rows}</ul></div>`;
};

const renderStepDetail = (step) => {
  const parts = [
    step.message ? `<div class="detail-block"><h5>Message</h5><p>${escapeHtml(step.message)}</p></div>` : '',
    renderAssertions(step.assertions),
    renderSchemaErrors(step.validation),
    step.capturePath ? `<div class="detail-block"><h5>Capture</h5><p><code>${escapeHtml(step.capturePath)}</code></p></div>` : ''
  ].join('');
  if (!parts) return '';
  return `
    <tr class="step-detail-row">
      <td colspan="7">
        <details>
          <summary>Details</summary>
          ${parts}
        </details>
      </td>
    </tr>`;
};

const renderStepRow = (step) => `
    <tr class="step-row step-${escapeHtml(step.status)}">
      <td><code>${escapeHtml(step.id)}</code></td>
      <td>${step.name ? escapeHtml(step.name) : ''}</td>
      <td><span class="badge badge-${escapeHtml(step.status)}">${escapeHtml(STEP_STATUS_LABEL[step.status] || step.status)}</span></td>
      <td>${step.reason ? escapeHtml(step.reason) : ''}</td>
      <td>${step.attempts}</td>
      <td>${duration(step.durationMs)}</td>
      <td>${renderMeta(step.meta)}</td>
    </tr>${(step.status === 'failed' || step.status === 'skipped') ? renderStepDetail(step) : ''}`;

const renderIterationCaption = (iteration) => {
  if (!iteration.row) return '';
  const columns = Object.entries(iteration.row)
    .map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(value)}`)
    .join(', ');
  return `<caption>row: ${columns}</caption>`;
};

const renderIteration = (iteration) => `
  <div class="iteration">
    <h4>Iteration ${iteration.index + 1} <span class="badge badge-${escapeHtml(iteration.status)}">${escapeHtml(iteration.status)}</span></h4>
    <div class="table-scroll">
      <table class="steps">
        ${renderIterationCaption(iteration)}
        <thead>
          <tr><th>Id</th><th>Name</th><th>Status</th><th>Reason</th><th>Attempts</th><th>Duration</th><th>Meta</th></tr>
        </thead>
        <tbody>
          ${iteration.steps.map(renderStepRow).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

const renderFlow = (flow, env) => `
  <section class="flow">
    <h3>
      ${escapeHtml(flow.name)}
      <span class="badge badge-${escapeHtml(flow.outcome)}">${escapeHtml(FLOW_OUTCOME_LABEL[flow.outcome] || flow.outcome)}</span>
      ${flow.flaky ? '<span class="badge badge-flaky">Flaky</span>' : ''}
    </h3>
    <div class="flow-meta">
      <span class="flow-id"><code>${escapeHtml(flow.id)}</code></span>
      <span class="flow-file">${escapeHtml(forDisplay(flow.file, env.cwd))}</span>
      <span class="flow-duration">${duration(flow.durationMs)}</span>
      ${renderAttempt(flow.attempt)}
      ${renderFlowTestId(flow.testId)}
      ${renderChips(flow.tags)}
      ${renderOrigin(flow.result?.origin)}
    </div>
    ${renderDiagnostics(flow.diagnostics)}
    ${flow.result ? flow.result.iterations.map(renderIteration).join('') : ''}
  </section>`;

const renderSummaryCard = (label, value, cssClass) => `
      <div class="card ${cssClass || ''}">
        <div class="card-value">${value}</div>
        <div class="card-label">${escapeHtml(label)}</div>
      </div>`;

const renderSummary = (summary) => `
  <div class="summary">
    <div class="summary-group">
      <h2>Flows</h2>
      <div class="cards">
        ${renderSummaryCard('Total', summary.flows.total)}
        ${renderSummaryCard('Passed', summary.flows.passed, 'card-passed')}
        ${renderSummaryCard('Failed', summary.flows.failed, 'card-failed')}
        ${renderSummaryCard('Cancelled', summary.flows.cancelled, 'card-cancelled')}
        ${renderSummaryCard('Invalid', summary.flows.invalid, 'card-invalid')}
      </div>
    </div>
    <div class="summary-group">
      <h2>Steps</h2>
      <div class="cards">
        ${renderSummaryCard('Total', summary.steps.total)}
        ${renderSummaryCard('Passed', summary.steps.passed, 'card-passed')}
        ${renderSummaryCard('Failed', summary.steps.failed, 'card-failed')}
        ${renderSummaryCard('Skipped', summary.steps.skipped, 'card-skipped')}
        ${renderSummaryCard('Cancelled', summary.steps.cancelled, 'card-cancelled')}
      </div>
    </div>
  </div>`;

const STYLE = `
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --fg: #1a1a1a;
      --muted: #6b7280;
      --border: #e2e2e2;
      --card-bg: #f6f6f7;
      --code-bg: #f0f0f1;
      --passed: #1a7f37;
      --failed: #cf222e;
      --cancelled: #9a6700;
      --skipped: #57606a;
      --invalid: #cf222e;
      --flaky: #0969da;
      --chip-bg: #eef0f2;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1117;
        --fg: #e6edf3;
        --muted: #9198a1;
        --border: #30363d;
        --card-bg: #161b22;
        --code-bg: #161b22;
        --passed: #3fb950;
        --failed: #f85149;
        --cancelled: #d29922;
        --skipped: #8b949e;
        --invalid: #f85149;
        --flaky: #58a6ff;
        --chip-bg: #21262d;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      background: var(--bg);
      color: var(--fg);
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    }
    header h1 { margin: 0 0 4px; font-size: 20px; }
    header .meta { color: var(--muted); font-size: 13px; }
    code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--code-bg); padding: 1px 4px; border-radius: 4px; }
    .summary { display: flex; flex-wrap: wrap; gap: 24px; margin: 24px 0; }
    .summary-group h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 8px; }
    .cards { display: flex; gap: 8px; flex-wrap: wrap; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 14px; min-width: 72px; text-align: center; }
    .card-value { font-size: 18px; font-weight: 600; }
    .card-label { color: var(--muted); font-size: 12px; }
    .card-passed .card-value { color: var(--passed); }
    .card-failed .card-value { color: var(--failed); }
    .card-cancelled .card-value { color: var(--cancelled); }
    .card-invalid .card-value { color: var(--invalid); }
    .card-skipped .card-value { color: var(--skipped); }
    .flow { border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .flow h3 { margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
    .flow-meta { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .chips { display: flex; gap: 4px; flex-wrap: wrap; }
    .chip { background: var(--chip-bg); border-radius: 999px; padding: 2px 10px; font-size: 12px; }
    .badge { display: inline-block; border-radius: 999px; padding: 1px 10px; font-size: 12px; font-weight: 600; }
    .badge-passed, .badge-success { color: var(--passed); background: color-mix(in srgb, var(--passed) 15%, transparent); }
    .badge-failed { color: var(--failed); background: color-mix(in srgb, var(--failed) 15%, transparent); }
    .badge-cancelled { color: var(--cancelled); background: color-mix(in srgb, var(--cancelled) 15%, transparent); }
    .badge-invalid { color: var(--invalid); background: color-mix(in srgb, var(--invalid) 15%, transparent); }
    .badge-skipped { color: var(--skipped); background: color-mix(in srgb, var(--skipped) 15%, transparent); }
    .badge-flaky { color: var(--flaky); background: color-mix(in srgb, var(--flaky) 15%, transparent); }
    .table-scroll { overflow-x: auto; margin: 8px 0 16px; }
    table.steps { width: 100%; border-collapse: collapse; font-size: 13px; }
    table.steps caption { text-align: left; color: var(--muted); font-size: 12px; padding-bottom: 4px; }
    table.steps th, table.steps td { border-bottom: 1px solid var(--border); padding: 6px 8px; text-align: left; }
    tr.step-detail-row td { border-bottom: 1px solid var(--border); padding: 0 8px 12px; }
    tr.step-detail-row summary { cursor: pointer; color: var(--muted); }
    .detail-block { margin-top: 8px; }
    .detail-block h5 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; color: var(--muted); }
    .assertions, .schema-errors, .diagnostics { list-style: none; padding: 0; margin: 0; }
    .assertions li, .schema-errors li { margin-bottom: 6px; }
    .assertion-values { display: flex; gap: 16px; color: var(--muted); }
    .diagnostic { padding: 6px 0; border-bottom: 1px solid var(--border); }
    .diagnostic-code { font-weight: 600; margin-right: 8px; }
    .diagnostic-error .diagnostic-code { color: var(--failed); }
    .diagnostic-warning .diagnostic-code { color: var(--cancelled); }
    .diagnostic-path { color: var(--muted); margin-left: 8px; font-size: 12px; }
    footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
`;

const formatHtml = (suite, env) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(env.command)} report</title>
<style>${STYLE}</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(env.command)}</h1>
    <div class="meta">
      started ${escapeHtml(suite.startedAt)} · finished ${escapeHtml(suite.finishedAt)} ·
      duration ${duration(suite.durationMs)} · exit code ${suite.exitCode}
    </div>
    ${suite.retryOf ? `<div class="meta">retry of ${escapeHtml(suite.retryOf)}</div>` : ''}
  </header>
  ${renderSummary(suite.summary)}
  <main>
    ${suite.flows.map((flow) => renderFlow(flow, env)).join('')}
  </main>
  <footer>Generated ${escapeHtml(new Date(env.now()).toISOString())}</footer>
</body>
</html>
`;

module.exports = (context) => ({
  onSuiteEnd: async (suite) => {
    const env = { now: () => Date.now(), command: 'bru flow run', cwd: process.cwd() };
    fs.writeFileSync(context.outputPath, formatHtml(suite, env));
  }
});

module.exports.formatHtml = formatHtml;
