/**
 * Tests for the storage helpers.
 *
 * The OxyContext keys the chosen language with `getStorageKeys`. The key name
 * below is part of the public contract — changing it without a migration
 * would forget every device's language on upgrade. The session ids the SDK
 * once stored under this prefix had no reader and are no longer written.
 */

import {
  createPlatformStorage,
  getStorageKeys,
  isReactNative,
  STORAGE_KEY_PREFIX,
} from '../../src/ui/utils/storageHelpers';

describe('STORAGE_KEY_PREFIX', () => {
  it('exposes the default `oxy_session` prefix', () => {
    expect(STORAGE_KEY_PREFIX).toBe('oxy_session');
  });
});

describe('getStorageKeys', () => {
  it('produces the one key the OxyProvider depends on', () => {
    expect(getStorageKeys('oxy_session')).toEqual({ language: 'oxy_session_language' });
  });

  it('honors a custom prefix when consumers want to isolate environments', () => {
    expect(getStorageKeys('staging_oxy').language).toBe('staging_oxy_language');
  });

  it('uses the default prefix when called with no argument', () => {
    expect(getStorageKeys()).toEqual({ language: 'oxy_session_language' });
  });
});

describe('isReactNative', () => {
  it('is false in the jsdom test environment', () => {
    expect(isReactNative()).toBe(false);
  });
});

describe('createPlatformStorage', () => {
  it('returns null and swallows errors when localStorage access throws on read', async () => {
    const storage = await createPlatformStorage();
    const getItemSpy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      expect(await storage.getItem('any')).toBeNull();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it('swallows errors when localStorage.setItem throws (e.g. quota exceeded)', async () => {
    const storage = await createPlatformStorage();
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      await expect(storage.setItem('any', 'value')).resolves.toBeUndefined();
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('round-trips values through localStorage when available', async () => {
    const storage = await createPlatformStorage();
    await storage.setItem('token', 'abc');
    expect(await storage.getItem('token')).toBe('abc');
    await storage.removeItem('token');
    expect(await storage.getItem('token')).toBeNull();
  });

  it('clear() removes every stored key', async () => {
    const storage = await createPlatformStorage();
    await storage.setItem('one', '1');
    await storage.setItem('two', '2');
    await storage.clear();
    expect(await storage.getItem('one')).toBeNull();
    expect(await storage.getItem('two')).toBeNull();
  });
});
