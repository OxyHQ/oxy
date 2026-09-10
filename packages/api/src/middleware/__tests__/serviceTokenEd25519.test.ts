import { generateKeyPairSync } from 'node:crypto';
import {
  SERVICE_TOKEN_PRIVATE_KEY_VARIABLE,
  SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE,
  SERVICE_TOKEN_SIGNING_KEY_ID_VARIABLE,
  serviceTokenPublicJwks,
  signServiceTokenEd25519,
} from '../../config/serviceTokenSigning';
import { verifyServiceToken } from '../serviceToken';

const keyPair = generateKeyPairSync('ed25519');
const privatePem = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const names = [
  SERVICE_TOKEN_PRIVATE_KEY_VARIABLE,
  SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE,
  SERVICE_TOKEN_SIGNING_KEY_ID_VARIABLE,
] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env[SERVICE_TOKEN_PRIVATE_KEY_VARIABLE] = privatePem;
  process.env[SERVICE_TOKEN_SIGNING_KEY_ID_VARIABLE] = 'service-2026-09-a';
  delete process.env[SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE];
});

afterAll(() => {
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return {
    type: 'service',
    appId: 'app-exact',
    appName: 'Homiio',
    credentialId: 'credential-exact',
    ownerAccountId: 'account-exact',
    environment: 'production',
    scopes: ['inference:invoke'],
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: now,
    exp: now + 3_600,
    ...overrides,
  };
}

describe('Oxy API Ed25519 service tokens', () => {
  it('mints a kid-bound token and verifies its whole service principal', () => {
    const token = signServiceTokenEd25519(claims());
    expect(token).not.toBeNull();
    const header = JSON.parse(Buffer.from(token!.split('.')[0]!, 'base64url').toString('utf8'));
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: 'service-2026-09-a' });
    expect(verifyServiceToken(token!)).toMatchObject({
      ok: true,
      payload: { appId: 'app-exact', ownerAccountId: 'account-exact' },
    });
  });

  it('publishes active and pre-published rotation keys without private material', () => {
    const next = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
    process.env[SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE] = JSON.stringify({
      keys: [{ ...next, use: 'sig', alg: 'EdDSA', kid: 'service-2026-09-b' }],
    });
    expect(serviceTokenPublicJwks().map((key) => key.kid)).toEqual([
      'service-2026-09-a',
      'service-2026-09-b',
    ]);
    expect(JSON.stringify(serviceTokenPublicJwks())).not.toContain('"d"');
  });

  it('rejects duplicate kids, including a public copy of the active key', () => {
    const active = serviceTokenPublicJwks()[0]!;
    process.env[SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE] = JSON.stringify({ keys: [active, active] });
    expect(() => serviceTokenPublicJwks()).toThrow(/duplicate|not a public Ed25519/i);

    process.env[SERVICE_TOKEN_PUBLIC_JWKS_VARIABLE] = JSON.stringify({ keys: [active] });
    expect(() => serviceTokenPublicJwks()).toThrow(/duplicates active kid/);
  });

  it.each([
    ['wrong issuer', { iss: 'attacker' }],
    ['wrong audience', { aud: 'attacker' }],
    ['future nbf', { nbf: Math.floor(Date.now() / 1_000) + 600 }],
    ['whitespace scope', { scopes: [' inference:invoke'] }],
    ['duplicate scopes', { scopes: ['inference:invoke', 'inference:invoke'] }],
    ['application id leading whitespace', { appId: ' app-exact' }],
    ['application id trailing whitespace', { appId: 'app-exact ' }],
    ['credential id leading whitespace', { credentialId: ' credential-exact' }],
    ['credential id trailing whitespace', { credentialId: 'credential-exact ' }],
    ['owner id leading whitespace', { ownerAccountId: ' account-exact' }],
    ['owner id trailing whitespace', { ownerAccountId: 'account-exact ' }],
  ])('rejects %s', (_label, override) => {
    const token = signServiceTokenEd25519(claims(override));
    expect(verifyServiceToken(token!)).toMatchObject({ ok: false });
  });
});
