/**
 * Commons' side of the identity device backup (OxyHQ/oxy#1388): the Block Store
 * adapter, how an over-the-air install without the native module behaves, and
 * the boot decision to restore silently instead of showing the recovery screen.
 * KeyManager's own backup / restore / rotation rules are tested in
 * `@oxy.so/core` (`keyManager.deviceBackup.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import { KeyManager, type IdentityStatus, type IdentityRecoveryResult } from '@oxy.so/core';
import {
  createBlockStoreBackup,
  installIdentityDeviceBackup,
  IDENTITY_BACKUP_KEY,
} from '@/lib/identity-backup';
import { readIdentityVerdictWithSilentRestore } from '@/hooks/identity/silentRestore';

const requireOptional = requireOptionalNativeModule as jest.Mock;

function fakeNative() {
  const values = new Map<string, string>();
  return {
    read: jest.fn(async (key: string) => values.get(key) ?? null),
    write: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
      return true;
    }),
    clear: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

describe('createBlockStoreBackup', () => {
  beforeEach(() => {
    requireOptional.mockReset();
    Platform.OS = 'android';
  });

  it('moves one value under one Block Store key', async () => {
    const native = fakeNative();
    requireOptional.mockReturnValue(native);
    const store = createBlockStoreBackup();
    expect(store?.name).toBe('android-block-store');

    await store?.write('record');
    expect(native.write).toHaveBeenCalledWith(IDENTITY_BACKUP_KEY, 'record');
    expect(await store?.read()).toBe('record');
    await store?.clear();
    expect(native.clear).toHaveBeenCalledWith(IDENTITY_BACKUP_KEY);
    expect(await store?.read()).toBeNull();
  });

  it('is absent on a binary without the native module (over-the-air install)', () => {
    requireOptional.mockReturnValue(null);
    expect(createBlockStoreBackup()).toBeNull();
    expect(requireOptional).toHaveBeenCalledWith('OxyIdentityBackup');
  });

  it('is absent on iOS, whose keychain no sibling app can wipe', () => {
    Platform.OS = 'ios';
    requireOptional.mockReturnValue(fakeNative());
    expect(createBlockStoreBackup()).toBeNull();
  });

  it('installIdentityDeviceBackup registers it with KeyManager once', () => {
    const native = fakeNative();
    requireOptional.mockReturnValue(native);
    const spy = jest.spyOn(KeyManager, 'setDeviceBackupStore');
    installIdentityDeviceBackup();
    installIdentityDeviceBackup();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]?.name).toBe('android-block-store');
    spy.mockRestore();
    KeyManager.setDeviceBackupStore(null);
  });
});

describe('readIdentityVerdictWithSilentRestore', () => {
  const PRESENT: IdentityStatus = { state: 'present', publicKey: 'pub' };
  const ABSENT: IdentityStatus = { state: 'absent' };
  const LOST: IdentityStatus = {
    state: 'lost',
    marker: { v: 1, publicKey: 'pub', createdAt: 1, origin: 'create' },
  };

  let status: jest.SpyInstance;
  let recover: jest.SpyInstance;

  beforeEach(() => {
    status = jest.spyOn(KeyManager, 'getIdentityStatus');
    recover = jest.spyOn(KeyManager, 'attemptIdentityRecovery');
  });
  afterEach(() => {
    status.mockRestore();
    recover.mockRestore();
  });

  const recovered: IdentityRecoveryResult = { recovered: true, source: 'device-backup', publicKey: 'pub' };

  it('leaves a present identity alone', async () => {
    status.mockResolvedValueOnce(PRESENT);
    expect(await readIdentityVerdictWithSilentRestore()).toEqual(PRESENT);
    expect(recover).not.toHaveBeenCalled();
  });

  it('restores a lost identity silently: routing sees present, never the recovery screen', async () => {
    status.mockResolvedValueOnce(LOST).mockResolvedValueOnce(PRESENT);
    recover.mockResolvedValueOnce(recovered);
    expect(await readIdentityVerdictWithSilentRestore()).toEqual(PRESENT);
  });

  it('restores an absent identity when a device backup holds one', async () => {
    status.mockResolvedValueOnce(ABSENT).mockResolvedValueOnce(PRESENT);
    recover.mockResolvedValueOnce(recovered);
    expect(await readIdentityVerdictWithSilentRestore()).toEqual(PRESENT);
  });

  it('keeps lost when nothing can be restored, so the phrase path stays the fallback', async () => {
    status.mockResolvedValueOnce(LOST);
    recover.mockResolvedValueOnce({ recovered: false, reason: 'no-sources' });
    expect(await readIdentityVerdictWithSilentRestore()).toEqual(LOST);
  });

  it('keeps absent on a fresh device', async () => {
    status.mockResolvedValueOnce(ABSENT);
    recover.mockResolvedValueOnce({ recovered: false, reason: 'not-lost' });
    expect(await readIdentityVerdictWithSilentRestore()).toEqual(ABSENT);
  });

  it('never lets a throwing restore break the probe', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    status.mockResolvedValueOnce(LOST);
    recover.mockRejectedValueOnce(new Error('boom'));
    expect(await readIdentityVerdictWithSilentRestore()).toEqual(LOST);
    warn.mockRestore();
  });

  it('does not attempt a restore while storage is unavailable', async () => {
    const unavailable: IdentityStatus = { state: 'unavailable', cause: new Error('locked') };
    status.mockResolvedValueOnce(unavailable);
    expect(await readIdentityVerdictWithSilentRestore()).toBe(unavailable);
    expect(recover).not.toHaveBeenCalled();
  });
});

describe('root layout wiring', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'app', '_layout.tsx'), 'utf8');

  it('registers the device backup at module scope, before any identity read', () => {
    expect(source).toMatch(/^installIdentityDeviceBackup\(\);$/m);
  });

  it('keeps the device backup current once per launch', () => {
    expect(source).toContain('await KeyManager.ensureDeviceBackup();');
  });

  it('the boot probe restores silently', () => {
    const hook = readFileSync(join(__dirname, '..', '..', 'hooks', 'useOnboardingStatus.ts'), 'utf8');
    expect(hook).toContain('await readIdentityVerdictWithSilentRestore()');
  });
});
