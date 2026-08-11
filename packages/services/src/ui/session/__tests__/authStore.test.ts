/**
 * Which apps mirror their device credential into the device-wide shared slot.
 *
 * The mirror is what makes a later-installed official app able to JOIN this
 * device's session instead of asking for the Commons identity key. It runs on
 * native, in `'account'` mode only — the identity vault is excluded so that a
 * background persist inside the vault can never change which session five other
 * apps boot into.
 */
import type { AuthStateStore } from '@oxyhq/core';

const CRED_STATE = { sessionId: 'sess-1', userId: 'user-1', deviceId: 'dev-1', deviceSecret: 'ds-1' };

/** Track every credential handed to the shared slot by the store under test. */
function makeSharedSpy() {
  const published: { deviceId: string; deviceSecret: string }[] = [];
  return {
    published,
    store: {
      read: async () => ({ state: 'absent' as const }),
      publish: async (credential: { deviceId: string; deviceSecret: string }) => {
        published.push(credential);
        return true;
      },
      clear: async () => undefined,
    },
  };
}

/**
 * Build the platform store with the native seams stubbed. `jest.resetModules()`
 * + `require` rather than `jest.isolateModules` for the same reason as
 * `sharedDeviceCredentialStore.test.ts`: a factory registered inside an isolate
 * leaked into the next one.
 */
function loadAuthStore(
  os: 'ios' | 'android' | 'web',
  sessionMode: 'account' | 'identity',
  shared: ReturnType<typeof makeSharedSpy>,
): AuthStateStore {
  jest.resetModules();
  jest.doMock('../sharedDeviceCredentialStore', () => ({
    createPlatformSharedDeviceCredentialStore: () => (os === 'web' ? null : shared.store),
  }));
  const rn = require('react-native') as { Platform: { OS: string } };
  rn.Platform.OS = os;
  // `authStore` selects web-vs-native with `isReactNative()`, which reads
  // `navigator.product` — NOT `Platform.OS`. Setting only the latter leaves it on
  // the web branch, where nothing mirrors and every case passes for the wrong
  // reason.
  Object.defineProperty(globalThis.navigator, 'product', {
    value: os === 'web' ? 'Gecko' : 'ReactNative',
    configurable: true,
  });
  const mod = require('../authStore') as typeof import('../authStore');
  return mod.createPlatformAuthStateStore({ sessionMode });
}

afterEach(() => {
  jest.dontMock('../sharedDeviceCredentialStore');
  Object.defineProperty(globalThis.navigator, 'product', { value: 'Gecko', configurable: true });
  jest.resetModules();
});

describe('createPlatformAuthStateStore', () => {
  test('an ordinary native app publishes its credential to the shared slot', async () => {
    const shared = makeSharedSpy();
    const store = loadAuthStore('android', 'account', shared);
    await store.save(CRED_STATE);
    expect(shared.published).toEqual([{ deviceId: 'dev-1', deviceSecret: 'ds-1' }]);
  });

  test('the identity vault does NOT publish', async () => {
    // The vault's credential is a perfectly valid device credential, so this is a
    // deliberate abstention, not an impossibility: publishing it would let every
    // ordinary app on the device join the vault's session as a side effect of the
    // vault persisting a token.
    const shared = makeSharedSpy();
    const store = loadAuthStore('android', 'identity', shared);
    await store.save(CRED_STATE);
    expect(shared.published).toEqual([]);
  });

  test('web has no shared slot to publish into', async () => {
    const shared = makeSharedSpy();
    const store = loadAuthStore('web', 'account', shared);
    await store.save(CRED_STATE);
    expect(shared.published).toEqual([]);
  });
});
