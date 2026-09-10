/**
 * `SessionClient` under an IDENTITY pin.
 *
 * The bug this guards: an account switch performed by ANOTHER app on the same
 * device arrives as a `session_state` push (or as an `activeToken` on a sync
 * response) and silently re-bound the identity vault's bearer to that account.
 *
 * The contract: device state is still tracked TRUTHFULLY (other apps' accounts
 * and the real `activeAccountId` remain visible in `getState()`), but the bearer
 * NEVER follows it. The pinned token's lifecycle belongs to the cold boot /
 * re-mint lane, which mints it with an explicit `accountId`.
 */
import type { DeviceSessionState } from '@oxy.so/contracts';
import { SessionClient, type SessionClientHost, type TokenTransport } from '../SessionClient';

const PINNED = 'vault-user';
const OTHER = 'other-user';

/** A minimal jwt-decode-able token whose `userId` claim is `accountId`. */
function jwtFor(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ userId: accountId })).toString('base64url');
  return `h.${payload}.s`;
}

const stateWith = (revision: number, active: string): DeviceSessionState => ({
  deviceId: 'dev-1',
  accounts: [
    { accountId: PINNED, sessionId: 'sess-vault', authuser: 0 },
    { accountId: OTHER, sessionId: 'sess-other', authuser: 1 },
  ],
  activeAccountId: active,
  revision,
  updatedAt: 1_720_000_000_000,
});

function makeHost(initialToken: string | null): SessionClientHost & { planted: () => string | null } {
  let planted = initialToken;
  return {
    makeRequest: jest.fn(),
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => planted,
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: (token: string) => {
      planted = token;
    },
    getCurrentAccountId: () => PINNED,
    planted: () => planted,
  };
}

/** `applyState` is protected; a tiny subclass exposes it for the unit tests. */
class TestClient extends SessionClient {
  public apply(raw: unknown, origin?: 'request' | 'push', activeToken?: string): boolean {
    return this.applyState(raw, origin, activeToken);
  }
}

describe('SessionClient — pinned bearer', () => {
  // Node's real `BroadcastChannel` (which `postCommitPing` opens) is ref'd and
  // would keep the Jest event loop alive forever. Feature-detect it away — the
  // cross-tab wake has its own suite.
  const realBroadcastChannel = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
  beforeAll(() => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
  });
  afterAll(() => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = realBroadcastChannel;
  });

  it('tracks a pushed switch in state but does NOT change the planted token', () => {
    const host = makeHost(jwtFor(PINNED));
    const client = new TestClient(host, { getPinnedAccountId: () => PINNED });

    expect(client.apply(stateWith(1, PINNED), 'push')).toBe(true);
    // Another app switched the device to `other-user`.
    expect(client.apply(stateWith(2, OTHER), 'push')).toBe(true);

    // The state is truthful...
    expect(client.getState()?.activeAccountId).toBe(OTHER);
    // ...and the bearer is untouched.
    expect(host.planted()).toBe(jwtFor(PINNED));
  });

  it('does NOT plant a sync-supplied activeToken for a non-pinned account', () => {
    const host = makeHost(jwtFor(PINNED));
    const client = new TestClient(host, { getPinnedAccountId: () => PINNED });

    client.apply(stateWith(3, OTHER), 'request', jwtFor(OTHER));

    expect(host.planted()).toBe(jwtFor(PINNED));
  });

  it('DOES plant a sync-supplied activeToken when the active account IS the pinned one', () => {
    const host = makeHost(null);
    const client = new TestClient(host, { getPinnedAccountId: () => PINNED });

    client.apply(stateWith(4, PINNED), 'request', jwtFor(PINNED));

    expect(host.planted()).toBe(jwtFor(PINNED));
  });

  it('never invokes the TokenTransport (whose job is converging on activeAccountId)', () => {
    const host = makeHost(jwtFor(PINNED));
    const transport: TokenTransport = { ensureActiveToken: jest.fn().mockResolvedValue(undefined) };
    const client = new TestClient(host, { transport, getPinnedAccountId: () => PINNED });

    client.apply(stateWith(5, OTHER), 'push');

    expect(transport.ensureActiveToken).not.toHaveBeenCalled();
  });

  it('notifies subscribers synchronously on a foreign switch (no mint-before-notify gate)', () => {
    const host = makeHost(jwtFor(PINNED));
    const transport: TokenTransport = { ensureActiveToken: jest.fn().mockResolvedValue(undefined) };
    const client = new TestClient(host, { transport, getPinnedAccountId: () => PINNED });

    const seen: Array<string | null> = [];
    client.subscribe((state) => seen.push(state?.activeAccountId ?? null));

    client.apply(stateWith(6, OTHER), 'push');

    expect(seen).toEqual([OTHER]);
  });

  it('account mode is unchanged: an activeToken for the new active account IS planted', () => {
    const host = makeHost(jwtFor(PINNED));
    const client = new TestClient(host);

    client.apply(stateWith(7, OTHER), 'request', jwtFor(OTHER));

    expect(host.planted()).toBe(jwtFor(OTHER));
  });

  it('registerAndActivate only ADDS while pinned (never re-elects the device active account)', async () => {
    const host = makeHost(jwtFor(PINNED));
    const makeRequest = jest.fn().mockResolvedValue({
      state: stateWith(8, OTHER),
      activeToken: null,
    });
    const client = new SessionClient(
      { ...host, makeRequest },
      { getPinnedAccountId: () => PINNED },
    );

    await client.registerAndActivate(PINNED);

    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(makeRequest).toHaveBeenCalledWith('POST', '/session/device/add', undefined, { cache: false });
    expect(makeRequest).not.toHaveBeenCalledWith(
      'POST',
      '/session/device/switch',
      expect.anything(),
      expect.anything(),
    );
  });

  it('account mode is unchanged: registerAndActivate still switches to the target', async () => {
    const host = makeHost(jwtFor(PINNED));
    const makeRequest = jest.fn().mockResolvedValue({
      state: stateWith(9, OTHER),
      activeToken: null,
    });
    const client = new SessionClient({ ...host, makeRequest });

    await client.registerAndActivate(PINNED);

    expect(makeRequest).toHaveBeenCalledWith(
      'POST',
      '/session/device/switch',
      { accountId: PINNED },
      { cache: false },
    );
  });
});
