import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import { KeyManager, type IdentityDeviceBackupStore } from '@oxy.so/core/crypto';

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

/** The native module, or `null` off Android and on binaries built without it. */
function loadNative(): OxyIdentityBackupNative | null {
  if (Platform.OS !== 'android') return null;
  const native = requireOptionalNativeModule<OxyIdentityBackupNative>('OxyIdentityBackup');
  if (!native || typeof native.read !== 'function') return null;
  return native;
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
  const native = loadNative();
  if (!native) return null;
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

/**
 * Whether this device can keep the identity's device backup at all.
 *
 * - `not-applicable`: not Android. iOS has no shared-UID Keystore to lose.
 * - `unavailable`: Android, and the backup can never be written here: the binary
 *   predates the native module, or Block Store itself is missing (no Google Play
 *   services: LineageOS, GrapheneOS without sandboxed Play, Huawei/HMS, some
 *   enterprise builds). A sibling app's "Clear storage" still wipes the identity
 *   on this device, so the only protection left is the phrase (OxyHQ/oxy#1388).
 * - `available`: Block Store answered.
 * - `unknown`: Block Store failed for some other, possibly transient, reason. It
 *   is not reported as `unavailable`, so a hiccup never shows the warning.
 */
export type DeviceBackupAvailability = 'available' | 'unavailable' | 'not-applicable' | 'unknown';

/**
 * Google Play services' "this API cannot run on this device" signals, as they
 * reach JS in the message of an `ERR_IDENTITY_BACKUP_*` rejection. Observed on a
 * LineageOS Pixel with no GMS: `17: API: Blockstore.API is not available on this
 * device. Connection failed with: a{statusCode=SERVICE_INVALID}`.
 */
const UNAVAILABLE_MARKERS = [
  'SERVICE_INVALID',
  'SERVICE_MISSING',
  'SERVICE_DISABLED',
  'API_UNAVAILABLE',
  'not available on this device',
] as const;

/** True when a Block Store rejection means "this device has no Block Store". */
export function isBlockStoreUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { message, code } = error as { message?: unknown; code?: unknown };
  const text = `${typeof code === 'string' ? code : ''} ${typeof message === 'string' ? message : ''}`;
  return UNAVAILABLE_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Probe the device backup with one local Block Store read (no network, the same
 * read `KeyManager.ensureDeviceBackup` does on every launch). Never throws.
 * Needs no new native code, so an over-the-air update to a binary that already
 * links `OxyIdentityBackup` gets the right answer.
 */
export async function probeDeviceBackupAvailability(): Promise<DeviceBackupAvailability> {
  if (Platform.OS !== 'android') return 'not-applicable';
  const native = loadNative();
  if (!native) return 'unavailable';
  try {
    await native.read(IDENTITY_BACKUP_KEY);
    return 'available';
  } catch (error) {
    return isBlockStoreUnavailableError(error) ? 'unavailable' : 'unknown';
  }
}
