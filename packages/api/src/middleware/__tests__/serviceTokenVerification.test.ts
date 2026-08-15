/**
 * `verifyServiceToken` — the API's single source of truth for what a service
 * token proves.
 *
 * It had no direct suite. Every other service-token test in this package either
 * mocks the middleware or rides the globally-stubbed `jsonwebtoken` from
 * `jest.setup.cjs`, so the one function that every service-authenticated route
 * funnels through was only ever exercised incidentally. The claims it accepts
 * ARE the authorization contract (ADR 0007), so they are asserted here against
 * real HS256 tokens.
 *
 * Two properties are under test:
 *  - the SIGNATURE is verified, not merely decoded — a forged or edited token
 *    is refused, and the mutation that swaps `jwt.verify` for `jwt.decode`
 *    turns these red;
 *  - the whole attribution tuple is REQUIRED — application, credential, owning
 *    account and environment. A signature-valid token missing one is not a
 *    usable service principal.
 */

// `jest.setup.cjs` stubs `jsonwebtoken` globally (sign → a fixed string,
// verify → a user payload). Signatures are the subject here, so restore the
// real module for this suite.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { verifyServiceToken } from '../serviceToken';

const SECRET = 'test_access_token_secret_minimum_32_characters';
const OTHER_SECRET = 'a_secret_the_oxy_issuer_has_never_used_at_all';

const CLAIMS = {
  type: 'service',
  appId: 'app-1',
  appName: 'relay',
  credentialId: 'cred-1',
  ownerAccountId: 'owner-account-1',
  environment: 'production',
  scopes: ['inference:invoke'],
} as const;

function signToken(
  overrides: Record<string, unknown> = {},
  secret = SECRET,
  options: jwt.SignOptions = { expiresIn: '5m' },
): string {
  return jwt.sign({ ...CLAIMS, ...overrides }, secret, options);
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
      appName: 'relay',
      credentialId: 'cred-1',
      ownerAccountId: 'owner-account-1',
      environment: 'production',
      scopes: ['inference:invoke'],
    });
  });

  it('drops non-string entries from scopes rather than trusting them', () => {
    const result = verifyServiceToken(signToken({ scopes: ['user:read', 7, null, {}] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.scopes).toEqual(['user:read']);
  });

  it('yields an empty scope list when the claim is not an array', () => {
    const result = verifyServiceToken(signToken({ scopes: 'user:read' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.scopes).toEqual([]);
  });
});

describe('signature verification is mandatory', () => {
  it('refuses a token signed with a different secret', () => {
    expect(verifyServiceToken(signToken({}, OTHER_SECRET))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses a token whose payload was edited after signing', () => {
    // The attack the `ownerAccountId` claim invites: take a real token and
    // rewrite the account it charges.
    const [header, , signature] = signToken().split('.');
    const tampered = Buffer.from(
      JSON.stringify({ ...CLAIMS, ownerAccountId: 'somebody-elses-account' }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(verifyServiceToken(`${header}.${tampered}.${signature}`)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('refuses an UNSIGNED token (alg: none)', () => {
    const unsigned = jwt.sign({ ...CLAIMS }, '', { algorithm: 'none' });

    expect(verifyServiceToken(unsigned)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses garbage that is not a JWT at all', () => {
    expect(verifyServiceToken('not-a-token')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('reports an EXPIRED token distinctly, so the caller can say so', () => {
    const expired = signToken({}, SECRET, { expiresIn: '-1s' });

    expect(verifyServiceToken(expired)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses everything when no verification secret is configured', () => {
    const token = signToken();
    delete process.env.ACCESS_TOKEN_SECRET;

    expect(verifyServiceToken(token)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('the attribution tuple is required', () => {
  it('refuses a user/session token replayed as a service token', () => {
    const userToken = jwt.sign({ userId: 'u-1', sessionId: 's-1' }, SECRET, { expiresIn: '5m' });

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
    ['appName', { appName: undefined }],
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
