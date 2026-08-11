/**
 * The shared native DeviceSession credential — the decision rules that separate
 * "this device already has a session" from "this device could not be read".
 *
 * Every case here is written against the one failure this module exists to make
 * unreachable: a secure store that is LOCKED or BROKEN looking like a secure
 * store that is EMPTY. The empty answer authorises a write into the slot; the
 * failed answer must authorise nothing. Several assertions below are the only
 * thing standing between that misreading and a live shared session being
 * overwritten, so they are written to fail loudly rather than shrink quietly.
 */
import { createMemoryAuthStateStore, type AuthStateStore, type PersistedAuthState } from '../authStateStore';
import {
  createSharedMirroringAuthStateStore,
  decideSharedDeviceJoin,
  decideSharedDevicePublish,
  normalizeSharedDeviceSessionRead,
  publishProvenDeviceCredential,
  readLocalDeviceCredential,
  type SharedDeviceCredential,
  type SharedDeviceCredentialRead,
  type SharedDeviceCredentialStore,
} from '../sharedDeviceCredential';

const CRED: SharedDeviceCredential = { deviceId: 'dev-shared', deviceSecret: 'ds-shared' };
const OTHER: SharedDeviceCredential = { deviceId: 'dev-other', deviceSecret: 'ds-other' };

const PRESENT: SharedDeviceCredentialRead = { state: 'present', credential: CRED };
const ABSENT: SharedDeviceCredentialRead = { state: 'absent' };
const UNAVAILABLE: SharedDeviceCredentialRead = { state: 'unavailable', cause: new Error('keychain locked') };
const UNSUPPORTED: SharedDeviceCredentialRead = { state: 'unsupported' };

/** Every read state, so a new one cannot be added without deciding what it means. */
const ALL_READS: SharedDeviceCredentialRead[] = [PRESENT, ABSENT, UNAVAILABLE, UNSUPPORTED];

function localWith(credential: SharedDeviceCredential | null): PersistedAuthState {
  return {
    sessionId: 'sess-local',
    userId: 'user-local',
    ...(credential ? { deviceId: credential.deviceId, deviceSecret: credential.deviceSecret } : {}),
  };
}

/** An in-memory {@link SharedDeviceCredentialStore} with scripted read behaviour. */
function makeSharedStore(initial: SharedDeviceCredentialRead) {
  let current = initial;
  const publish = jest.fn(async (credential: SharedDeviceCredential) => {
    current = { state: 'present', credential };
    return true;
  });
  const clear = jest.fn(async () => {
    current = { state: 'absent' };
  });
  const store: SharedDeviceCredentialStore = {
    read: async () => current,
    publish,
    clear,
  };
  return { store, publish, clear, peek: () => current };
}

describe('readLocalDeviceCredential', () => {
  test('requires BOTH halves of the mint credential', () => {
    expect(readLocalDeviceCredential(null)).toBeNull();
    expect(readLocalDeviceCredential({ sessionId: 's', userId: 'u' })).toBeNull();
    expect(readLocalDeviceCredential({ sessionId: 's', userId: 'u', deviceId: 'd' })).toBeNull();
    expect(readLocalDeviceCredential({ sessionId: 's', userId: 'u', deviceSecret: 'x' })).toBeNull();
    expect(readLocalDeviceCredential(localWith(CRED))).toEqual(CRED);
  });
});

describe('normalizeSharedDeviceSessionRead', () => {
  test('narrows a well-formed present payload', () => {
    expect(
      normalizeSharedDeviceSessionRead({ status: 'present', deviceId: 'dev-x', deviceSecret: 'ds-x' }),
    ).toEqual({ state: 'present', credential: { deviceId: 'dev-x', deviceSecret: 'ds-x' } });
  });

  test('narrows an explicit absent payload', () => {
    expect(normalizeSharedDeviceSessionRead({ status: 'absent' })).toEqual({ state: 'absent' });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'absent'],
    ['a number', 0],
    ['an empty object', {}],
    ['an unknown status', { status: 'maybe' }],
    ['present with no deviceId', { status: 'present', deviceSecret: 'ds-x' }],
    ['present with no deviceSecret', { status: 'present', deviceId: 'dev-x' }],
    ['present with an empty deviceSecret', { status: 'present', deviceId: 'dev-x', deviceSecret: '' }],
    ['present with a non-string deviceId', { status: 'present', deviceId: 7, deviceSecret: 'ds-x' }],
    ['an explicit unavailable', { status: 'unavailable', reason: 'keystore' }],
  ])('reports %s as unavailable, never absent', (_label, raw) => {
    const read = normalizeSharedDeviceSessionRead(raw);
    // `unavailable` and `absent` are the pair that must never be confused: the
    // second one authorises a write into the slot.
    expect(read.state).toBe('unavailable');
  });
});

describe('decideSharedDeviceJoin', () => {
  test('adopts when the slot holds a credential and this app has none', () => {
    expect(decideSharedDeviceJoin(localWith(null), PRESENT)).toEqual({ action: 'adopt', credential: CRED });
    expect(decideSharedDeviceJoin(null, PRESENT)).toEqual({ action: 'adopt', credential: CRED });
  });

  test('NEVER adopts when the slot could not be read', () => {
    // The keystore-unavailable case. Adopting nothing is right; the danger is a
    // caller downstream reading this as "fresh device".
    expect(decideSharedDeviceJoin(localWith(null), UNAVAILABLE)).toEqual({
      action: 'skip',
      reason: 'shared-unreadable',
    });
  });

  test('reports an unsupported slot distinctly from an unreadable one', () => {
    // Same behaviour, different diagnosis: no shared transport in this build is
    // normal, an unreadable one is not.
    expect(decideSharedDeviceJoin(localWith(null), UNSUPPORTED)).toEqual({
      action: 'skip',
      reason: 'shared-unsupported',
    });
  });

  test('skips an empty slot', () => {
    expect(decideSharedDeviceJoin(localWith(null), ABSENT)).toEqual({ action: 'skip', reason: 'shared-empty' });
  });

  test('never moves an app that already holds its own credential — in ANY slot state', () => {
    // "No user is signed out merely because one app updates first" holds by
    // construction: whatever the slot says, an app with a working credential of
    // its own is left exactly where it is. Including when the slot holds a
    // DIFFERENT device session.
    for (const read of ALL_READS) {
      expect(decideSharedDeviceJoin(localWith(OTHER), read)).toEqual({
        action: 'skip',
        reason: 'local-credential-present',
      });
    }
    expect(ALL_READS).toHaveLength(4);
  });
});

describe('decideSharedDevicePublish', () => {
  test('seeds an empty slot with a proven credential', () => {
    expect(decideSharedDevicePublish(CRED, ABSENT)).toEqual({ action: 'publish' });
  });

  test('NEVER writes over a slot it could not read', () => {
    // The destructive direction. An unreadable slot may hold another principal's
    // live session; writing on the strength of a failed read is how it is lost.
    expect(decideSharedDevicePublish(CRED, UNAVAILABLE)).toEqual({
      action: 'skip',
      reason: 'shared-unreadable',
    });
  });

  test('does not write when there is no slot at all', () => {
    expect(decideSharedDevicePublish(CRED, UNSUPPORTED)).toEqual({
      action: 'skip',
      reason: 'shared-unsupported',
    });
  });

  test('refreshes the secret for the SAME device session', () => {
    const rotated = { deviceId: CRED.deviceId, deviceSecret: 'ds-rotated' };
    expect(decideSharedDevicePublish(rotated, PRESENT)).toEqual({ action: 'publish' });
  });

  test('is a no-op when the slot already holds exactly this credential', () => {
    expect(decideSharedDevicePublish(CRED, PRESENT)).toEqual({ action: 'skip', reason: 'already-current' });
  });

  test('leaves a slot owned by a DIFFERENT device session alone', () => {
    // Overwriting would silently migrate every other app on this device onto our
    // session at their next cold boot. That is a user-visible change of identity,
    // not something a background persist decides.
    expect(decideSharedDevicePublish(OTHER, PRESENT)).toEqual({
      action: 'skip',
      reason: 'owned-by-another-device',
    });
  });
});

describe('publishProvenDeviceCredential', () => {
  test('writes into an empty slot', async () => {
    const shared = makeSharedStore(ABSENT);
    await expect(publishProvenDeviceCredential({ shared: shared.store, credential: CRED })).resolves.toEqual({
      status: 'published',
    });
    expect(shared.publish).toHaveBeenCalledWith(CRED);
    expect(shared.peek()).toEqual(PRESENT);
  });

  test('does not call publish at all when the slot is unreadable', async () => {
    const shared = makeSharedStore(UNAVAILABLE);
    await expect(publishProvenDeviceCredential({ shared: shared.store, credential: CRED })).resolves.toEqual({
      status: 'skipped',
      reason: 'shared-unreadable',
    });
    expect(shared.publish).not.toHaveBeenCalled();
  });

  test('reports an unverified write as a failure rather than a success', async () => {
    const shared: SharedDeviceCredentialStore = {
      read: async () => ABSENT,
      // The contract is read-back-verified; a store that could not confirm the
      // bytes landed must say so, or a fresh install joins with a phantom.
      publish: async () => false,
      clear: async () => undefined,
    };
    await expect(publishProvenDeviceCredential({ shared, credential: CRED })).resolves.toEqual({
      status: 'publish-failed',
    });
  });
});

describe('createSharedMirroringAuthStateStore', () => {
  function harness(initial: SharedDeviceCredentialRead = ABSENT) {
    const local = createMemoryAuthStateStore();
    const shared = makeSharedStore(initial);
    return { local, shared, store: createSharedMirroringAuthStateStore({ local, shared: shared.store }) };
  }

  test('mirrors a saved credential into the shared slot', async () => {
    const h = harness();
    await expect(h.store.save(localWith(CRED))).resolves.toBe(true);
    expect(h.shared.publish).toHaveBeenCalledWith(CRED);
    expect(await h.local.load()).toEqual(localWith(CRED));
  });

  test('does not re-write the slot when the credential has not changed', async () => {
    const h = harness();
    await h.store.save(localWith(CRED));
    await h.store.save({ ...localWith(CRED), accessToken: 'warm', expiresAt: 'later' });
    await h.store.save({ ...localWith(CRED), accessToken: 'warmer', expiresAt: 'later-still' });
    expect(h.shared.publish).toHaveBeenCalledTimes(1);
  });

  test('mirrors again once the credential really changes', async () => {
    const h = harness();
    await h.store.save(localWith(CRED));
    await h.store.save(localWith({ deviceId: CRED.deviceId, deviceSecret: 'ds-rotated' }));
    expect(h.shared.publish).toHaveBeenCalledTimes(2);
  });

  test('saves nothing to the slot when the state carries no credential', async () => {
    const h = harness();
    await h.store.save({ sessionId: 's', userId: 'u' });
    expect(h.shared.publish).not.toHaveBeenCalled();
  });

  test('reports the LOCAL durability verdict, not the mirror outcome', async () => {
    // The caller's contract is about the durable local write — a lane persisting
    // a rotated secret treats `false` as fatal. A best-effort mirror must never
    // be able to flip that answer in either direction.
    const failingLocal: AuthStateStore = {
      load: async () => null,
      save: async () => false,
      clear: async () => undefined,
    };
    const shared = makeSharedStore(ABSENT);
    const store = createSharedMirroringAuthStateStore({ local: failingLocal, shared: shared.store });
    await expect(store.save(localWith(CRED))).resolves.toBe(false);
    expect(shared.publish).toHaveBeenCalledWith(CRED);
  });

  test('a throwing shared store cannot fail a successful local write', async () => {
    const shared: SharedDeviceCredentialStore = {
      read: async () => {
        throw new Error('binder died');
      },
      publish: async () => true,
      clear: async () => undefined,
    };
    const store = createSharedMirroringAuthStateStore({ local: createMemoryAuthStateStore(), shared });
    await expect(store.save(localWith(CRED))).resolves.toBe(true);
  });

  test('signing out of THIS app does not clear the device-wide slot', async () => {
    // Other apps may still be signed in on that credential, and once the server
    // session is gone the credential mints `no_active_session` for everyone
    // anyway. This app's sign-out is not authority over the join point.
    const h = harness();
    await h.store.save(localWith(CRED));
    await h.store.clear();
    expect(h.shared.clear).not.toHaveBeenCalled();
    expect(h.shared.peek()).toEqual(PRESENT);
    expect(await h.local.load()).toBeNull();
  });

  test('load is a pass-through and never adopts', async () => {
    // Adoption is an explicit cold-boot step. A storage primitive must not be
    // able to change who the app is signed in as.
    const h = harness(PRESENT);
    expect(await h.store.load()).toBeNull();
  });
});
