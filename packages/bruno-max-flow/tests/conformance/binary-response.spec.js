/**
 * §8.2's `res.base64` — R9.18.
 *
 * `res.body` is the host's decoded text when a body is not JSON, and decoding a ZIP or a PDF as
 * UTF-8 loses bytes. `res.base64` gives an output script the raw body as a string, which crosses
 * into QuickJS and into `node:vm` in the same way. The engine does not unzip and does not parse CSV:
 * the fixture flow brings those helpers in `lib/binary.js`.
 */
const fs = require('fs');
const path = require('path');

const { normalizeFlow, parseDocument } = require('../../src/document');
const { runFlow, validate, variant, FLOWS } = require('./harness');

const FIXTURE = 'regressions/r9-binary-response.flow.yml';
const ZIP = fs.readFileSync(path.join(FLOWS, 'regressions', 'files', '1099-export.zip'));
/** Bytes that are not valid UTF-8: a lone continuation byte, `fe`/`ff`, and a broken two-byte sequence. */
const NOT_UTF8 = Buffer.from([0x00, 0x01, 0x80, 0xfe, 0xff, 0xc3, 0x28, 0x7f]);

const EXPORT = { data: { id: 'export-1', attributes: { recipientId: 'vendor-1', state: 'ready' } } };

/** What a host reports: `body` decoded as text where it is not JSON, and `bytes` as they arrived. */
const binary = (bytes, contentType) => ({
  status: 200,
  headers: { 'content-type': contentType },
  body: bytes.toString('utf8'),
  bytes
});
const json = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return { status: 200, headers: { 'content-type': 'application/json' }, body: value, bytes };
};

const responses = (overrides = {}) => ({
  startTaxExport: { status: 202, body: EXPORT },
  getTaxExport: json(EXPORT),
  downloadTaxExport: binary(ZIP, 'application/zip'),
  downloadTaxForm: binary(NOT_UTF8, 'application/octet-stream'),
  ...overrides
});

const withLimit = (limit) =>
  variant(FIXTURE, (document) => {
    document.config = { scriptBytesLimit: limit };
  });

describe('R9.18 — An output script reads the raw bytes of a response', () => {
  it('gives the bytes of a body that is not UTF-8, which res.body has lost', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });
    const { outputs } = run.step('form');

    expect(run.outcome('form')).toBe('success');
    expect(outputs.hex).toBe(NOT_UTF8.toString('hex'));
    expect(Buffer.from(outputs.text, 'utf8').equals(NOT_UTF8)).toBe(false);
    expect(outputs.sameInCtx).toBe(true);
  });

  it('reads the CSV in a real ZIP, and compares it to an earlier response', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });

    expect(run.table()).toEqual({ start: 'success', poll: 'success', download: 'success', form: 'success' });
    expect(run.step('download').outputs.rows).toEqual([
      { recipient_id: 'vendor-1', tin_last4: '6789', box1_amount: '1250.00' },
      { recipient_id: 'vendor-2', tin_last4: '4321', box1_amount: '980.50' }
    ]);
    expect(run.step('download').assertions.map((assertion) => assertion.passed)).toEqual([true]);
  });

  it('fails the comparison when the CSV holds a different value', async () => {
    const run = await runFlow(FIXTURE, {
      responses: responses({
        startTaxExport: { status: 202, body: { data: { id: 'export-1', attributes: { recipientId: 'vendor-9' } } } }
      })
    });

    expect(run.outcome('download')).toBe('failed:assertion-failed');
  });

  it('still parses a JSON response into res.body, and gives its bytes as well', async () => {
    const run = await runFlow(FIXTURE, { responses: responses() });
    const { outputs } = run.step('poll');

    expect(outputs.state).toBe('ready');
    expect(outputs.scriptedState).toBe('ready');
    expect(JSON.parse(outputs.rawJson)).toEqual(EXPORT);
  });

  it('leaves res.base64 absent above config.scriptBytesLimit, and the step says why', async () => {
    const { entry, files } = withLimit(ZIP.length - 1);
    const run = await runFlow(entry, { files, responses: responses() });
    const download = run.step('download');

    expect(download.status).toBe('failed');
    expect(download.reason).toBe('script-error');
    expect(download.message).toContain(
      `res.base64 is absent: the body is ${ZIP.length} bytes, above config.scriptBytesLimit (${ZIP.length - 1} bytes)`
    );
    // The limit applies to each body, so a smaller body in the same run still gets its bytes.
    expect(run.step('form').outputs.hex).toBe(NOT_UTF8.toString('hex'));
  });

  it('reports why on a step that passes, when its script allows the absence', async () => {
    const { entry, files } = variant(FIXTURE, (document) => {
      // Above the JSON body of `poll` and below the ZIP, so only `download` loses the field.
      document.config = { scriptBytesLimit: 200 };
      const download = document.steps.find((step) => step.id === 'download');
      download.outputs = { present: { script: '(res) => res.base64 !== undefined' } };
      delete download.assert;
    });
    const run = await runFlow(entry, { files, responses: responses() });
    const download = run.step('download');

    expect(download.status).toBe('success');
    expect(download.outputs.present).toBe(false);
    expect(download.message).toContain('above config.scriptBytesLimit (200 bytes)');
  });

  it('gives a body exactly at the limit', async () => {
    const { entry, files } = withLimit(ZIP.length);
    const run = await runFlow(entry, { files, responses: responses() });

    expect(run.outcome('download')).toBe('success');
    expect(run.step('download').message).toBeUndefined();
  });

  it('is absent, with no message, when the host reported no bytes', async () => {
    const { entry, files } = variant(FIXTURE, (document) => {
      document.steps.find((step) => step.id === 'form').outputs = { kind: { script: '(res) => typeof res.base64' } };
    });
    const run = await runFlow(entry, {
      files,
      responses: responses({ downloadTaxForm: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'form' } })
    });

    expect(run.step('form').outputs.kind).toBe('undefined');
    expect(run.step('form').message).toBeUndefined();
  });

  /** Encoding costs time and memory, so a step pays it only where a script can read the field. */
  describe('is encoded only for a step whose scripts can read it', () => {
    const keysOnly = (keepLibrary) =>
      variant(FIXTURE, (document) => {
        if (!keepLibrary) delete document.functions;
        document.steps = [{ id: 'poll', operation: 'exports-api#getTaxExport', pathParams: { exportId: 'export-1' },
          outputs: { keys: { script: '(res) => Object.keys(res).sort()' } } }];
      });

    it('leaves it off when no output script and no library names it', async () => {
      const { entry, files } = keysOnly(false);
      const run = await runFlow(entry, { files, responses: responses() });

      expect(run.step('poll').outputs.keys).toEqual(['body', 'headers', 'responseTime', 'status', 'statusText']);
    });

    it('puts it on when the flow\'s functions: library names it', async () => {
      const { entry, files } = keysOnly(true);
      const run = await runFlow(entry, { files, responses: responses() });

      expect(run.step('poll').outputs.keys).toContain('base64');
    });
  });

  describe('config.scriptBytesLimit', () => {
    it('is 10 MB when the flow does not set it', () => {
      const flow = normalizeFlow(parseDocument('version: 1\nsteps: []\n'), path.join(FLOWS, FIXTURE));

      expect(flow.config.scriptBytesLimit).toBe(10 * 1024 * 1024);
    });

    it('takes the value the flow sets', () => {
      const text = 'version: 1\nconfig:\n  scriptBytesLimit: 2048\nsteps: []\n';

      expect(normalizeFlow(parseDocument(text), path.join(FLOWS, FIXTURE)).config.scriptBytesLimit).toBe(2048);
    });

    it('refuses a value that is not a whole number of bytes', async () => {
      const { entry, files } = withLimit(-1);

      expect((await validate(entry, { files })).map((diagnostic) => diagnostic.code)).toContain('schema-violation');
    });

    it('accepts the fixture as written', async () => {
      expect((await validate(FIXTURE)).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
    });
  });
});
