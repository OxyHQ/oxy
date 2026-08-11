/**
 * `createPlatformAuthStateStore` — the ORDER of its branches.
 *
 * Two features land on this one function. Phase 4 wraps the native store so
 * every credential it persists is mirrored into the device-wide shared slot that
 * every sibling app adopts on cold boot. Phase 5 lets an origin decline to
 * persist a credential at all, because the browser hub's handle is the durable
 * one and two durable credentials for one origin is the dual authority ADR 0003
 * removes.
 *
 * Put the ephemeral check AFTER the platform branch and those two combine into
 * the worst of both: an origin that keeps nothing itself would still publish
 * into the shared slot, deciding which session five other apps boot into. The
 * ordering is what prevents it, so the ordering is what these cases pin.
 *
 * It is unreachable today — the only ephemeral caller is a web origin, where
 * `isReactNative()` is false anyway — which is exactly why it is worth a test.
 * "Unreachable, therefore harmless" stops being true the moment somebody adds
 * the second caller, and nothing else in the suite would notice.
 */

const mockIsReactNative = jest.fn();
const mockCreateNativeSecureKeyValueStorage = jest.fn();
const mockCreatePlatformSharedDeviceCredentialStore = jest.fn();

jest.mock('../../src/ui/utils/storageHelpers', () => ({
  isReactNative: () => mockIsReactNative(),
}));
jest.mock('../../src/ui/session/nativeSecureStorage', () => ({
  createNativeSecureKeyValueStorage: () => mockCreateNativeSecureKeyValueStorage(),
}));
jest.mock('../../src/ui/session/sharedDeviceCredentialStore', () => ({
  createPlatformSharedDeviceCredentialStore: () =>
    mockCreatePlatformSharedDeviceCredentialStore(),
}));

import { createPlatformAuthStateStore } from '../../src/ui/session/authStore';

/** A minimal `NativeKeyValueStorage`, enough for the native store to construct. */
function keyValueStorage() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  };
}

const CREDENTIAL = {
  sessionId: 'sess-1',
  userId: 'user-1',
  deviceId: 'dev-1',
  deviceSecret: 'a-proven-device-secret',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateNativeSecureKeyValueStorage.mockImplementation(() => keyValueStorage());
  mockCreatePlatformSharedDeviceCredentialStore.mockImplementation(() => ({
    read: jest.fn(async () => ({ status: 'empty' as const })),
    write: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  }));
});

describe('ephemeral short-circuits above the platform branch', () => {
  it('never reaches the native seams, even when isReactNative() is true', async () => {
    // The case that cannot happen today and must stay impossible tomorrow.
    mockIsReactNative.mockReturnValue(true);

    const store = createPlatformAuthStateStore({ storage: 'ephemeral' });
    await store.save(CREDENTIAL);

    // If the ephemeral check moved below `isReactNative()`, BOTH of these would
    // have been constructed and the save would have been mirrored into the slot
    // every sibling app reads.
    expect(mockCreateNativeSecureKeyValueStorage).not.toHaveBeenCalled();
    expect(mockCreatePlatformSharedDeviceCredentialStore).not.toHaveBeenCalled();
  });

  it('publishes nothing to the shared device slot', async () => {
    mockIsReactNative.mockReturnValue(true);
    const shared = {
      read: jest.fn(async () => ({ status: 'empty' as const })),
      write: jest.fn(async () => undefined),
      clear: jest.fn(async () => undefined),
    };
    mockCreatePlatformSharedDeviceCredentialStore.mockReturnValue(shared);

    const store = createPlatformAuthStateStore({ storage: 'ephemeral' });
    await store.save(CREDENTIAL);
    await store.save({ ...CREDENTIAL, deviceSecret: 'a-second-secret' });

    expect(shared.write).not.toHaveBeenCalled();
  });

  it('keeps nothing durable — a fresh store built the same way starts empty', async () => {
    mockIsReactNative.mockReturnValue(false);

    const first = createPlatformAuthStateStore({ storage: 'ephemeral' });
    await first.save(CREDENTIAL);
    expect(await first.load()).toMatchObject({ deviceId: 'dev-1' });

    // A reload is a new store. Nothing survives it, which is the whole point:
    // the durable credential for this browser profile lives server-side behind
    // the hub handle.
    const second = createPlatformAuthStateStore({ storage: 'ephemeral' });
    expect(await second.load()).toBeNull();
  });

  it('is ephemeral on web too, not merely "not the native one"', async () => {
    mockIsReactNative.mockReturnValue(false);
    const store = createPlatformAuthStateStore({ storage: 'ephemeral' });
    await store.save(CREDENTIAL);

    // `createWebAuthStateStore` would have written localStorage; the memory
    // store cannot, so nothing under the SDK's key exists.
    const persisted = Object.keys(globalThis.localStorage ?? {}).filter((key) =>
      key.startsWith('oxy.auth'),
    );
    expect(persisted).toEqual([]);
  });
});

describe('the default and the explicit persistent value are unchanged', () => {
  it('web with no options builds the web store', async () => {
    mockIsReactNative.mockReturnValue(false);
    createPlatformAuthStateStore();
    expect(mockCreateNativeSecureKeyValueStorage).not.toHaveBeenCalled();
    expect(mockCreatePlatformSharedDeviceCredentialStore).not.toHaveBeenCalled();
  });

  it('native with no options still mirrors into the shared slot', () => {
    mockIsReactNative.mockReturnValue(true);
    createPlatformAuthStateStore();
    // The positive control for the cases above: this is the path the ephemeral
    // ones must not take, so it has to be reachable at all.
    expect(mockCreateNativeSecureKeyValueStorage).toHaveBeenCalled();
    expect(mockCreatePlatformSharedDeviceCredentialStore).toHaveBeenCalled();
  });

  it("native in identity mode keeps its own store and mirrors nothing", () => {
    mockIsReactNative.mockReturnValue(true);
    createPlatformAuthStateStore({ sessionMode: 'identity' });
    expect(mockCreateNativeSecureKeyValueStorage).toHaveBeenCalled();
    expect(mockCreatePlatformSharedDeviceCredentialStore).not.toHaveBeenCalled();
  });

  it("'persistent' is the same as omitting it", () => {
    mockIsReactNative.mockReturnValue(true);
    createPlatformAuthStateStore({ storage: 'persistent' });
    expect(mockCreateNativeSecureKeyValueStorage).toHaveBeenCalled();
    expect(mockCreatePlatformSharedDeviceCredentialStore).toHaveBeenCalled();
  });
});
