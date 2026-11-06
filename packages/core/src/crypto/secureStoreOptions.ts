/**
 * The `expo-secure-store` options `@oxy.so/core` passes.
 *
 * Standalone, not `SecureStoreOptions` itself, so the PUBLISHED declarations
 * never name expo-secure-store: under NodeNext its types pull in
 * expo-modules-core and turn every Node timer into a DOM `number` in server
 * consumers. The check below still makes `tsc` refuse a field name the real
 * package does not have — `keychainAccessGroup` instead of `accessGroup` sat
 * here unnoticed for years behind a hand-written ambient shim, so no item was
 * ever written to the group the code named (docs/identity/ios-keychain-access-groups.md).
 */
import type { SecureStoreOptions } from 'expo-secure-store';

export interface OxySecureStoreOptions {
  /** Keychain service name (Android keystore alias / iOS `kSecAttrService`). */
  keychainService?: string;
  /** Item accessibility: the `ExpoSecureStoreLike` constant, e.g. `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. */
  keychainAccessible?: number;
  /** Prompt shown for biometric-protected items. */
  authenticationPrompt?: string;
  /** Whether Face ID / Touch ID is required to read the item. */
  requireAuthentication?: boolean;
  /**
   * iOS `kSecAttrAccessGroup`: the FULL, team-prefixed entitlement value. Set
   * only through `../utils/keychainAccessGroups`, never by hand.
   */
  accessGroup?: string;
}

/** Every key above must be one `expo-secure-store` reads; a misspelt one fails `tsc` here. */
type FieldsExpoReads = Pick<SecureStoreOptions, keyof OxySecureStoreOptions>;
type AssertExpoReadsEveryField = FieldsExpoReads;
