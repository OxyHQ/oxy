/**
 * Platform `AuthStateStore` for `@oxyhq/services`.
 *
 * The zero-cookie device model persists the durable device credential
 * (`deviceId` + `deviceSecret`) per origin (web) / per device (native), and the
 * SDK re-mints the access token from that credential on cold boot. `@oxyhq/core`
 * owns the store shape + logic (`createWebAuthStateStore` /
 * `createNativeAuthStateStore`); this module only selects the platform storage
 * seam:
 *
 *  - web  → `createWebAuthStateStore()` (localStorage, in-memory fallback).
 *  - native → `createNativeAuthStateStore(secureKV)` for the SESSION blob over
 *    the shared `createNativeSecureKeyValueStorage()` adapter
 *    (`expo-secure-store`, AsyncStorage fallback), WRAPPED so every credential
 *    it persists is also mirrored into the device-wide shared slot.
 *
 * The native wrapper is how several official apps end up on ONE `DeviceSession`
 * (and therefore one active context): whichever app proves a credential publishes
 * it, and a later-installed sibling adopts it during cold boot instead of asking
 * for the Commons identity key. The mirror is additive — it can neither change
 * nor fail the app's own durable write.
 */
import {
  createWebAuthStateStore,
  createNativeAuthStateStore,
  createSharedMirroringAuthStateStore,
  type AuthStateStore,
  type SessionMode,
} from '@oxyhq/core';
import { isReactNative } from '../utils/storageHelpers';
import { createNativeSecureKeyValueStorage } from './nativeSecureStorage';
import { createPlatformSharedDeviceCredentialStore } from './sharedDeviceCredentialStore';

export interface PlatformAuthStateStoreOptions {
  /**
   * Who owns the session this provider resolves. Only `'account'` mirrors into
   * the device-wide shared slot.
   *
   * `'identity'` (the vault) is deliberately excluded, which keeps its storage
   * behaviour byte-for-byte what it is today. The vault's credential is a
   * perfectly valid device credential, so publishing it would arguably be
   * correct — but it would also let every ordinary app on the device join the
   * vault's device session as a side effect of the vault persisting a token, and
   * "a background write changes which session five other apps boot into" is not
   * a decision a storage seam gets to make.
   */
  sessionMode?: SessionMode;
}

/**
 * Build the platform {@link AuthStateStore} for this runtime.
 *
 * Native persists the SESSION blob (`deviceId` + `deviceSecret` + cached access
 * token) per-app in SecureStore; the SDK re-mints the access token from the
 * device credential on the next cold boot.
 */
export function createPlatformAuthStateStore(
  options: PlatformAuthStateStoreOptions = {},
): AuthStateStore {
  if (!isReactNative()) {
    return createWebAuthStateStore();
  }

  const local = createNativeAuthStateStore(createNativeSecureKeyValueStorage());
  if (options.sessionMode === 'identity') {
    return local;
  }
  const shared = createPlatformSharedDeviceCredentialStore();
  return shared ? createSharedMirroringAuthStateStore({ local, shared }) : local;
}
