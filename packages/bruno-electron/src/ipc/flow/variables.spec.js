const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildVariables } = require('./variables');

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
});
