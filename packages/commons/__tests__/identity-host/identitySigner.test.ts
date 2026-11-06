/**
 * Commons' side of the identity signer store (OxyHQ/oxy#1388): the adapter over
 * the `OxyIdentitySigner` native module, and its registration with KeyManager.
 * KeyManager's own rules (every persist writes it, every delete clears it,
 * `syncSharedIdentity` repairs it) are tested in `@oxy.so/core`
 * (`keyManager.android.test.ts`).
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { KeyManager } from '@oxy.so/core/crypto';
import { createIdentitySignerStore, installIdentitySigner } from '@/lib/identity-signer';

const requireOptional = requireOptionalNativeModule as jest.Mock;

function fakeNative() {
  let pair: { privateKey: string; publicKey: string } | null = null;
  return {
    read: jest.fn(async () => pair),
    write: jest.fn(async (privateKey: string, publicKey: string) => {
      pair = { privateKey, publicKey };
      return true;
    }),
    clear: jest.fn(async () => {
      pair = null;
    }),
  };
}

describe('createIdentitySignerStore', () => {
  beforeEach(() => {
    requireOptional.mockReset();
    Platform.OS = 'android';
  });

  it('moves the pair through the native module', async () => {
    const native = fakeNative();
    requireOptional.mockReturnValue(native);
    const store = createIdentitySignerStore();
    expect(store?.name).toBe('android-identity-signer');
    expect(requireOptional).toHaveBeenCalledWith('OxyIdentitySigner');

    await expect(store?.write('aa', '04bb')).resolves.toBe(true);
    await expect(store?.read()).resolves.toEqual({ privateKey: 'aa', publicKey: '04bb' });
    await store?.clear();
    await expect(store?.read()).resolves.toBeNull();
  });

  it('moves organization pairs through the native module, by account id', async () => {
    const orgPairs = new Map<string, { privateKey: string; publicKey: string }>();
    requireOptional.mockReturnValue({
      ...fakeNative(),
      readOrganization: jest.fn(async (accountId: string) => orgPairs.get(accountId) ?? null),
      writeOrganization: jest.fn(
        async (accountId: string, privateKey: string, publicKey: string) => {
          orgPairs.set(accountId, { privateKey, publicKey });
          return true;
        },
      ),
      clearOrganization: jest.fn(async (accountId: string) => {
        orgPairs.delete(accountId);
      }),
    });
    const store = createIdentitySignerStore();
    const org = '0123456789abcdef01234567';
    await expect(store?.writeOrganization?.(org, 'cc', '04dd')).resolves.toBe(true);
    await expect(store?.readOrganization?.(org)).resolves.toEqual({
      privateKey: 'cc',
      publicKey: '04dd',
    });
    // The personal pair is a different entry.
    await expect(store?.read()).resolves.toBeNull();
    await store?.clearOrganization?.(org);
    await expect(store?.readOrganization?.(org)).resolves.toBeNull();
  });

  it('offers no organization methods on a binary built before them', () => {
    requireOptional.mockReturnValue(fakeNative());
    const store = createIdentitySignerStore();
    expect(store?.readOrganization).toBeUndefined();
    expect(store?.writeOrganization).toBeUndefined();
  });

  it('moves retired pairs through the native module, by scope and public key', async () => {
    const ring = new Map<string, { privateKey: string; publicKey: string }>();
    const native = {
      ...fakeNative(),
      readRetired: jest.fn(
        async (scope: string, publicKey: string) => ring.get(`${scope}/${publicKey}`) ?? null,
      ),
      writeRetired: jest.fn(async (scope: string, privateKey: string, publicKey: string) => {
        ring.set(`${scope}/${publicKey}`, { privateKey, publicKey });
        return true;
      }),
      // The native list may carry anything; only strings come through.
      listRetired: jest.fn(async (scope: string) => [
        ...[...ring.keys()].filter((k) => k.startsWith(`${scope}/`)).map((k) => k.split('/')[1]),
        42,
      ]),
      clearRetired: jest.fn(async (scope: string, publicKey: string) => {
        ring.delete(`${scope}/${publicKey}`);
      }),
    };
    requireOptional.mockReturnValue(native);
    const store = createIdentitySignerStore();
    const org = '0123456789abcdef01234567';
    await expect(store?.writeRetired?.('personal', 'aa', '04bb')).resolves.toBe(true);
    await expect(store?.writeRetired?.(org, 'cc', '04dd')).resolves.toBe(true);
    await expect(store?.readRetired?.('personal', '04bb')).resolves.toEqual({
      privateKey: 'aa',
      publicKey: '04bb',
    });
    await expect(store?.listRetired?.('personal')).resolves.toEqual(['04bb']);
    await expect(store?.listRetired?.(org)).resolves.toEqual(['04dd']);
    // The ring is not the personal pair.
    await expect(store?.read()).resolves.toBeNull();
    await store?.clearRetired?.('personal', '04bb');
    await expect(store?.readRetired?.('personal', '04bb')).resolves.toBeNull();
    await expect(store?.listRetired?.('personal')).resolves.toEqual([]);
    expect(native.clearRetired).toHaveBeenCalledWith('personal', '04bb');
  });

  it('offers no retired ring unless the binary carries all four functions', async () => {
    requireOptional.mockReturnValue(fakeNative());
    expect(createIdentitySignerStore()?.writeRetired).toBeUndefined();
    requireOptional.mockReturnValue({
      ...fakeNative(),
      readRetired: jest.fn(async () => null),
      writeRetired: jest.fn(async () => true),
      listRetired: jest.fn(async () => []),
    });
    const store = createIdentitySignerStore();
    expect(store?.readRetired).toBeUndefined();
    expect(store?.writeRetired).toBeUndefined();
    expect(store?.listRetired).toBeUndefined();
    expect(store?.clearRetired).toBeUndefined();
  });

  it('reads a malformed retired list as empty', async () => {
    requireOptional.mockReturnValue({
      ...fakeNative(),
      readRetired: jest.fn(async () => ({ privateKey: 1, publicKey: '04bb' })),
      writeRetired: jest.fn(async () => true),
      listRetired: jest.fn(async () => ({ length: 1 })),
      clearRetired: jest.fn(async () => undefined),
    });
    const store = createIdentitySignerStore();
    await expect(store?.listRetired?.('personal')).resolves.toEqual([]);
    await expect(store?.readRetired?.('personal', '04bb')).resolves.toBeNull();
  });

  it('reads a malformed native answer as empty', async () => {
    requireOptional.mockReturnValue({
      ...fakeNative(),
      read: jest.fn(async () => ({ privateKey: 1 })),
    });
    await expect(createIdentitySignerStore()?.read()).resolves.toBeNull();
  });

  it('is absent off Android and on a binary without the native module', () => {
    requireOptional.mockReturnValue(null);
    expect(createIdentitySignerStore()).toBeNull();
    Platform.OS = 'ios';
    requireOptional.mockReturnValue(fakeNative());
    expect(createIdentitySignerStore()).toBeNull();
  });

  it('registers once with KeyManager', () => {
    requireOptional.mockReturnValue(fakeNative());
    const spy = jest.spyOn(KeyManager, 'setIdentitySignerStore');
    installIdentitySigner();
    installIdentitySigner();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]?.name).toBe('android-identity-signer');
    spy.mockRestore();
  });
});
