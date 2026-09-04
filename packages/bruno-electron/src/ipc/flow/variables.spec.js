const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildVariables, collectSecrets } = require('./variables');

/** 002-C U5.1–U5.3 — the tiers cross IPC as tiers, and the `.env` tier comes from main. */
describe('flow variable tiers', () => {
  let scopeRoot;

  beforeEach(() => {
    scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-vars-'));
  });

  afterEach(() => {
    fs.rmSync(scopeRoot, { recursive: true, force: true });
  });

  it('keeps a name defined in two tiers in both of them', () => {
    const variables = buildVariables({
      scope: { workspaceRoot: scopeRoot },
      tiers: {
        environment: { name: 'Local', variables: [{ name: 'baseUrl', value: 'https://env', enabled: true }] },
        collectionVars: [{ name: 'baseUrl', value: 'https://collection', enabled: true }]
      }
    });

    expect(variables.environment).toEqual({ baseUrl: 'https://env' });
    expect(variables.collectionVars).toEqual({ baseUrl: 'https://collection' });
  });

  it('carries a secret variable through with its value', () => {
    const variables = buildVariables({
      scope: { workspaceRoot: scopeRoot },
      tiers: {
        environment: { name: 'Local', variables: [{ name: 'token', value: 'abracadabra', enabled: true, secret: true }] }
      }
    });

    expect(variables.environment).toEqual({ token: 'abracadabra' });
  });

  it('drops the __name__ key getEnvVars adds for bru.getEnvName()', () => {
    const variables = buildVariables({
      scope: { workspaceRoot: scopeRoot },
      tiers: { environment: { name: 'Local', variables: [{ name: 'a', value: '1', enabled: true }] } }
    });

    expect(variables.environment).not.toHaveProperty('__name__');
  });

  it('reads .env from the scope, with the collection winning over the workspace', () => {
    const collectionRoot = path.join(scopeRoot, 'payments');
    fs.mkdirSync(collectionRoot);
    fs.writeFileSync(path.join(scopeRoot, '.env'), 'REGION=eu\nSHARED=workspace\n');
    fs.writeFileSync(path.join(collectionRoot, '.env'), 'SHARED=collection\n');

    const variables = buildVariables({ scope: { workspaceRoot: scopeRoot, collectionRoot }, tiers: {} });

    expect(variables.processEnv.REGION).toBe('eu');
    expect(variables.processEnv.SHARED).toBe('collection');
  });

  it('leaves a tier the renderer did not send undefined rather than empty', () => {
    const variables = buildVariables({ scope: { workspaceRoot: scopeRoot }, tiers: {} });

    expect(variables.environment).toBeUndefined();
    expect(variables.collectionVars).toBeUndefined();
    expect(variables.globalEnvironment).toBeUndefined();
  });

  /** `secrets` is a sibling of `variables` in `RunOptions`, not a tier — it stays off this shape. */
  it('keeps the secret values off the tier table it hands the engine', () => {
    const variables = buildVariables({
      scope: { workspaceRoot: scopeRoot },
      tiers: {
        environment: { name: 'Local', variables: [{ name: 'token', value: 'abracadabra', enabled: true, secret: true }] }
      }
    });

    expect(variables).not.toHaveProperty('secrets');
  });
});

/** 001 §14.4's provenance set — the values a host knows are secret, for the engine to mask. */
describe('the secret values a run is given', () => {
  const secret = (name, value) => ({ name, value, enabled: true, secret: true });

  it('collects a secret value from the environment tier', () => {
    expect(collectSecrets({ tiers: { environment: { name: 'Local', variables: [secret('token', 'abracadabra')] } } })).toEqual([
      'abracadabra'
    ]);
  });

  it('collects a secret value from the global environment tier', () => {
    expect(
      collectSecrets({ tiers: { globalEnvironment: { name: 'Shared', variables: [secret('apiKey', 'open-sesame')] } } })
    ).toEqual(['open-sesame']);
  });

  it('leaves a variable nobody marked secret out of it', () => {
    const secrets = collectSecrets({
      tiers: { environment: { name: 'Local', variables: [{ name: 'baseUrl', value: 'https://env', enabled: true }] } }
    });

    expect(secrets).toEqual([]);
  });

  /** A disabled entry contributes no value to the run, so there is nothing of it to find in output. */
  it('leaves a disabled secret out of it', () => {
    const secrets = collectSecrets({
      tiers: { environment: { name: 'Local', variables: [{ ...secret('token', 'abracadabra'), enabled: false }] } }
    });

    expect(secrets).toEqual([]);
  });

  /** Masking the empty string would redact every empty header and body the report ever shows. */
  it('drops an empty or whitespace-only secret', () => {
    const secrets = collectSecrets({
      tiers: {
        environment: {
          name: 'Local',
          variables: [secret('blank', ''), secret('spaces', '   '), secret('missing', undefined), secret('real', 'kept')]
        }
      }
    });

    expect(secrets).toEqual(['kept']);
  });

  /** One secret shared across two tiers is one value to mask, however many entries hold it. */
  it('collapses the same value declared in two tiers', () => {
    const secrets = collectSecrets({
      tiers: {
        globalEnvironment: { name: 'Shared', variables: [secret('token', 'abracadabra')] },
        environment: { name: 'Local', variables: [secret('sameToken', 'abracadabra')] }
      }
    });

    expect(secrets).toEqual(['abracadabra']);
  });

  /**
   * A typed secret is masked as it is written, not as it is stored: `secrets` is a list of strings
   * and a number left as one would match nothing the report ever emits.
   */
  it('renders a typed secret as the string a report would carry', () => {
    const secrets = collectSecrets({
      tiers: { environment: { name: 'Local', variables: [{ ...secret('pin', 4242), dataType: 'number' }] } }
    });

    expect(secrets).toEqual(['4242']);
  });

  it('has nothing to collect when the renderer sent no environment at all', () => {
    expect(collectSecrets({ tiers: {} })).toEqual([]);
    expect(collectSecrets({})).toEqual([]);
  });
});
