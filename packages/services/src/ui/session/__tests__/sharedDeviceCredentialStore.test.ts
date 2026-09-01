/**
 * The platform half of the shared DeviceSession credential.
 *
 * `@oxyhq/core` owns and tests the RULES; what is pinned here is the mapping from
 * each platform's failure shapes onto them — and that mapping is where the
 * dangerous mistake lives. `expo-secure-store` returns `null` for a missing item
 * and THROWS when the keychain refuses; the Android broker answers with an
 * explicit status. Collapsing either failure into "absent" is what would let a
 * locked device look like one that never had a session.
 */
import type { SharedDeviceCredentialStore } from '@oxyhq/core';

const CRED = { deviceId: 'dev-shared', deviceSecret: 'ds-shared' };
const STORAGE_KEY = 'oxy_shared_device_session_v1';

/** A minimal in-memory `expo-secure-store` that records the options it was given. */
function makeSecureStoreMock() {
  const items = new Map<string, string>();
  const calls: { key: string; options?: Record<string, unknown> }[] = [];
  let readError: Error | null = null;
  let writeError: Error | null = null;
  /** When set, `setItemAsync` resolves but nothing lands — the phantom-write case. */
  let swallowWrites = false;
  return {
    items,
    calls,
    setReadError: (error: Error | null) => {
      readError = error;
    },
    setWriteError: (error: Error | null) => {
      writeError = error;
    },
    setSwallowWrites: (value: boolean) => {
      swallowWrites = value;
    },
    module: {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 3,
      getItemAsync: async (key: string, options?: Record<string, unknown>) => {
        calls.push({ key, options });
        if (readError) {
          throw readError;
        }
        return items.get(key) ?? null;
      },
      setItemAsync: async (key: string, value: string, options?: Record<string, unknown>) => {
        calls.push({ key, options });
        if (writeError) {
          throw writeError;
        }
        if (!swallowWrites) {
          items.set(key, value);
        }
      },
      deleteItemAsync: async (key: string, options?: Record<string, unknown>) => {
        calls.push({ key, options });
        items.delete(key);
      },
    },
  };
}

type BrokerModule = {
  read(): Promise<unknown>;
  write(deviceId: string, deviceSecret: string): Promise<boolean>;
  clear(): Promise<void>;
};

/**
 * Load the module fresh, with `Platform.OS` set and both native seams mocked.
 *
 * Two things here are load-bearing and were each got wrong first:
 *
 *  - `jest.resetModules()` + `require`, NOT `jest.isolateModules`. The module
 *    memoises its keychain and broker handles at module scope, so it must be
 *    re-required per case — and with `isolateModules` a mock factory registered
 *    in one block leaked into the next block's module, so a test's own mock was
 *    silently ignored and its assertions read the PREVIOUS test's store.
 *  - `Platform.OS` is set on the instance in the CURRENT registry. A reset hands
 *    out a fresh `react-native` mock whose `OS` is back to its `'web'` default,
 *    so mutating an instance captured earlier leaves the code under test on the
 *    web branch and every platform assertion passes vacuously.
 */
function loadStore(
  os: 'ios' | 'android' | 'web',
  seams: { secureStore?: ReturnType<typeof makeSecureStoreMock>; broker?: BrokerModule | null } = {},
): SharedDeviceCredentialStore | null {
  jest.resetModules();
  jest.doMock('expo-modules-core', () => ({
    requireOptionalNativeModule: () => seams.broker ?? null,
    requireNativeModule: () => {
      throw new Error('not available');
    },
  }));
  // NOT `{ virtual: true }`: a virtual mock is keyed to the directory of the
  // file that declared it, so one declared here would be invisible to the module
  // under test two directories up — it would silently keep resolving
  // `unsupported`. `expo-secure-store` is installed in the workspace, so the
  // ordinary mock registers against its real resolved path. With no mock given,
  // model the module being ABSENT.
  const secureStoreModule = seams.secureStore?.module;
  jest.doMock('expo-secure-store', () => {
    if (!secureStoreModule) {
      throw new Error("Cannot find module 'expo-secure-store'");
    }
    return secureStoreModule;
  });
  const rn = require('react-native') as { Platform: { OS: string } };
  rn.Platform.OS = os;
  const mod = require('../sharedDeviceCredentialStore') as typeof import('../sharedDeviceCredentialStore');
  return mod.createPlatformSharedDeviceCredentialStore();
}

afterEach(() => {
  jest.dontMock('expo-modules-core');
  jest.dontMock('expo-secure-store');
  jest.resetModules();
});

describe('createPlatformSharedDeviceCredentialStore', () => {
  test('web has no shared slot at all', () => {
    // Each web origin is its own device by design; there is nothing to join.
    expect(loadStore('web')).toBeNull();
    // Positive control: `null` must mean "web", not "the harness never reached
    // the platform branch" — the failure mode this whole harness had once.
    expect(loadStore('android', { broker: null })).not.toBeNull();
    expect(loadStore('ios')).not.toBeNull();
  });

  test('iOS uses the keychain, not the Android broker', async () => {
    // The branch is on the platform because `expo-secure-store` LOADS on Android
    // too — it would just ignore the access group and read a package-private
    // item, which is indistinguishable from an empty shared slot.
    const secureStore = makeSecureStoreMock();
    const broker: BrokerModule = {
      read: jest.fn(async () => ({ status: 'present', ...CRED })),
      write: jest.fn(async () => true),
      clear: jest.fn(async () => undefined),
    };
    const store = loadStore('ios', { secureStore, broker });
    await store?.read();
    expect(broker.read).not.toHaveBeenCalled();
    expect(secureStore.calls.length).toBeGreaterThan(0);
  });

  test('Android uses the broker, not the keychain', async () => {
    const secureStore = makeSecureStoreMock();
    const broker: BrokerModule = {
      read: jest.fn(async () => ({ status: 'absent' })),
      write: jest.fn(async () => true),
      clear: jest.fn(async () => undefined),
    };
    const store = loadStore('android', { secureStore, broker });
    await expect(store?.read()).resolves.toEqual({ state: 'absent' });
    expect(broker.read).toHaveBeenCalled();
    expect(secureStore.calls).toHaveLength(0);
  });
});

describe('iOS keychain-group slot', () => {
  test('a missing item is absent; a THROWN read is unavailable', async () => {
    const secureStore = makeSecureStoreMock();
    const store = loadStore('ios', { secureStore });

    await expect(store?.read()).resolves.toEqual({ state: 'absent' });

    secureStore.setReadError(new Error('User interaction is not allowed'));
    const locked = await store?.read();
    // The pair that must never be confused. `absent` authorises seeding the slot.
    expect(locked?.state).toBe('unavailable');
  });

  test('an unparseable item is unavailable, never absent', async () => {
    const secureStore = makeSecureStoreMock();
    secureStore.items.set(STORAGE_KEY, 'not-json-at-all');
    const store = loadStore('ios', { secureStore });
    // Something IS stored. Reporting absent would authorise overwriting whatever
    // a newer build put there.
    expect((await store?.read())?.state).toBe('unavailable');
  });

  test('reads and writes carry the dedicated service AND the access group', async () => {
    const secureStore = makeSecureStoreMock();
    const store = loadStore('ios', { secureStore });
    await store?.publish(CRED);

    // Without `keychainAccessGroup` the item is package-private and no sibling
    // app can ever join. Without the dedicated `keychainService` it shares the
    // legacy shared-IDENTITY namespace inside the group — the exact conflation
    // this phase exists to end.
    for (const call of secureStore.calls) {
      expect(call.options).toMatchObject({
        keychainService: 'oxy_device_session',
        keychainAccessGroup: 'group.so.oxy.shared',
      });
    }
    expect(secureStore.calls.length).toBeGreaterThan(0);
  });

  test('the item is written device-only so it never rides an OS backup to a new handset', async () => {
    const secureStore = makeSecureStoreMock();
    const store = loadStore('ios', { secureStore });
    await store?.publish(CRED);
    const write = secureStore.calls.find((c) => c.options?.keychainAccessible !== undefined);
    expect(write?.options?.keychainAccessible).toBe(secureStore.module.WHEN_UNLOCKED_THIS_DEVICE_ONLY);
  });

  test('a publish round-trips and reads back as present', async () => {
    const secureStore = makeSecureStoreMock();
    const store = loadStore('ios', { secureStore });
    await expect(store?.publish(CRED)).resolves.toBe(true);
    await expect(store?.read()).resolves.toEqual({ state: 'present', credential: CRED });
  });

  test('a write that silently does not land reports false', async () => {
    // A keychain write can resolve without the item landing under the access
    // group (a missing entitlement is the usual cause). A phantom credential
    // would send a fresh install into a mint that can never succeed.
    const secureStore = makeSecureStoreMock();
    secureStore.setSwallowWrites(true);
    const store = loadStore('ios', { secureStore });
    await expect(store?.publish(CRED)).resolves.toBe(false);
  });

  test('a throwing write reports false rather than propagating', async () => {
    const secureStore = makeSecureStoreMock();
    secureStore.setWriteError(new Error('keychain error -34018'));
    const store = loadStore('ios', { secureStore });
    await expect(store?.publish(CRED)).resolves.toBe(false);
  });

  test('the slot is unsupported when expo-secure-store is not installed', async () => {
    const store = loadStore('ios');
    // No `expo-secure-store` mock registered → the dynamic import rejects.
    expect((await store?.read())?.state).toBe('unsupported');
  });
});

describe('Android broker slot', () => {
  test('narrows a present payload', async () => {
    const store = loadStore('android', {
      broker: { read: async () => ({ status: 'present', ...CRED }), write: async () => true, clear: async () => undefined },
    });
    await expect(store?.read()).resolves.toEqual({ state: 'present', credential: CRED });
  });

  test('an explicit unavailable status stays unavailable', async () => {
    const store = loadStore('android', {
      broker: {
        read: async () => ({ status: 'unavailable', reason: 'GeneralSecurityException' }),
        write: async () => true,
        clear: async () => undefined,
      },
    });
    expect((await store?.read())?.state).toBe('unavailable');
  });

  test('a THROWN broker call is unavailable, never absent', async () => {
    const store = loadStore('android', {
      broker: {
        read: async () => {
          throw new Error('binder transaction failed');
        },
        write: async () => true,
        clear: async () => undefined,
      },
    });
    expect((await store?.read())?.state).toBe('unavailable');
  });

  test('an unrecognised payload from an older sibling is unavailable, never absent', async () => {
    const store = loadStore('android', {
      broker: { read: async () => ({ ok: true }), write: async () => true, clear: async () => undefined },
    });
    expect((await store?.read())?.state).toBe('unavailable');
  });

  test('the slot is unsupported when the native module is not linked', async () => {
    const store = loadStore('android', { broker: null });
    expect((await store?.read())?.state).toBe('unsupported');
    await expect(store?.publish(CRED)).resolves.toBe(false);
  });

  test('publish forwards the broker’s own read-back verdict', async () => {
    const unverified = loadStore('android', {
      broker: { read: async () => ({ status: 'absent' }), write: async () => false, clear: async () => undefined },
    });
    await expect(unverified?.publish(CRED)).resolves.toBe(false);
  });
});
