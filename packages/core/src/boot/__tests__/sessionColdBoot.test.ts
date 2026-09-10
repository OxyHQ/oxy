/**
 * Cold boot v3 (`runSessionColdBoot`) — the zero-cookie, DOM-less device-first
 * boot. Only two ordered steps remain:
 *   1. `device-secret-mint` (web + native) — mint an access token from the
 *      persisted `deviceId` + `deviceSecret`.
 *   2. `shared-key-signin` (native) — re-mint from the shared-keychain identity.
 * Anything unresolved ends signed out (never a redirect).
 */
import type { OxyServices } from '../../OxyServices';
import type { DeviceTokenMintResponse } from '@oxy.so/contracts';
import type { SessionLoginResponse } from '../../models/session';
import { runSessionColdBoot } from '../sessionColdBoot';
import type { DeviceSecretMintOutcome } from '../../session/refresh';
import { createMemoryAuthStateStore, type PersistedAuthState } from '../../session/authStateStore';

interface OxyOverrides {
  signInWithSharedIdentity?: OxyServices['signInWithSharedIdentity'];
  mintFromDeviceSecret?: OxyServices['mintFromDeviceSecret'];
}

/** A real device-secret mint single-flight matching HttpService's. */
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

function makeOxy(overrides: OxyOverrides = {}): { oxy: OxyServices; setTokens: jest.Mock } {
  const setTokens = jest.fn();
  const oxy = {
    getBaseURL: () => 'https://api.oxy.so',
    setTokens,
    signInWithSharedIdentity: overrides.signInWithSharedIdentity ?? (async () => null),
    // Default: no persisted secret in these fixtures, so the mint step skips
    // before ever calling this. Tests that exercise the mint pass an override.
    mintFromDeviceSecret:
      overrides.mintFromDeviceSecret
      ?? (async () => {
        throw new Error('mintFromDeviceSecret not stubbed');
      }),
    // The device-secret-mint step runs through the client's single-flight.
    httpService: { runSingleFlightDeviceSecretMint: makeMintSingleFlight() },
  } as unknown as OxyServices;
  return { oxy, setTokens };
}

const MINT: DeviceTokenMintResponse = {
  accessToken: 'access-minted',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  nextDeviceSecret: 'ds-next-secret',
  state: {
    deviceId: 'dev-mint',
    accounts: [{ accountId: 'user-mint', sessionId: 'sess-mint', authuser: 0 }],
    activeAccountId: 'user-mint',
    revision: 2,
    updatedAt: 1_700_000_000_000,
  },
};

/** A 401 error shaped like `HttpService`/`handleError` output for the given body. */
function mint401(body: string): Error & { status: number } {
  return Object.assign(new Error(body), { status: 401 });
}

const WEB = { isWeb: true, isNative: false };
const NATIVE = { isWeb: false, isNative: true };

/** Seed a store with the zero-cookie mint credential. */
function seedCredStore(extra: Partial<PersistedAuthState> = {}) {
  const store = createMemoryAuthStateStore();
  return {
    store,
    seed: async () => {
      await store.save({
        sessionId: 'sess-old',
        userId: 'user-old',
        deviceId: 'dev-mint',
        deviceSecret: 'ds-secret-orig',
        ...extra,
      });
    },
  };
}

describe('runSessionColdBoot — warm-token-plant', () => {
  /** Comfortably beyond the 60s refresh lead window. */
  const farFuture = () => new Date(Date.now() + 3_600_000).toISOString();

  it('plants a still-valid warm token FIRST, skipping the mint round-trip', async () => {
    const { store, seed } = seedCredStore({ accessToken: 'warm-access', expiresAt: farFuture() });
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });
    const saveSpy = jest.spyOn(store, 'save');
    const onSession = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSession });

    expect(outcome).toEqual({ kind: 'session', via: 'warm-token-plant', session: expect.any(Object) });
    expect(setTokens).toHaveBeenCalledWith('warm-access');
    // The warm plant won before the mint lane — no network round-trip on first paint.
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    // Session identity comes straight from the persisted owning session.
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-old',
        userId: 'user-old',
        accessToken: 'warm-access',
        via: 'warm-token-plant',
      }),
    );
    // Used AS-IS: the step never mints, rotates, or persists.
    expect(saveSpy).not.toHaveBeenCalled();
    expect(await store.load()).toMatchObject({ deviceSecret: 'ds-secret-orig', accessToken: 'warm-access' });
  });

  it('plants on native too (the step runs on both platforms)', async () => {
    const { store, seed } = seedCredStore({ accessToken: 'warm-access', expiresAt: farFuture() });
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret, signInWithSharedIdentity });

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE });

    expect(outcome).toMatchObject({ kind: 'session', via: 'warm-token-plant' });
    expect(setTokens).toHaveBeenCalledWith('warm-access');
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ['within the refresh lead window', () => new Date(Date.now() + 30_000).toISOString()],
    ['already expired', () => new Date(Date.now() - 1_000).toISOString()],
    ['malformed (Date.parse NaN)', () => 'not-a-real-date'],
  ])('skips to the mint lane when the warm token is %s', async (_label, expiresAt) => {
    const { store, seed } = seedCredStore({ accessToken: 'warm-access', expiresAt: expiresAt() });
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB });

    // Warm plant skipped → the unchanged mint lane resolved the session.
    expect(outcome).toMatchObject({ kind: 'session', via: 'device-secret-mint' });
    expect(mintFromDeviceSecret).toHaveBeenCalledWith('dev-mint', 'ds-secret-orig');
    expect(setTokens).toHaveBeenCalledWith('access-minted');
    // The stale warm token was NOT planted.
    expect(setTokens).not.toHaveBeenCalledWith('warm-access');
  });

  it('skips (regression guard) when no accessToken is persisted → mint lane runs', async () => {
    const { store, seed } = seedCredStore(); // deviceId/deviceSecret only, no warm token
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB });

    expect(outcome).toMatchObject({ kind: 'session', via: 'device-secret-mint' });
    expect(mintFromDeviceSecret).toHaveBeenCalledWith('dev-mint', 'ds-secret-orig');
    expect(setTokens).toHaveBeenCalledWith('access-minted');
  });

  it('skips when a warm token is present but the owning sessionId/userId is missing', async () => {
    // Device-only bootstrap blob: deviceId + deviceSecret but empty session identity.
    const store = createMemoryAuthStateStore();
    await store.save({
      sessionId: '',
      userId: '',
      deviceId: 'dev-mint',
      deviceSecret: 'ds-secret-orig',
      accessToken: 'warm-access',
      expiresAt: farFuture(),
    });
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB });

    // No owning session → warm plant skips → the mint lane resolves it.
    expect(outcome).toMatchObject({ kind: 'session', via: 'device-secret-mint' });
    expect(setTokens).not.toHaveBeenCalledWith('warm-access');
    expect(mintFromDeviceSecret).toHaveBeenCalled();
  });
});

describe('runSessionColdBoot — device-secret-mint', () => {
  it('wins FIRST via the mint, persisting nextDeviceSecret BEFORE planting the token', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });
    const saveSpy = jest.spyOn(store, 'save');
    const onSession = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSession });

    expect(outcome).toEqual({ kind: 'session', via: 'device-secret-mint', session: expect.any(Object) });
    expect(mintFromDeviceSecret).toHaveBeenCalledWith('dev-mint', 'ds-secret-orig');
    expect(setTokens).toHaveBeenCalledWith('access-minted');
    // Session identity comes from the mint's authoritative active account.
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-mint', userId: 'user-mint', via: 'device-secret-mint' }),
    );
    // Rotation-in-use anti-loss: the store held the NEXT secret before the plant.
    const lastSaveOrder = Math.max(...saveSpy.mock.invocationCallOrder);
    const firstPlantOrder = Math.min(...setTokens.mock.invocationCallOrder);
    expect(lastSaveOrder).toBeLessThan(firstPlantOrder);
    expect(await store.load()).toMatchObject({
      deviceId: 'dev-mint',
      deviceSecret: 'ds-next-secret',
      sessionId: 'sess-mint',
      userId: 'user-mint',
      accessToken: 'access-minted',
    });
  });

  it('mints on native too (the step runs on both platforms)', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret, signInWithSharedIdentity });

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE });

    expect(outcome).toMatchObject({ kind: 'session', via: 'device-secret-mint' });
    expect(setTokens).toHaveBeenCalledWith('access-minted');
    // The mint won first — the shared-key fallback was never reached.
    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
  });

  it('skips (no mint) when only one of deviceId / deviceSecret is persisted', async () => {
    const store = createMemoryAuthStateStore();
    await store.save({ sessionId: 's', userId: 'u', deviceSecret: 'ds-only' });
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy } = makeOxy({ mintFromDeviceSecret });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSignedOut });

    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    // Nothing else can resolve on web → signed out.
    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
  });

  it('401 invalid_device_secret → drops the secret (keeps deviceId) and ends signed out on web', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => {
      throw mint401('invalid_device_secret');
    });
    const { oxy } = makeOxy({ mintFromDeviceSecret });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSignedOut });

    expect(mintFromDeviceSecret).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
    const persisted = await store.load();
    expect(persisted?.deviceSecret).toBeUndefined();
    expect(persisted?.deviceId).toBe('dev-mint');
  });

  it('401 no_active_session → keeps the secret and reports signed out', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => {
      throw mint401('no_active_session');
    });
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy } = makeOxy({ mintFromDeviceSecret, signInWithSharedIdentity });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSignedOut });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
    // The known-signed-out device retains its secret (it may sign in again).
    expect((await store.load())?.deviceSecret).toBe('ds-secret-orig');
    // Web has no shared-key lane.
    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
  });

  it('classifies a PLAIN-OBJECT 401 (no Error prototype) — no_active_session still keeps the secret', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    // Cross-realm / ApiError-shaped throw: not `instanceof Error`. Must still be
    // read as no_active_session — misreading it as a stale secret would drop it.
    const mintFromDeviceSecret = jest.fn(async () => {
      throw { status: 401, message: 'no_active_session' };
    });
    const { oxy } = makeOxy({ mintFromDeviceSecret });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSignedOut });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
    expect((await store.load())?.deviceSecret).toBe('ds-secret-orig');
  });

  it('transient (non-401) mint error → keeps the secret and reports signed out on web', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => {
      throw new Error('network down');
    });
    const { oxy } = makeOxy({ mintFromDeviceSecret });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSignedOut });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
    // The secret survives a transient failure so a later attempt can succeed.
    expect((await store.load())?.deviceSecret).toBe('ds-secret-orig');
  });

  it('a dropped secret (401) on native falls through to the shared-key lane', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    const sharedSession: SessionLoginResponse = {
      sessionId: 'sess-shared',
      deviceId: 'dev-1',
      expiresAt: '2030-01-01T00:00:00.000Z',
      user: { id: 'user-shared', username: 'u', name: {}, avatar: undefined },
      accessToken: 'access-shared',
    };
    const mintFromDeviceSecret = jest.fn(async () => {
      throw mint401('invalid_device_secret');
    });
    const signInWithSharedIdentity = jest.fn(async () => sharedSession);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret, signInWithSharedIdentity });

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE });

    expect(outcome).toEqual({ kind: 'session', via: 'shared-key-signin', session: expect.any(Object) });
    expect(signInWithSharedIdentity).toHaveBeenCalledTimes(1);
    // The mint lane still dropped the stale secret before falling through.
    expect((await store.load())?.deviceSecret).toBeUndefined();
    // Shared-key plants tokens itself (via verifyChallenge); the cold boot does not.
    expect(setTokens).not.toHaveBeenCalled();
  });
});

describe('runSessionColdBoot — shared-key-signin (native)', () => {
  const sharedSession: SessionLoginResponse = {
    sessionId: 'sess-shared',
    deviceId: 'dev-1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    user: { id: 'user-shared', username: 'u', name: {}, avatar: undefined },
    accessToken: 'access-shared',
  };

  it('re-mints via the shared identity when there is no persisted mint credential', async () => {
    const store = createMemoryAuthStateStore(); // no deviceId/deviceSecret
    const signInWithSharedIdentity = jest.fn(async () => sharedSession);
    const { oxy } = makeOxy({ signInWithSharedIdentity });
    const onSession = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE, onSession });

    expect(outcome).toEqual({ kind: 'session', via: 'shared-key-signin', session: expect.any(Object) });
    expect(signInWithSharedIdentity).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-shared', userId: 'user-shared', via: 'shared-key-signin' }),
    );
  });

  it('persists deviceSecret from shared-key verifyChallenge for the next mint lane', async () => {
    const store = createMemoryAuthStateStore();
    const signInWithSharedIdentity = jest.fn(async () => ({
      ...sharedSession,
      deviceSecret: 'shared-mint-secret',
    }));
    const { oxy } = makeOxy({ signInWithSharedIdentity });

    await runSessionColdBoot({ oxy, store, platform: NATIVE });

    const persisted = await store.load();
    expect(persisted).toMatchObject({
      sessionId: 'sess-shared',
      userId: 'user-shared',
      deviceId: 'dev-1',
      deviceSecret: 'shared-mint-secret',
      accessToken: 'access-shared',
    });
  });

  it('does NOT run the shared-key lane on web', async () => {
    const store = createMemoryAuthStateStore();
    const signInWithSharedIdentity = jest.fn(async () => sharedSession);
    const { oxy } = makeOxy({ signInWithSharedIdentity });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSignedOut });

    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
  });

  it('reports signed out when the shared identity yields no session', async () => {
    const store = createMemoryAuthStateStore();
    const signInWithSharedIdentity = jest.fn(async () => null);
    const { oxy } = makeOxy({ signInWithSharedIdentity });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE, onSignedOut });

    expect(signInWithSharedIdentity).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
  });

  it('reports a step error (onStepError + signed-out reason `error`) when the shared identity throws', async () => {
    const store = createMemoryAuthStateStore();
    const signInWithSharedIdentity = jest.fn(async () => {
      throw new Error('keychain locked');
    });
    const { oxy } = makeOxy({ signInWithSharedIdentity });
    const onSignedOut = jest.fn();
    const onStepError = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE, onSignedOut, onStepError });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onStepError).toHaveBeenCalledWith('shared-key-signin', expect.any(Error));
    expect(onSignedOut).toHaveBeenCalledWith('error');
  });
});

describe('runSessionColdBoot — signed out', () => {
  it('reports signed out when the store is empty and no lane resolves (web)', async () => {
    const store = createMemoryAuthStateStore();
    const { oxy, setTokens } = makeOxy();
    const onSession = jest.fn();
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({ oxy, store, platform: WEB, onSession, onSignedOut });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
    expect(onSession).not.toHaveBeenCalled();
    expect(setTokens).not.toHaveBeenCalled();
  });
});

describe('runSessionColdBoot — offline gating (isOffline)', () => {
  /** Comfortably beyond the 60s refresh lead window. */
  const farFuture = () => new Date(Date.now() + 3_600_000).toISOString();

  const sharedSession: SessionLoginResponse = {
    sessionId: 'sess-shared',
    deviceId: 'dev-1',
    expiresAt: '2030-01-01T00:00:00.000Z',
    user: { id: 'user-shared', username: 'u', name: {}, avatar: undefined },
    accessToken: 'access-shared',
  };

  it('offline: skips BOTH network steps (no mint, no shared-key) → signed out', async () => {
    // Credential present, no warm token — the ONLY things that could resolve are
    // the two network steps, which the offline hint must gate off.
    const { store, seed } = seedCredStore();
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const signInWithSharedIdentity = jest.fn(async () => sharedSession);
    const { oxy } = makeOxy({ mintFromDeviceSecret, signInWithSharedIdentity });
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      isOffline: () => true,
      onSignedOut,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
  });

  it('offline: the pure-local warm-token-plant STILL runs (returning user boots authenticated offline)', async () => {
    const { store, seed } = seedCredStore({ accessToken: 'warm-access', expiresAt: farFuture() });
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy, setTokens } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      isOffline: () => true,
    });

    // Warm plant is a pure-local read — never gated by the offline hint.
    expect(outcome).toMatchObject({ kind: 'session', via: 'warm-token-plant' });
    expect(setTokens).toHaveBeenCalledWith('warm-access');
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
  });

  it('online (isOffline:()=>false): the network mint runs as normal', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    const mintFromDeviceSecret = jest.fn(async () => MINT);
    const { oxy } = makeOxy({ mintFromDeviceSecret });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: WEB,
      isOffline: () => false,
    });

    expect(outcome).toMatchObject({ kind: 'session', via: 'device-secret-mint' });
    expect(mintFromDeviceSecret).toHaveBeenCalledWith('dev-mint', 'ds-secret-orig');
  });

  it('shared-key-signin passes { requestOptions: { retry: false } } (cold-boot single-attempt)', async () => {
    const store = createMemoryAuthStateStore(); // no mint credential → mint step no-secret skip
    const signInWithSharedIdentity = jest.fn(async () => sharedSession);
    const { oxy } = makeOxy({ signInWithSharedIdentity });

    const outcome = await runSessionColdBoot({ oxy, store, platform: NATIVE });

    expect(outcome).toMatchObject({ kind: 'session', via: 'shared-key-signin' });
    expect(signInWithSharedIdentity).toHaveBeenCalledWith({ requestOptions: { retry: false } });
  });
});

describe('runSessionColdBoot — overall deadline (overallDeadlineMs + onStepDeadline)', () => {
  it('forwards the deadline: a non-settling mint step is abandoned via onStepDeadline and the boot ends bounded', async () => {
    const { store, seed } = seedCredStore();
    await seed();
    // A mint that NEVER settles — without the overall deadline this hangs the
    // whole boot (and therefore app routing) forever.
    const mintFromDeviceSecret = jest.fn(
      () => new Promise<DeviceTokenMintResponse>(() => undefined),
    );
    const { oxy } = makeOxy({ mintFromDeviceSecret });
    const onStepDeadline = jest.fn();
    const onSignedOut = jest.fn();

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: WEB,
      overallDeadlineMs: 50,
      onStepDeadline,
      onSignedOut,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(onStepDeadline).toHaveBeenCalledWith('device-secret-mint');
    // A deadline trip is not an error — the boot resolves signed-out, not `error`.
    expect(onSignedOut).toHaveBeenCalledWith('no_session');
  });
});
