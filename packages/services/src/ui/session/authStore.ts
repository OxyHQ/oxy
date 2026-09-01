/**
 * Platform `AuthStateStore` for `@oxyhq/services`.
 *
 * The device model persists the durable device credential (`deviceId` +
 * `deviceSecret`) per origin (web) / per device (native), and the SDK re-mints
 * the access token from that credential on cold boot. `@oxyhq/core` owns the
 * store shape + logic (`createWebAuthStateStore` / `createNativeAuthStateStore` /
 * `createMemoryAuthStateStore`); this module only selects the seam:
 *
 *  - `storage: 'ephemeral'` → `createMemoryAuthStateStore()`, on EVERY platform.
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
  createMemoryAuthStateStore,
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
  /**
   * Whether this origin/app may persist a durable device credential AT ALL.
   *
   * `'ephemeral'` stores nothing durable and mirrors nothing: the session lives
   * in memory for the lifetime of the page and is gone on reload. Its one caller
   * is `auth.oxy.so` with the browser hub enabled (issue #937 Phase 5, ADR 0003),
   * where the durable credential for the browser profile is the server-side
   * DeviceSession behind the `__Host-oxy-device` handle.
   *
   * See `OxyProviderProps.deviceCredentialStorage` for why the answer to "let the
   * hub be authoritative" is to stop persisting the other credential rather than
   * to consult it second.
   */
  storage?: 'persistent' | 'ephemeral';
}

/**
 * Build the platform {@link AuthStateStore} for this runtime.
 *
 * Native persists the SESSION blob (`deviceId` + `deviceSecret` + cached access
 * token) per-app in SecureStore; the SDK re-mints the access token from the
 * device credential on the next cold boot.
 *
 * ## The ephemeral check is FIRST, and the order is load-bearing
 *
 * It short-circuits above the `isReactNative()` branch so an ephemeral caller can
 * never reach the native path — and therefore can never reach the shared-slot
 * mirroring wrapper. Checked after that branch instead, an origin that has
 * declined to persist a credential would publish one into the device-wide slot
 * every sibling app adopts on cold boot: it would keep nothing itself while
 * deciding which session five other apps boot into.
 *
 * That is unreachable today because the only ephemeral caller is a web origin, so
 * `isReactNative()` is false there anyway. Unreachable today is exactly the kind
 * of guarantee that stops holding when someone adds the second caller, so it is
 * structural here rather than incidental, and
 * `__tests__/session/authStoreEphemeral.test.ts` holds the ordering directly.
 */
export function createPlatformAuthStateStore(
  options: PlatformAuthStateStoreOptions = {},
): AuthStateStore {
  // FIRST, above every platform branch — see the docblock for why the ordering
  // is the guarantee and not a coincidence.
  if (options.storage === 'ephemeral') {
    return createMemoryAuthStateStore();
  }

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
