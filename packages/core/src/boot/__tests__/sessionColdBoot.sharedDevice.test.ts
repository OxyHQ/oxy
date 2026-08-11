/**
 * `shared-device-adopt` — the cold-boot lane that lets a freshly installed
 * official app join the device's EXISTING session with no QR and, crucially,
 * with no access to the Commons private identity key.
 *
 * What is pinned here:
 *   - a fresh install adopts the shared credential and mints;
 *   - an app that already has a credential is never moved (upgrade order cannot
 *     sign anyone out, in either direction);
 *   - an UNREADABLE shared slot is not a fresh device — the lane skips and the
 *     legacy identity-key lane still gets its turn;
 *   - a failed adoption leaves the local store byte-for-byte as it was;
 *   - `sessionMode: 'identity'` never runs the lane at all;
 *   - web never runs it.
 */
import type { OxyServices } from '../../OxyServices';
import type { DeviceTokenMintResponse } from '@oxyhq/contracts';
import type { SessionLoginResponse } from '../../models/session';
import { runSessionColdBoot } from '../sessionColdBoot';
import type { DeviceSecretMintOutcome } from '../../session/refresh';
import { createMemoryAuthStateStore, type PersistedAuthState } from '../../session/authStateStore';
import type {
  SharedDeviceCredentialRead,
  SharedDeviceCredentialStore,
} from '../../session/sharedDeviceCredential';
import { createMemoryIdentityPinStore } from '../../session/identityPin';
import type { IdentityBinding } from '../../session/identitySession';

const WEB = { isWeb: true, isNative: false };
const NATIVE = { isWeb: false, isNative: true };

const SHARED_CRED = { deviceId: 'dev-shared', deviceSecret: 'ds-shared' };
const OWN_CRED = { deviceId: 'dev-own', deviceSecret: 'ds-own' };

const MINT: DeviceTokenMintResponse = {
  accessToken: 'access-joined',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  nextDeviceSecret: SHARED_CRED.deviceSecret,
  state: {
    deviceId: SHARED_CRED.deviceId,
    accounts: [{ accountId: 'user-shared', sessionId: 'sess-shared', authuser: 0 }],
    activeAccountId: 'user-shared',
    revision: 9,
    updatedAt: 1_700_000_000_000,
  },
};

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

/** A 401 error shaped like `HttpService`/`handleError` output for the given body. */
function mint401(body: string): Error & { status: number } {
  return Object.assign(new Error(body), { status: 401 });
}

function makeOxy(overrides: {
  mintFromDeviceSecret?: OxyServices['mintFromDeviceSecret'];
  signInWithSharedIdentity?: OxyServices['signInWithSharedIdentity'];
} = {}) {
  const setTokens = jest.fn();
  const mintFromDeviceSecret = jest.fn(
    overrides.mintFromDeviceSecret ?? (async () => MINT),
  ) as unknown as OxyServices['mintFromDeviceSecret'];
  const signInWithSharedIdentity = jest.fn(
    overrides.signInWithSharedIdentity ?? (async () => null),
  ) as unknown as OxyServices['signInWithSharedIdentity'];
  const oxy = {
    getBaseURL: () => 'https://api.oxy.so',
    setTokens,
    mintFromDeviceSecret,
    signInWithSharedIdentity,
    httpService: { runSingleFlightDeviceSecretMint: makeMintSingleFlight() },
  } as unknown as OxyServices;
  return { oxy, setTokens, mintFromDeviceSecret, signInWithSharedIdentity };
}

function makeSharedSlot(initial: SharedDeviceCredentialRead) {
  let current = initial;
  const read = jest.fn(async () => current);
  const publish = jest.fn(async () => true);
  const clear = jest.fn(async () => {
    current = { state: 'absent' };
  });
  const store: SharedDeviceCredentialStore = { read, publish, clear };
  return { store, read, publish, clear };
}

/** An identity binding that resolves a local key, for the identity-mode case. */
function makeIdentityBinding(): IdentityBinding {
  return {
    pinStore: createMemoryIdentityPinStore(),
    getPublicKey: async () => 'pub-identity',
    signMessage: async () => 'sig-identity',
  };
}

describe('cold boot — shared-device-adopt', () => {
  test('a fresh install adopts the shared credential and mints a session', async () => {
    const store = createMemoryAuthStateStore();
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy, mintFromDeviceSecret, setTokens } = makeOxy();

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sharedDeviceCredential: slot.store,
    });

    expect(outcome).toMatchObject({ kind: 'session', via: 'shared-device-adopt' });
    expect(mintFromDeviceSecret).toHaveBeenCalledWith(SHARED_CRED.deviceId, SHARED_CRED.deviceSecret);
    expect(setTokens).toHaveBeenCalledWith(MINT.accessToken);
    // The adopted credential is now this app's own, so the next boot takes the
    // faster `device-secret-mint` lane.
    expect(await store.load()).toMatchObject({
      deviceId: SHARED_CRED.deviceId,
      deviceSecret: SHARED_CRED.deviceSecret,
      sessionId: 'sess-shared',
      userId: 'user-shared',
    });
  });

  test('the identity key is never touched when the shared credential works', async () => {
    // The whole point of the separation: an ordinary app joins the device session
    // without ever asking for the key that signs identity approvals.
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy, signInWithSharedIdentity } = makeOxy();

    await runSessionColdBoot({
      oxy,
      store: createMemoryAuthStateStore(),
      platform: NATIVE,
      sharedDeviceCredential: slot.store,
    });

    expect(signInWithSharedIdentity).not.toHaveBeenCalled();
  });

  test('an app that already holds its own credential is not moved onto the shared one', async () => {
    // Upgrade order must not sign anyone out. This app's own session wins.
    const store = createMemoryAuthStateStore();
    await store.save({ sessionId: 'sess-own', userId: 'user-own', ...OWN_CRED });
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy, mintFromDeviceSecret } = makeOxy({
      mintFromDeviceSecret: (async () => ({
        ...MINT,
        nextDeviceSecret: OWN_CRED.deviceSecret,
        state: { ...MINT.state, deviceId: OWN_CRED.deviceId },
      })) as unknown as OxyServices['mintFromDeviceSecret'],
    });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sharedDeviceCredential: slot.store,
    });

    expect(outcome).toMatchObject({ kind: 'session', via: 'device-secret-mint' });
    expect(mintFromDeviceSecret).toHaveBeenCalledWith(OWN_CRED.deviceId, OWN_CRED.deviceSecret);
    expect(mintFromDeviceSecret).not.toHaveBeenCalledWith(SHARED_CRED.deviceId, SHARED_CRED.deviceSecret);
    expect(await store.load()).toMatchObject({ deviceId: OWN_CRED.deviceId });
  });

  test('an UNREADABLE shared slot is not treated as a fresh device', async () => {
    // A locked keystore must never authorise anything. The lane skips, the store
    // is untouched, and the legacy identity lane still gets its turn — which is
    // what keeps a momentarily-locked device from silently onboarding again.
    const store = createMemoryAuthStateStore();
    const slot = makeSharedSlot({ state: 'unavailable', cause: new Error('keystore locked') });
    const sharedKeySession = {
      sessionId: 'sess-legacy',
      user: { id: 'user-legacy' },
      accessToken: 'access-legacy',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      deviceId: 'dev-legacy',
      deviceSecret: 'ds-legacy',
    } as unknown as SessionLoginResponse;
    const { oxy, signInWithSharedIdentity } = makeOxy({
      signInWithSharedIdentity: (async () => sharedKeySession) as unknown as OxyServices['signInWithSharedIdentity'],
    });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sharedDeviceCredential: slot.store,
    });

    expect(slot.publish).not.toHaveBeenCalled();
    expect(slot.clear).not.toHaveBeenCalled();
    expect(signInWithSharedIdentity).toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'session', via: 'shared-key-signin' });
  });

  test('an empty shared slot falls through to the legacy identity lane', async () => {
    const slot = makeSharedSlot({ state: 'absent' });
    const { oxy, signInWithSharedIdentity } = makeOxy();

    const outcome = await runSessionColdBoot({
      oxy,
      store: createMemoryAuthStateStore(),
      platform: NATIVE,
      sharedDeviceCredential: slot.store,
    });

    expect(signInWithSharedIdentity).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'unauthenticated' });
  });

  test('a rejected shared credential is reverted locally and cleared from the slot', async () => {
    // `invalid_device_secret` is the one positive proof that the exact shared
    // bytes are dead. Reverting keeps this app where it was; clearing the slot is
    // what stops a dead credential from blocking every future install.
    const store = createMemoryAuthStateStore();
    const before: PersistedAuthState = { sessionId: 'sess-stale', userId: 'user-stale' };
    await store.save(before);
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy } = makeOxy({
      mintFromDeviceSecret: (async () => {
        throw mint401('invalid_device_secret');
      }) as unknown as OxyServices['mintFromDeviceSecret'],
    });

    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: NATIVE,
      sharedDeviceCredential: slot.store,
    });

    expect(outcome).toEqual({ kind: 'unauthenticated' });
    expect(slot.clear).toHaveBeenCalledTimes(1);
    expect(await store.load()).toEqual(before);
  });

  test('a transient mint failure reverts without clearing the shared slot', async () => {
    // A network blip says nothing about the credential. Wiping the device-wide
    // join point on an ambiguous failure is the deploy-window bug, one layer up.
    const store = createMemoryAuthStateStore();
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy } = makeOxy({
      mintFromDeviceSecret: (async () => {
        throw new Error('network down');
      }) as unknown as OxyServices['mintFromDeviceSecret'],
    });

    await runSessionColdBoot({ oxy, store, platform: NATIVE, sharedDeviceCredential: slot.store });

    expect(slot.clear).not.toHaveBeenCalled();
    expect(await store.load()).toBeNull();
  });

  test('the lane does not run on web', async () => {
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy, mintFromDeviceSecret } = makeOxy();

    const outcome = await runSessionColdBoot({
      oxy,
      store: createMemoryAuthStateStore(),
      platform: WEB,
      sharedDeviceCredential: slot.store,
    });

    expect(slot.read).not.toHaveBeenCalled();
    expect(mintFromDeviceSecret).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'unauthenticated' });
  });

  test('the lane does not run when the device reports itself offline', async () => {
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy } = makeOxy();

    await runSessionColdBoot({
      oxy,
      store: createMemoryAuthStateStore(),
      platform: NATIVE,
      isOffline: () => true,
      sharedDeviceCredential: slot.store,
    });

    expect(slot.read).not.toHaveBeenCalled();
  });

  test('identity mode never reads the shared slot', async () => {
    // The slot belongs to whichever principal signed in on this device. An
    // identity-bound client resolves its session from the local key alone —
    // adopting a device credential is the drift that mode exists to prevent.
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy } = makeOxy();

    await runSessionColdBoot({
      oxy,
      store: createMemoryAuthStateStore(),
      platform: NATIVE,
      sessionMode: 'identity',
      identity: makeIdentityBinding(),
      sharedDeviceCredential: slot.store,
    });

    expect(slot.read).not.toHaveBeenCalled();
    expect(slot.publish).not.toHaveBeenCalled();
  });

  test('omitting the slot leaves the boot chain exactly as it was', async () => {
    const slot = makeSharedSlot({ state: 'present', credential: SHARED_CRED });
    const { oxy, signInWithSharedIdentity } = makeOxy();

    const outcome = await runSessionColdBoot({ oxy, store: createMemoryAuthStateStore(), platform: NATIVE });

    expect(slot.read).not.toHaveBeenCalled();
    expect(signInWithSharedIdentity).toHaveBeenCalled();
    expect(outcome).toEqual({ kind: 'unauthenticated' });
  });
});
