import type { DeviceSessionState } from '@oxy.so/contracts';
import { SessionClient, type SessionClientHost, type TokenTransport } from '../SessionClient';
import { computeIdentityTag } from '../../utils/cacheKey';

/**
 * The account-switch 404 race (regression guard).
 *
 * When a `session_state` push re-elects the active account from A to B, the
 * push carries NO token — the app still holds A's bearer. If a subscriber were
 * notified before B's bearer is planted, a `useCurrentUser`-style refetch would
 * fire under A's token against B's session and 404.
 *
 * INVARIANT: no subscriber is ever notified while the planted bearer identifies
 * an account OTHER than the observed active account. This test records, at every
 * notify, the observed active account alongside the account the CURRENT bearer
 * belongs to (via the same `computeIdentityTag` derivation `applyState` uses)
 * and asserts they always match — and that the switch notify is DEFERRED until
 * the mint lands B's token.
 */

/** A minimal jwt-decode-able token whose `userId` claim is `accountId`. */
function jwtFor(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ userId: accountId })).toString('base64url');
  return `h.${payload}.s`;
}

const stateWith = (rev: number, active: string): DeviceSessionState => ({
  deviceId: 'd1',
  accounts: [
    { accountId: 'a1', sessionId: 's-a1', authuser: 0 },
    { accountId: 'b1', sessionId: 's-b1', authuser: 1 },
  ],
  activeAccountId: active,
  revision: rev,
  updatedAt: 1720000000000,
});

class TestClient extends SessionClient {
  public apply(raw: unknown): boolean {
    return this.applyState(raw);
  }
}

describe('SessionClient — no notify under a mismatched bearer on an account switch', () => {
  it('defers the switch notify until the mint lands the new active account bearer', async () => {
    // Mutable planted bearer, starting on account A.
    let planted: string | null = jwtFor('a1');
    const host: SessionClientHost = {
      makeRequest: jest.fn(),
      getBaseURL: () => 'http://test.invalid',
      getAccessToken: () => planted,
      getDeviceCredential: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: (token) => {
        planted = token;
      },
      getCurrentAccountId: () => null,
    };

    // The mint lands the ACTIVE account's bearer, asynchronously (models the
    // real device-secret mint round trip).
    const transport: TokenTransport = {
      ensureActiveToken: jest.fn(async (state: DeviceSessionState) => {
        await Promise.resolve();
        if (state.activeAccountId) {
          planted = jwtFor(state.activeAccountId);
        }
      }),
    };

    const c = new TestClient(host, { transport });

    const observations: Array<{ active: string | null; bearer: string }> = [];
    c.subscribe((s) => {
      observations.push({
        active: s?.activeAccountId ?? null,
        bearer: computeIdentityTag(host.getAccessToken()),
      });
    });

    // Apply A (bearer already A's) → matches → synchronous notify.
    c.apply(stateWith(1, 'a1'));
    expect(observations).toEqual([{ active: 'a1', bearer: 'a1' }]);

    // A `session_state` push re-elects B while the bearer is still A's.
    c.apply(stateWith(2, 'b1'));
    // The switch notify MUST NOT have fired yet — the bearer is still A's, so a
    // synchronous notify would let a subscriber observe B under A's token.
    expect(observations).toEqual([{ active: 'a1', bearer: 'a1' }]);

    // Flush the mint + deferred notify.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // The mint ran, and the switch notify fired only AFTER B's bearer was planted.
    expect(transport.ensureActiveToken).toHaveBeenCalledWith(
      expect.objectContaining({ activeAccountId: 'b1' }),
    );
    expect(observations).toContainEqual({ active: 'b1', bearer: 'b1' });

    // At NO notify did the observed active account differ from the bearer's account.
    for (const o of observations) {
      expect(o.bearer).toBe(o.active);
    }
  });

  it('does not defer when the bearer already belongs to the new active account', () => {
    let planted: string | null = jwtFor('b1');
    const host: SessionClientHost = {
      makeRequest: jest.fn(),
      getBaseURL: () => 'http://test.invalid',
      getAccessToken: () => planted,
      getDeviceCredential: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: (token) => {
        planted = token;
      },
      getCurrentAccountId: () => null,
    };
    const transport: TokenTransport = { ensureActiveToken: jest.fn().mockResolvedValue(undefined) };
    const c = new TestClient(host, { transport });

    const seen: Array<string | null> = [];
    c.subscribe((s) => seen.push(s?.activeAccountId ?? null));

    // Bearer is already B's → the notify is synchronous (no mint-before-notify).
    c.apply(stateWith(3, 'b1'));
    expect(seen).toEqual(['b1']);
  });

  it('reverts state and does not notify when minting fails on an account switch', async () => {
    let planted: string | null = jwtFor('a1');
    const host: SessionClientHost = {
      makeRequest: jest.fn(),
      getBaseURL: () => 'http://test.invalid',
      getAccessToken: () => planted,
      getDeviceCredential: () => null,
      onTokensChanged: () => () => undefined,
      setTokens: (token) => {
        planted = token;
      },
      getCurrentAccountId: () => null,
    };

    const transport: TokenTransport = {
      ensureActiveToken: jest.fn(async () => {
        await Promise.resolve();
        throw new Error('mint failed');
      }),
    };

    const c = new TestClient(host, { transport });
    const seen: Array<string | null> = [];
    c.subscribe((s) => seen.push(s?.activeAccountId ?? null));

    c.apply(stateWith(1, 'a1'));
    expect(seen).toEqual(['a1']);

    c.apply(stateWith(2, 'b1'));
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    // Still on A — no notify under A's bearer for B's active account.
    expect(seen).toEqual(['a1']);
    expect(c.getState()?.activeAccountId).toBe('a1');
    expect(computeIdentityTag(host.getAccessToken())).toBe('a1');
  });
});
