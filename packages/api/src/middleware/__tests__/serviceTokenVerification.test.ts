/**
 * `verifyServiceToken` — the API's single source of truth for what a service
 * token proves.
 *
 * The claims it accepts ARE the authorization contract (ADR 0007), so they are
 * asserted here against real Ed25519 tokens signed by the API's own signer —
 * with no key configured, outside production, that is the per-process
 * ephemeral key, which is exactly what every other suite in this package mints
 * with.
 *
 * Three properties are under test:
 *  - the SIGNATURE is verified, not merely decoded — a forged or edited token
 *    is refused;
 *  - EdDSA is the ONLY algorithm (ADR 0012). An HS256 token claiming
 *    `type: 'service'` is refused even when it is signed with the real
 *    platform secret: that is the retired transition, and holding
 *    `ACCESS_TOKEN_SECRET` must not be a way to mint a service principal;
 *  - the whole attribution tuple is REQUIRED — application, credential, owning
 *    account and environment. A signature-valid token missing one is not a
 *    usable service principal.
 */

import { createHmac, generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { serviceTokenSigningConfig, signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { verifyServiceToken } from '../serviceToken';

const SECRET = 'test_access_token_secret_minimum_32_characters';

const CLAIMS = {
  type: 'service',
  appId: 'app-1',
  appName: 'kaana',
  credentialId: 'cred-1',
  ownerAccountId: 'owner-account-1',
  environment: 'production',
  scopes: ['inference:invoke'],
} as const;

function timed(overrides: Record<string, unknown>, lifetimeSeconds = 300): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1_000);
  return {
    ...CLAIMS,
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: now,
    exp: now + lifetimeSeconds,
    ...overrides,
  };
}

function signToken(overrides: Record<string, unknown> = {}, lifetimeSeconds = 300): string {
  return signServiceTokenEd25519(timed(overrides, lifetimeSeconds));
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** Hand-signs with an arbitrary Ed25519 key under an arbitrary header. */
function signWith(key: KeyObject, header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const input = `${segment(header)}.${segment(payload)}`;
  return `${input}.${signBytes(null, Buffer.from(input), key).toString('base64url')}`;
}

/** The retired shape: HS256 over the service claims. */
function signHs256(payload: Record<string, unknown>, secret: string): string {
  const input = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

const originalSecret = process.env.ACCESS_TOKEN_SECRET;

beforeEach(() => {
  process.env.ACCESS_TOKEN_SECRET = SECRET;
});

afterAll(() => {
  process.env.ACCESS_TOKEN_SECRET = originalSecret;
});

describe('the accepted shape', () => {
  it('returns the whole attribution tuple for a well-formed token', () => {
    const result = verifyServiceToken(signToken());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toMatchObject({
      type: 'service',
      appId: 'app-1',
      appName: 'kaana',
      credentialId: 'cred-1',
      ownerAccountId: 'owner-account-1',
      environment: 'production',
      scopes: ['inference:invoke'],
    });
  });

  it('rejects non-string entries in scopes rather than weakening authority', () => {
    const result = verifyServiceToken(signToken({ scopes: ['user:read', 7, null, {}] }));
    expect(result).toEqual({ ok: false, reason: 'not_service' });
  });

  it('rejects a non-array scope claim', () => {
    const result = verifyServiceToken(signToken({ scopes: 'user:read' }));
    expect(result).toEqual({ ok: false, reason: 'not_service' });
  });
});

describe('the ecosystem boundary (tier)', () => {
  it("reads an internal application's tier", () => {
    const result = verifyServiceToken(signToken({ tier: 'internal' }));
    expect(result.ok && result.payload.tier).toBe('internal');
  });

  it('reads a token with no tier, or an unknown one, as external — the conservative answer', () => {
    for (const overrides of [{}, { tier: 'external' }, { tier: 'INTERNAL' }, { tier: true }]) {
      const result = verifyServiceToken(signToken(overrides));
      expect(result.ok && result.payload.tier).toBe('external');
    }
  });
});

describe('signature verification is mandatory', () => {
  it('refuses a token signed by a key Oxy never published, under the real kid', () => {
    const { keyId } = serviceTokenSigningConfig();
    const stranger = generateKeyPairSync('ed25519').privateKey;
    const forged = signWith(stranger, { alg: 'EdDSA', typ: 'JWT', kid: keyId }, timed({}));

    expect(verifyServiceToken(forged)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a token naming a kid that is not published', () => {
    const stranger = generateKeyPairSync('ed25519').privateKey;
    const forged = signWith(stranger, { alg: 'EdDSA', typ: 'JWT', kid: 'not-a-published-kid' }, timed({}));

    expect(verifyServiceToken(forged)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a token whose payload was edited after signing', () => {
    // The attack the `ownerAccountId` claim invites: take a real token and
    // rewrite the account it charges.
    const [header, , signature] = signToken().split('.');
    const tampered = segment(timed({ ownerAccountId: 'somebody-elses-account' }));

    expect(verifyServiceToken(`${header}.${tampered}.${signature}`)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses an UNSIGNED token (alg: none)', () => {
    const unsigned = `${segment({ alg: 'none', typ: 'JWT' })}.${segment(timed({}))}.`;

    expect(verifyServiceToken(unsigned).ok).toBe(false);
  });

  it('refuses an HS256 service token even when it is signed with the real platform secret', () => {
    // The retired transition (ADR 0012). Before it closed, this token was a
    // valid service principal; a process holding ACCESS_TOKEN_SECRET could
    // mint one naming any ownerAccountId.
    const legacy = signHs256(timed({}), SECRET);

    const result = verifyServiceToken(legacy);
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, reason: 'not_service' });
  });

  it('refuses an EdDSA header that carries anything beyond alg, typ and kid', () => {
    const { keyId, privateKey } = serviceTokenSigningConfig();
    const smuggled = signWith(
      privateKey,
      { alg: 'EdDSA', typ: 'JWT', kid: keyId, jku: 'https://attacker.example/jwks.json' },
      timed({}),
    );

    expect(verifyServiceToken(smuggled)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses garbage that is not a JWT at all', () => {
    expect(verifyServiceToken('not-a-token')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports an EXPIRED token distinctly, so the caller can say so', () => {
    const expired = signToken({}, -1);

    expect(verifyServiceToken(expired)).toEqual({ ok: false, reason: 'expired' });
  });

  it('does not depend on ACCESS_TOKEN_SECRET at all', () => {
    const token = signToken();
    delete process.env.ACCESS_TOKEN_SECRET;

    expect(verifyServiceToken(token).ok).toBe(true);
  });
});

describe('the attribution tuple is required', () => {
  it('refuses a user/session token replayed as a service token', () => {
    const now = Math.floor(Date.now() / 1_000);
    const userToken = signHs256(
      { userId: 'u-1', sessionId: 's-1', iss: 'oxy-auth', aud: 'oxy-api', iat: now, exp: now + 300 },
      SECRET,
    );

    expect(verifyServiceToken(userToken)).toEqual({ ok: false, reason: 'not_service' });
  });

  it.each([
    ['ownerAccountId', { ownerAccountId: undefined }],
    ['ownerAccountId (empty)', { ownerAccountId: '' }],
    ['ownerAccountId (not a string)', { ownerAccountId: 42 }],
    ['environment', { environment: undefined }],
    ['environment (outside the known set)', { environment: 'prod' }],
    ['credentialId', { credentialId: undefined }],
    ['credentialId (empty)', { credentialId: '' }],
    ['appId', { appId: undefined }],
    ['appId (leading whitespace)', { appId: ' app-1' }],
    ['appId (trailing whitespace)', { appId: 'app-1 ' }],
    ['appName', { appName: undefined }],
    ['credentialId (leading whitespace)', { credentialId: ' cred-1' }],
    ['credentialId (trailing whitespace)', { credentialId: 'cred-1 ' }],
    ['ownerAccountId (leading whitespace)', { ownerAccountId: ' owner-account-1' }],
    ['ownerAccountId (trailing whitespace)', { ownerAccountId: 'owner-account-1 ' }],
  ])('refuses a signature-valid token missing %s', (_label, overrides) => {
    expect(verifyServiceToken(signToken(overrides))).toEqual({
      ok: false,
      reason: 'not_service',
    });
  });

  it('accepts the same token with every claim present — the control', () => {
    // Without this, the block above would pass identically against a verifier
    // that refused everything.
    expect(verifyServiceToken(signToken()).ok).toBe(true);
  });
});
