/**
 * `verifyChallenge` token-planting regression tests.
 *
 * `OxyServices.verifyChallenge()` returns a `SessionLoginResponse` carrying the
 * first `accessToken` minted by `POST /auth/verify`. It must
 * plant that token internally — mirroring its sibling `claimSessionByToken` —
 * so callers (e.g. @oxy.so/services' `useAuthOperations.performSignIn`) end up
 * with an authenticated client. Session IDs are not public token-minting
 * credentials, so the initial bearer must come from the verify response body.
 *
 * These tests stub `makeRequest` so the planting logic is exercised end-to-end
 * against a real OxyServices instance, with token state observed via the public
 * `hasValidToken()` / `getAccessToken()` surface.
 */

import { OxyServices } from '../../OxyServices';

interface VerifyResponse {
  sessionId: string;
  deviceId: string;
  expiresAt: string;
  accessToken?: string;
  user: { id: string; username: string };
}

function makeOxy(): OxyServices {
  return new OxyServices({ baseURL: 'https://api.oxy.so' });
}

describe('OxyServices.verifyChallenge token planting', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('plants the access token from the /auth/verify response body', async () => {
    const oxy = makeOxy();
    expect(oxy.hasValidToken()).toBe(false);

    jest.spyOn(oxy, 'makeRequest').mockImplementation(async (_method, url) => {
      if (url === '/auth/verify') {
        return {
          sessionId: 'sess_1',
          deviceId: 'dev_1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          accessToken: 'access_verify',
          user: { id: 'user_1', username: 'tester' },
        } as never;
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const session = await oxy.verifyChallenge('pubkey', 'challenge', 'sig', 123, 'Device', 'fp');

    // Response still carries the access token for callers that want it.
    expect(session.accessToken).toBe('access_verify');
    // ...and it is now planted on the client so subsequent requests are
    // authenticated without a second round-trip.
    expect(oxy.hasValidToken()).toBe(true);
    expect(oxy.getAccessToken()).toBe('access_verify');
  });

  it('plants the access token when no refresh token is present', async () => {
    const oxy = makeOxy();

    jest.spyOn(oxy, 'makeRequest').mockImplementation(async (_method, url) => {
      if (url === '/auth/verify') {
        return {
          sessionId: 'sess_2',
          deviceId: 'dev_2',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          accessToken: 'access_only',
          user: { id: 'user_2', username: 'tester2' },
        } as never;
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const session = await oxy.verifyChallenge('pubkey', 'challenge', 'sig', 456);

    expect(session.accessToken).toBe('access_only');
    expect(oxy.hasValidToken()).toBe(true);
    expect(oxy.getAccessToken()).toBe('access_only');
  });

  it('does NOT plant (and stays unauthenticated) when the response carries no access token', async () => {
    const oxy = makeOxy();

    jest.spyOn(oxy, 'makeRequest').mockImplementation(async (_method, url) => {
      if (url === '/auth/verify') {
        // Token-less new identity (onboarding) — no access token in the body.
        return {
          sessionId: 'sess_3',
          deviceId: 'dev_3',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          user: { id: 'user_3', username: 'tester3' },
        } as VerifyResponse as never;
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const session = await oxy.verifyChallenge('pubkey', 'challenge', 'sig', 789);

    expect(session.accessToken).toBeUndefined();
    // No token to plant — the client stays unauthenticated. Crucially the
    // method does NOT reach for the bearer-protected session-token endpoint.
    expect(oxy.hasValidToken()).toBe(false);
  });

  it('matches claimSessionByToken: both plant access tokens via the same path', async () => {
    const oxy = makeOxy();

    jest.spyOn(oxy, 'makeRequest').mockImplementation(async (_method, url) => {
      if (url === '/auth/session/claim') {
        return {
          accessToken: 'access_claim',
          sessionId: 'sess_claim',
          deviceId: 'dev_claim',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          user: { id: 'user_claim', username: 'claimed' },
        } as never;
      }
      throw new Error(`unexpected request to ${url}`);
    });

    await oxy.claimSessionByToken('session-token-abc');

    expect(oxy.hasValidToken()).toBe(true);
    expect(oxy.getAccessToken()).toBe('access_claim');
  });
});
