import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { KeyManager, type IdentityDeviceBackupStore } from '@oxy.so/core';

/**
 * The identity's device backup in Android Block Store (OxyHQ/oxy#1388).
 *
 * Every Oxy Android app shares the UID `so.oxy.shared`, and clearing the storage
 * of any of them wipes the Keystore of the whole UID, taking every copy of the
 * identity that `KeyManager` keeps with it. Block Store keeps this copy in
 * Google Play services' own storage, where that wipe cannot reach, and reads it
 * back without the network, so Commons restores the identity silently instead of
 * asking for the recovery phrase. Design and threat model:
 * `docs/identity/device-backup.md`.
 */

/** The Block Store key. One entry; the record format is `@oxy.so/core`'s. */
export const IDENTITY_BACKUP_KEY = 'so.oxy.identity.device-backup.v1';

/** The native half: `modules/oxy-identity-backup`. */
interface OxyIdentityBackupNative {
  read(key: string): Promise<string | null>;
  /** Resolves whether the value also reaches the end-to-end encrypted cloud backup. */
  write(key: string, value: string): Promise<boolean>;
  clear(key: string): Promise<void>;
}

/**
 * The Block Store backup, or `null` when this binary cannot keep one.
 *
 * Commons ships JavaScript over the air to binaries that are already installed.
 * A binary built before the native module existed has no `OxyIdentityBackup`, so
 * the module is looked up with `requireOptionalNativeModule` (as
 * `usePreventScreenCapture` does): an old binary simply has no device backup and
 * keeps the recovery-phrase fallback, a new one is protected. iOS returns `null`
 * on purpose: its keychain is not wiped by another app (see the doc).
 */
export function createBlockStoreBackup(): IdentityDeviceBackupStore | null {
  if (Platform.OS !== 'android') return null;
  const native = requireOptionalNativeModule<OxyIdentityBackupNative>('OxyIdentityBackup');
  if (!native || typeof native.read !== 'function') return null;
  return {
    name: 'android-block-store',
    // A rejection (no Google Play services, Block Store unavailable) is caught
    // and logged by KeyManager, which treats it as "no device backup".
    read: () => native.read(IDENTITY_BACKUP_KEY),
    write: async (value: string) => {
      await native.write(IDENTITY_BACKUP_KEY, value);
    },
    clear: () => native.clear(IDENTITY_BACKUP_KEY),
  };
}

let installed = false;

/**
 * Register the Block Store backup with `KeyManager`. Call once, at module scope
 * of the root layout, before the first identity read. Commons is the only app
 * that does this: the backup is a full copy of the private key and belongs to the
 * app that holds the identity.
 */
export function installIdentityDeviceBackup(): void {
  if (installed) return;
  installed = true;
  KeyManager.setDeviceBackupStore(createBlockStoreBackup());
}
