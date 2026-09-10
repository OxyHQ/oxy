/**
 * Structural interfaces for Expo platform modules.
 *
 * These replace `typeof import('expo-crypto')` and
 * `typeof import('expo-secure-store')` in the built declaration files of
 * `@oxy.so/protocol` and `@oxy.so/core`.
 *
 * ## Why structural interfaces instead of `typeof import('expo-*')`?
 *
 * Under NodeNext module resolution (used by `@oxy.so/api` and `@oxy.so/node`),
 * `expo-crypto` ships with `"exports": {}` (empty exports map). TypeScript
 * traverses into the package anyway via the `types` field, which transitively
 * loads `expo-modules-core`. That pollution makes `setInterval`/`setTimeout`
 * resolve to DOM's `number` return type rather than Node's `NodeJS.Timeout`,
 * producing ~10 spurious `TS2322` / `TS2339` errors in every consumer that
 * uses Node timer APIs — none of which reference protocol types at all.
 *
 * Structural interfaces break the transitive expo-modules-core dependency
 * entirely: consumers that don't have Expo installed see clean types, and
 * the actual RN runtime (which DOES have Expo installed) still works because
 * the real modules satisfy these interfaces structurally.
 */

/**
 * Minimal structural interface for the subset of `expo-crypto` used by
 * `@oxy.so/protocol` (SHA-256 hashing in RN) and `@oxy.so/core` (key-manager
 * random-byte generation).
 *
 * The real `expo-crypto` namespace satisfies this interface structurally.
 */
export interface ExpoCryptoLike {
  /** Generate `byteCount` cryptographically-random bytes synchronously. */
  getRandomBytes(byteCount: number): Uint8Array;
  /** Generate `byteCount` cryptographically-random bytes asynchronously. */
  getRandomBytesAsync(byteCount: number): Promise<Uint8Array>;
  /**
   * Compute a digest of `data` using the given `algorithm` string
   * (e.g. `CryptoDigestAlgorithm.SHA256`). Used by `recordId.ts` in the
   * React Native runtime path for content-address hashing.
   */
  digestStringAsync(algorithm: string, data: string, options?: unknown): Promise<string>;
  /**
   * Algorithm constants (e.g. `CryptoDigestAlgorithm.SHA256 === 'SHA-256'`).
   * Represented as a plain string-keyed record so the interface does not
   * depend on the enum definition inside expo-crypto.
   */
  readonly CryptoDigestAlgorithm: Record<string, string>;
}

/**
 * Minimal structural interface for the subset of `expo-secure-store` used by
 * `@oxy.so/core` `KeyManager` for on-device identity storage.
 *
 * The real `expo-secure-store` namespace satisfies this interface structurally.
 *
 * `options` are typed as `object` (rather than the concrete `SecureStoreOptions`
 * from expo-secure-store) so callers can pass any plain options bag without
 * importing expo-secure-store's type declarations. TypeScript method bivariance
 * makes the real `setItemAsync(opts?: SecureStoreOptions)` compatible with this
 * `setItemAsync(opts?: object)` signature.
 */
export interface ExpoSecureStoreLike {
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  getItemAsync(key: string, options?: object): Promise<string | null>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
  /**
   * Keychain / Keystore accessibility constant: item accessible only when the
   * device is unlocked, and only on this device (no iCloud backup).
   * Value: `KeychainAccessibilityConstant` (a number alias in expo-secure-store).
   */
  readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
  /**
   * Keychain / Keystore accessibility constant: item accessible whenever the
   * device is unlocked (may be restored to a different device via backup).
   */
  readonly WHEN_UNLOCKED: number;
}

/**
 * Structural interface for the `@oxy.so/expo-oxy-identity` native module — the
 * cross-app shared Oxy identity bridge.
 *
 * On Android the keypair crosses the process boundary through a
 * signature-protected `ContentProvider` hosted by Commons; on iOS every method
 * is a no-op (the Keychain Access Group path in `@oxy.so/core`'s `KeyManager`
 * owns iOS sharing). Typed structurally here so `@oxy.so/protocol` and
 * `@oxy.so/core` can reference the bridge without a hard dependency on the
 * optional native module.
 */
export interface SharedIdentityBridge {
  /** Read the shared keypair, or null when none is available on this device. */
  getShared(): Promise<{ privateKey: string; publicKey: string } | null>;
  /** Persist the shared keypair into this app's hardware-backed store (Commons only). */
  putShared(privateKey: string, publicKey: string): Promise<void>;
  /** Whether a shared identity is readable on this device. */
  hasShared(): Promise<boolean>;
  /** Remove the shared identity from this app's local store (best-effort). */
  clearShared(): Promise<void>;
}
