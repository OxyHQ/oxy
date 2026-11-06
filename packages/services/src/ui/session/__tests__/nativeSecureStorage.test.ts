/**
 * The native secure key/value seam on iOS (ADR 0062 D6): every key it stores is
 * one every Oxy app writes under the same name, so each call must name only this
 * app's own locations — never the shared group's copy, which may be another
 * app's session. `@oxy.so/core` owns and tests the placement rules against a
 * keychain with Apple's semantics (`ownSessionItems.test.ts`); what is pinned
 * here is that this adapter asks for them per key and passes them through.
 */
import type { KeychainAccess, NativeKeyValueStorage } from '@oxy.so/core/session';

const TEAM = 'ABCDE12345.';
const SHARED = `${TEAM}group.so.oxy.shared`;
const IDENTITY = `${TEAM}so.oxy.identity`;
const MENTION = `${TEAM}so.oxy.mention`;
const COMMONS = `${TEAM}so.oxy.commons`;
const MARKER = 'oxy.auth.automatic-identity-signin-suppressed.v1';

function makeSecureStore() {
  const calls: Array<{ op: string; key: string; options?: Record<string, unknown> }> = [];
  return {
    calls,
    module: {
      getItemAsync: async (key: string, options?: Record<string, unknown>) => {
        calls.push({ op: 'get', key, options });
        return null;
      },
      setItemAsync: async (key: string, _value: string, options?: Record<string, unknown>) => {
        calls.push({ op: 'set', key, options });
      },
      deleteItemAsync: async (key: string, options?: Record<string, unknown>) => {
        calls.push({ op: 'delete', key, options });
      },
    },
  };
}

function load(access: KeychainAccess, secureStore: ReturnType<typeof makeSecureStore>) {
  jest.resetModules();
  jest.doMock('@oxy.so/core/session', () => ({
    ...jest.requireActual('@oxy.so/core/session'),
    resolveKeychainAccess: async () => access,
  }));
  jest.doMock('expo-secure-store', () => secureStore.module);
  const mod = require('../nativeSecureStorage') as typeof import('../nativeSecureStorage');
  return mod.createNativeSecureKeyValueStorage();
}

async function exercise(storage: NativeKeyValueStorage, key: string) {
  await storage.getItem(key);
  await storage.setItem(key, 'v');
  await storage.removeItem(key);
}

const options = (store: ReturnType<typeof makeSecureStore>, key: string) =>
  store.calls.filter((c) => c.key === key).map((c) => [c.op, c.options]);

afterEach(() => {
  jest.dontMock('@oxy.so/core/session');
  jest.dontMock('expo-secure-store');
  jest.resetModules();
});

describe('createNativeSecureKeyValueStorage on iOS', () => {
  test('a member keeps its session in its own group, never the shared copy', async () => {
    const store = makeSecureStore();
    const storage = load(
      { mode: 'grouped', prefix: TEAM, defaultGroup: SHARED, role: 'member', appGroup: MENTION },
      store,
    );
    for (const key of ['oxy.auth.v1', 'oxy.auth.token.v1', 'oxy.identity.pin.v1']) {
      await exercise(storage, key);
      expect(options(store, key)).toEqual([
        ['get', { accessGroup: MENTION }],
        ['set', { accessGroup: MENTION }],
        ['delete', { accessGroup: MENTION }],
      ]);
    }
  });

  test('the sign-out marker also honours, and releases, a shared copy', async () => {
    const store = makeSecureStore();
    const storage = load(
      { mode: 'grouped', prefix: TEAM, defaultGroup: SHARED, role: 'member', appGroup: MENTION },
      store,
    );
    await exercise(storage, MARKER);
    expect(options(store, MARKER)).toEqual([
      ['get', { accessGroup: MENTION }],
      ['get', { accessGroup: SHARED }],
      ['set', { accessGroup: MENTION }],
      ['delete', { accessGroup: SHARED }],
      ['delete', { accessGroup: MENTION }],
    ]);
  });

  test('Commons reads the copy the split put in its default group, and deletes it first', async () => {
    const store = makeSecureStore();
    const storage = load(
      { mode: 'grouped', prefix: TEAM, defaultGroup: IDENTITY, role: 'holder', appGroup: COMMONS },
      store,
    );
    await exercise(storage, 'oxy.auth.v1');
    expect(options(store, 'oxy.auth.v1')).toEqual([
      ['get', { accessGroup: COMMONS }],
      ['get', { accessGroup: IDENTITY }],
      ['set', { accessGroup: COMMONS }],
      ['delete', { accessGroup: IDENTITY }],
      ['delete', { accessGroup: COMMONS }],
    ]);
  });

  test('Android, web and an older native build pass no group', async () => {
    const store = makeSecureStore();
    await exercise(load({ mode: 'ungrouped' }, store), 'oxy.auth.v1');
    expect(options(store, 'oxy.auth.v1')).toEqual([
      ['get', {}],
      ['set', {}],
      ['delete', {}],
    ]);
  });
});
