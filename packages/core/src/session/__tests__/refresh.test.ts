import type { OxyServices } from '../../OxyServices';
import type { DeviceTokenMintResponse } from '@oxy.so/contracts';
import type { SessionLoginResponse } from '../../models/session';
import {
  refreshPersistedSession,
  startTokenRefreshScheduler,
  type DeviceSecretMintOutcome,
} from '../refresh';
import {
  createMemoryAuthStateStore,
  type AuthStateStore,
  type PersistedAuthState,
} from '../authStateStore';

/**
 * A real, per-client device-secret mint single-flight matching
 * `HttpService.runSingleFlightDeviceSecretMint`: concurrent callers await the
 * SAME in-flight mint and all receive its result; a fresh call after it settles
 * starts a new one.
 */
function makeMintSingleFlight(): (mint: () => Promise<DeviceSecretMintOutcome>) => Promise<DeviceSecretMintOutcome> {
  let inFlight: Promise<DeviceSecretMintOutcome> | null = null;
  return (mint) => {
    if (!inFlight) {
      inFlight = mint().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

/** The persisted zero-cookie mint credential the refresh reads. */
const STORED: PersistedAuthState = {
  sessionId: 'sess-old',
  userId: 'user-1',
  deviceId: 'dev-mint',
  deviceSecret: 'ds-secret-orig',
};

/** A successful `POST /session/device/token` mint (rotates the secret + active account). */
const MINT: DeviceTokenMintResponse = {
  accessToken: 'access-new',
  expiresAt: '2030-01-01T00:00:00.000Z',
  nextDeviceSecret: 'ds-next-secret',
  state: {
    deviceId: 'dev-mint',
    accounts: [{ accountId: 'user-1', sessionId: 'sess-new', authuser: 0 }],
    activeAccountId: 'user-1',
    revision: 4,
    updatedAt: 1_700_000_000_000,
  },
};

interface RefreshMockOverrides {
  mintFromDeviceSecret?: OxyServices['mintFromDeviceSecret'];
  signInWithSharedIdentity?: OxyServices['signInWithSharedIdentity'];
}

function makeOxy(overrides: RefreshMockOverrides = {}): { oxy: OxyServices; setTokens: jest.Mock } {
  const setTokens = jest.fn();
  const oxy = {
    setTokens,
    mintFromDeviceSecret: overrides.mintFromDeviceSecret ?? (async () => MINT),
    signInWithSharedIdentity: overrides.signInWithSharedIdentity ?? (async () => null),
    // The rotating mint runs under the client's process-wide single-flight; the
    // arm reaches for it via `oxy.httpService.runSingleFlightDeviceSecretMint`.
    httpService: { runSingleFlightDeviceSecretMint: makeMintSingleFlight() },
  } as unknown as OxyServices;
  return { oxy, setTokens };
}

describe('refreshPersistedSession — arm 1 (device-secret mint)', () => {
  it('mints, plants, persists the rotated secret + active account, and returns the token', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const { oxy, setTokens } = makeOxy();

    const token = await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: false });

    expect(token).toBe('access-new');
    expect(setTokens).toHaveBeenCalledWith('access-new');
    expect(await store.load()).toEqual({
      sessionId: 'sess-new',
      userId: 'user-1',
      deviceId: 'dev-mint',
      deviceSecret: 'ds-next-secret',
      accessToken: 'access-new',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('presents the persisted deviceId + deviceSecret to the mint', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy } = makeOxy({ mintFromDeviceSecret });

    await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: false });

    expect(mintFromDeviceSecret).toHaveBeenCalledWith('dev-mint', 'ds-secret-orig');
  });

  it('drops only the secret (keeps deviceId) on a 401 and falls to shared-key when native', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const SHARED: SessionLoginResponse = {
      sessionId: 'sess-shared',
      deviceId: 'dev-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      user: { id: 'user-1', username: 'u', name: {}, avatar: undefined },
      accessToken: 'access-shared',
    };
    const signInWithSharedIdentity = jest.fn(async () => SHARED);
    const { oxy } = makeOxy({
      mintFromDeviceSecret: async () => {
        throw Object.assign(new Error('invalid_device_secret'), { status: 401 });
      },
      signInWithSharedIdentity,
    });

    const token = await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: true });

    expect(token).toBe('access-shared');
    expect(signInWithSharedIdentity).toHaveBeenCalledTimes(1);
    const persisted = await store.load();
    expect(persisted?.deviceSecret).toBeUndefined();
    expect(persisted?.deviceId).toBe('dev-mint');
  });

  it('clears the store on a 401 when there is no shared-key fallback (web)', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const { oxy } = makeOxy({
      mintFromDeviceSecret: async () => {
        throw Object.assign(new Error('no_active_session'), { status: 401 });
      },
    });

    const token = await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: false });

    expect(token).toBeNull();
    expect(await store.load()).toBeNull();
  });

  it('KEEPS the store and returns null on a transient (500 / network) error', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy } = makeOxy({
      mintFromDeviceSecret: async () => {
        throw Object.assign(new Error('server'), { status: 500 });
      },
      signInWithSharedIdentity,
    });

    // A transient failure must NOT drop the credential nor fall through to shared-key.
    expect(await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: true })).toBeNull();
    expect(await store.load()).toEqual(STORED);
    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
  });

  it('KEEPS the store on an UNRECOGNIZED 401 (proxy / middleware / deploy-window) — never wipes the credential on an ambiguous 401', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(STORED);
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy } = makeOxy({
      mintFromDeviceSecret: async () => {
        // A 401 whose body is NEITHER `invalid_device_secret` NOR `no_active_session`
        // — an auth-layer / proxy / starting-instance 401 common during a deploy
        // window. It is NOT proof the secret diverged, so the durable device
        // credential must survive (treated as transient) and a later attempt self-heals.
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
      signInWithSharedIdentity,
    });

    expect(await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: true })).toBeNull();
    expect(await store.load()).toEqual(STORED);
    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
  });
});

describe('refreshPersistedSession — arm 2 (native shared-key fallback)', () => {
  const SHARED_SESSION: SessionLoginResponse = {
    sessionId: 'sess-shared',
    deviceId: 'dev-1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    user: { id: 'user-1', username: 'u', name: {}, avatar: undefined },
    accessToken: 'access-shared',
  };

  it('re-mints via shared identity when there is no persisted secret', async () => {
    const store = createMemoryAuthStateStore(); // no stored device secret
    const signInWithSharedIdentity = jest.fn(async () => SHARED_SESSION);
    const { oxy } = makeOxy({ signInWithSharedIdentity });

    const token = await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: true });

    expect(token).toBe('access-shared');
    expect(signInWithSharedIdentity).toHaveBeenCalledTimes(1);
  });

  it('does NOT try shared-key when the fallback is disabled (web)', async () => {
    const store = createMemoryAuthStateStore();
    const signInWithSharedIdentity = jest.fn(async () => SHARED_SESSION);
    const { oxy } = makeOxy({ signInWithSharedIdentity });

    expect(await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: false })).toBeNull();
    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
  });

  it('returns null when the shared-key re-mint yields no session', async () => {
    const store = createMemoryAuthStateStore();
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy } = makeOxy({ signInWithSharedIdentity });

    expect(await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: true })).toBeNull();
    expect(signInWithSharedIdentity).toHaveBeenCalledTimes(1);
  });

  it('persists the recovered credential from the shared-key re-mint (repopulates the fast lane)', async () => {
    // Bug #3: an in-session shared-key recovery must repopulate the durable
    // device credential, not leave the fast device-secret lane empty.
    const store = createMemoryAuthStateStore(); // no persisted secret → arm 1 skips
    const RECOVERED: SessionLoginResponse = {
      sessionId: 'sess-shared',
      deviceId: 'dev-shared',
      deviceSecret: 'ds-shared-secret',
      expiresAt: '2030-01-01T00:00:00.000Z',
      user: { id: 'user-shared', username: 'u', name: {}, avatar: undefined },
      accessToken: 'access-shared',
    };
    const { oxy } = makeOxy({ signInWithSharedIdentity: jest.fn(async () => RECOVERED) });

    const token = await refreshPersistedSession({ oxy, store, allowSharedKeyFallback: true });

    expect(token).toBe('access-shared');
    expect(await store.load()).toEqual({
      sessionId: 'sess-shared',
      userId: 'user-shared',
      deviceId: 'dev-shared',
      deviceSecret: 'ds-shared-secret',
      accessToken: 'access-shared',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });
});

describe('refreshPersistedSession — single-flight (no double-rotation)', () => {
  it('coalesces two concurrent mints into ONE server rotation; the store holds the final current secret', async () => {
    // The server rotates the secret on every mint. Two concurrent lanes must
    // therefore share ONE in-flight mint (one rotation) or the store could
    // converge on a superseded secret.
    const store = createMemoryAuthStateStore();
    await store.save(STORED);

    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mintFromDeviceSecret = jest.fn(async (deviceId: string, deviceSecret: string) => {
      // Block until BOTH callers have entered so the single-flight is exercised.
      await gate;
      expect(deviceId).toBe('dev-mint');
      expect(deviceSecret).toBe('ds-secret-orig');
      return MINT;
    });
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });

    const first = refreshPersistedSession({ oxy, store, allowSharedKeyFallback: false });
    const second = refreshPersistedSession({ oxy, store, allowSharedKeyFallback: false });
    // Both callers entered while the mint is in flight.
    release?.();
    const [t1, t2] = await Promise.all([first, second]);

    // Exactly one server rotation despite two concurrent callers…
    expect(mintFromDeviceSecret).toHaveBeenCalledTimes(1);
    // …both callers received the same minted token…
    expect(t1).toBe('access-new');
    expect(t2).toBe('access-new');
    // …and the durable store converged on the rotated (current) secret.
    expect((await store.load())?.deviceSecret).toBe('ds-next-secret');
    // The token was planted exactly once (inside the single-flighted mint).
    expect(setTokens).toHaveBeenCalledTimes(1);
  });
});

describe('refreshPersistedSession — durable persist failure is fatal to the mint', () => {
  it('does NOT plant a token when the rotated secret cannot be durably persisted', async () => {
    // Bug #2: a mint that rotated the server secret but could not persist it must
    // not leave the process advertising a session on an unsaved, soon-dead secret.
    const failingStore: AuthStateStore = {
      load: async () => STORED,
      save: async () => false, // durable write did not land
      clear: async () => undefined,
    };
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });

    const token = await refreshPersistedSession({
      oxy,
      store: failingStore,
      allowSharedKeyFallback: false,
    });

    // The mint ran (the server rotated) but the token was NOT planted…
    expect(mintFromDeviceSecret).toHaveBeenCalledTimes(1);
    expect(setTokens).not.toHaveBeenCalled();
    // …and the lane reports failure rather than a healthy session.
    expect(token).toBeNull();
  });

  it('does NOT fall through to the shared-key arm on a persist failure', async () => {
    const failingStore: AuthStateStore = {
      load: async () => STORED,
      save: async () => false,
      clear: async () => undefined,
    };
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy } = makeOxy({
      mintFromDeviceSecret: async () => MINT,
      signInWithSharedIdentity,
    });

    await refreshPersistedSession({ oxy, store: failingStore, allowSharedKeyFallback: true });

    // A storage failure is not a bad-secret signal — the shared-key arm must not run.
    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
  });
});

describe('startTokenRefreshScheduler', () => {
  function makeSchedulerOxy(expiresInSeconds: number | null): {
    oxy: OxyServices;
    refreshAccessToken: jest.Mock;
  } {
    let cleared = false;
    const refreshAccessToken = jest.fn(async () => {
      cleared = true; // stop the reschedule loop after the first fire
      return null;
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const oxy = {
      getAccessToken: () => (cleared ? null : 'tok'),
      getAccessTokenExpiry: () => (expiresInSeconds === null ? null : nowSec + expiresInSeconds),
      onTokensChanged: () => () => undefined,
      httpService: { refreshAccessToken },
    } as unknown as OxyServices;
    return { oxy, refreshAccessToken };
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires a refresh ~60s before expiry', async () => {
    jest.useFakeTimers();
    const { oxy, refreshAccessToken } = makeSchedulerOxy(120);
    const handle = startTokenRefreshScheduler(oxy);

    expect(refreshAccessToken).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(refreshAccessToken).toHaveBeenCalledWith('preflight');

    handle.dispose();
  });

  it('no-ops cleanly for an opaque token with no exp', () => {
    jest.useFakeTimers();
    const { oxy, refreshAccessToken } = makeSchedulerOxy(null);
    const handle = startTokenRefreshScheduler(oxy);
    jest.advanceTimersByTime(10 * 60_000);
    expect(refreshAccessToken).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('backs off on repeated failure — bounded attempts, never a zero-delay busy loop', async () => {
    jest.useFakeTimers();
    // Already-expired token + a refresh that ALWAYS fails. The old code floored
    // the delay to 0 and re-armed in the finally block → a tight loop that would
    // exhaust jest's 100k-timer guard. The backoff schedule fires only a handful
    // of times per simulated minute.
    const refreshAccessToken = jest.fn(async () => null);
    const nowSec = Math.floor(Date.now() / 1000);
    const oxy = {
      getAccessToken: () => 'tok',
      getAccessTokenExpiry: () => nowSec - 10,
      onTokensChanged: () => () => undefined,
      httpService: { refreshAccessToken },
    } as unknown as OxyServices;

    const handle = startTokenRefreshScheduler(oxy);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(refreshAccessToken.mock.calls.length).toBeGreaterThan(0);
    expect(refreshAccessToken.mock.calls.length).toBeLessThan(10);
    handle.dispose();
  });

  it('resets the backoff after a successful refresh', async () => {
    jest.useFakeTimers();
    // Expiry is always ~1h from NOW, so a successful refresh genuinely pushes
    // the token out (as a real rotation would). Fail once, then succeed.
    const refreshAccessToken = jest
      .fn<Promise<string | null>, [unknown]>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('fresh');
    const oxy = {
      getAccessToken: () => 'tok',
      getAccessTokenExpiry: () => Math.floor(Date.now() / 1000) + 3600,
      onTokensChanged: () => () => undefined,
      httpService: { refreshAccessToken },
    } as unknown as OxyServices;

    const handle = startTokenRefreshScheduler(oxy);
    // First fire ~ (3600-60)s out (fails → 5s backoff), then the backoff fire
    // succeeds and re-arms ~1h out from the (now-fresh) expiry.
    await jest.advanceTimersByTimeAsync((3600 - 60) * 1000);
    await jest.advanceTimersByTimeAsync(5_000);
    const callsAfterSuccess = refreshAccessToken.mock.calls.length;
    expect(callsAfterSuccess).toBe(2); // one failure + one success
    // A further minute must NOT produce a burst — the healthy re-arm is ~1h out.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(refreshAccessToken.mock.calls.length).toBe(callsAfterSuccess);
    handle.dispose();
  });

  it('calls unref() on its timer so it never holds the event loop', () => {
    const unref = jest.fn();
    const setTimeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setTimeout>);
    const { oxy } = makeSchedulerOxy(120);

    const handle = startTokenRefreshScheduler(oxy);
    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(unref).toHaveBeenCalled();

    handle.dispose();
    setTimeoutSpy.mockRestore();
  });
});
