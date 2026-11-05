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
