/**
 * `OxyServices.onTokensChanged` token-mirroring subscription tests.
 *
 * `onTokensChanged(listener)` is the single hook @oxy.so/services' OxyProvider
 * uses to keep the shared `oxyClient` singleton's token store in lockstep with
 * whichever OxyServices instance actually owns the session. It must fire on
 * EVERY access-token mutation — explicit `setTokens`, `clearTokens`, and the
 * token-planting auth flows (`verifyChallenge` / `claimSessionByToken`) which
 * route through `setTokens` internally — passing the resulting token or `null`.
 *
 * These tests exercise the listener against a real OxyServices instance. The
 * one network-dependent path (`verifyChallenge`) stubs `makeRequest` so the
 * internal planting is observed end-to-end through the public subscription.
 */

import { OxyServices } from '../../OxyServices';

function makeOxy(): OxyServices {
  return new OxyServices({ baseURL: 'https://api.oxy.so' });
}

describe('OxyServices.onTokensChanged', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fires with the access token on setTokens', () => {
    const oxy = makeOxy();
    const listener = jest.fn();
    oxy.onTokensChanged(listener);

    oxy.setTokens('access_1');

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('access_1');
  });

  it('fires with null on clearTokens', () => {
    const oxy = makeOxy();
    oxy.setTokens('access_1');

    const listener = jest.fn();
    oxy.onTokensChanged(listener);

    oxy.clearTokens();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('reflects the live token on every change (set → set → clear)', () => {
    const oxy = makeOxy();
    const seen: Array<string | null> = [];
    oxy.onTokensChanged((token) => seen.push(token));

    oxy.setTokens('access_1');
    oxy.setTokens('access_2');
    oxy.clearTokens();

    expect(seen).toEqual(['access_1', 'access_2', null]);
  });

  it('stops firing after the returned unsubscribe is called', () => {
    const oxy = makeOxy();
    const listener = jest.fn();
    const unsubscribe = oxy.onTokensChanged(listener);

    oxy.setTokens('access_1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    oxy.setTokens('access_2');
    oxy.clearTokens();

    // No further notifications after unsubscribe.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies multiple independent listeners without clobbering', () => {
    const oxy = makeOxy();
    const a = jest.fn();
    const b = jest.fn();
    oxy.onTokensChanged(a);
    oxy.onTokensChanged(b);

    oxy.setTokens('access_1');

    expect(a).toHaveBeenCalledWith('access_1');
    expect(b).toHaveBeenCalledWith('access_1');
  });

  it('isolates a throwing listener so others (and the auth flow) still proceed', () => {
    const oxy = makeOxy();
    const bad = jest.fn(() => {
      throw new Error('listener boom');
    });
    const good = jest.fn();
    oxy.onTokensChanged(bad);
    oxy.onTokensChanged(good);

    // Must not throw out of setTokens.
    expect(() => oxy.setTokens('access_1')).not.toThrow();
    expect(good).toHaveBeenCalledWith('access_1');
  });

  it('fires when verifyChallenge plants the first token from /auth/verify', async () => {
    const oxy = makeOxy();
    const listener = jest.fn();
    oxy.onTokensChanged(listener);

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

    await oxy.verifyChallenge('pubkey', 'challenge', 'sig', 123, 'Device', 'fp');

    // The planted token propagated through the subscription with no extra call.
    expect(listener).toHaveBeenCalledWith('access_verify');
  });
});
