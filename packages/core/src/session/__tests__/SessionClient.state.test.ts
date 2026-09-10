import type { DeviceSessionState } from '@oxy.so/contracts';
import { SessionClient, type SessionClientHost, type TokenTransport } from '../SessionClient';

function makeHost(): SessionClientHost {
  return {
    makeRequest: jest.fn(),
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => 't',
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: jest.fn(),
    getCurrentAccountId: () => null,
  };
}
const STATE = (rev: number, active: string | null = 'a1'): DeviceSessionState => ({
  deviceId: 'd1', accounts: active ? [{ accountId: 'a1', sessionId: 's1', authuser: 0 }] : [], activeAccountId: active, revision: rev, updatedAt: 1720000000000,
});

// SessionClient.applyState is protected; a tiny subclass exposes it for the unit test.
class TestClient extends SessionClient { public apply(raw: unknown): boolean { return this.applyState(raw); } }

describe('SessionClient state', () => {
  it('starts with null state', () => {
    expect(new SessionClient(makeHost()).getState()).toBeNull();
  });

  it('applies a valid state and notifies subscribers', () => {
    const c = new TestClient(makeHost());
    const seen: (DeviceSessionState | null)[] = [];
    c.subscribe((s) => seen.push(s));
    expect(c.apply(STATE(1))).toBe(true);
    expect(c.getState()?.revision).toBe(1);
    expect(seen.at(-1)?.revision).toBe(1);
  });

  it('ignores a stale or equal revision (last-writer-wins) WITHIN the same device', () => {
    const c = new TestClient(makeHost());
    c.apply({ ...STATE(5), deviceId: 'A' });
    expect(c.apply({ ...STATE(5), deviceId: 'A' })).toBe(false);
    expect(c.apply({ ...STATE(4), deviceId: 'A' })).toBe(false);
    expect(c.apply({ ...STATE(6), deviceId: 'A' })).toBe(true);
    expect(c.getState()?.revision).toBe(6);
  });

  it('accepts a LOWER-revision state from a DIFFERENT device (revision baseline resets cross-device)', () => {
    const c = new TestClient(makeHost());
    // Device A at a high revision.
    expect(c.apply({ ...STATE(10), deviceId: 'A' })).toBe(true);
    expect(c.getState()?.deviceId).toBe('A');
    // Device B, freshly converged (revision 1), must win over device A's
    // stale-but-higher revision — the cross-device comparison is not monotone.
    expect(c.apply({ ...STATE(1), deviceId: 'B' })).toBe(true);
    expect(c.getState()?.deviceId).toBe('B');
    expect(c.getState()?.revision).toBe(1);
  });

  it('rejects an invalid (unvalidated) state without applying', () => {
    const c = new TestClient(makeHost());
    expect(c.apply({ deviceId: 'd1', accounts: 'nope', revision: 1 })).toBe(false);
    expect(c.getState()).toBeNull();
  });

  it('calls transport.ensureActiveToken when a state is applied', () => {
    const transport: TokenTransport = { ensureActiveToken: jest.fn().mockResolvedValue(undefined) };
    const c = new TestClient(makeHost(), { transport });
    c.apply(STATE(1));
    expect(transport.ensureActiveToken).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));
  });

  it('unsubscribe stops notifications', () => {
    const c = new TestClient(makeHost());
    const seen: unknown[] = [];
    const off = c.subscribe((s) => seen.push(s));
    off();
    c.apply(STATE(1));
    expect(seen).toHaveLength(0);
  });
});
