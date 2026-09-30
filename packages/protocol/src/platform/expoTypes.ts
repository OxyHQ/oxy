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

/** What Commons says about the identity it holds (`describe`). */
export interface CommonsIdentityDescription {
  /** Protocol version of the Commons identity host. */
  v: number;
  /** The identity's public key, lowercase uncompressed SEC1 hex. */
  publicKey: string;
}

/**
 * A signed server challenge from Commons (`proveIdentity`). The fields plug
 * straight into `POST /auth/verify`: Commons signed
 * `sha256("auth:${publicKey}:${challenge}:${timestamp}")`, DER hex.
 */
export interface CommonsIdentityProof {
  publicKey: string;
  signature: string;
  timestamp: number;
}

/** A social-receive input signature from Commons (`signSocialReceive`). */
export interface CommonsSocialReceiveSignature {
  /** DER hex, low-S, over the 32-byte digest the caller sent. */
  signature: string;
  /** The child key's compressed SEC1 public key, for the scriptSig. */
  publicKey: string;
}

/**
 * Structural interface for the `OxyIdentity` native module in
 * `@oxy.so/services`: the client side of the identity Commons holds.
 *
 * On Android every method is one signature-protected `ContentProvider.call()`
 * into Commons (`so.oxy.commons[.dev].identity`). Commons is the only app that
 * holds the private key, and no method returns it or anything it can be
 * recovered from: callers get the public key, signatures and domain-separated
 * derivations, the way apps get tokens from `AccountManager`. Every method
 * resolves `null` when Commons is not installed, holds no identity, or refuses
 * the caller.
 *
 * On iOS the module is a stub that resolves `null`: the Keychain Access Group
 * path in `@oxy.so/core`'s `KeyManager` owns iOS sharing.
 */
export interface CommonsIdentityBridge {
  /** The public key of the identity Commons holds. */
  describe(): Promise<CommonsIdentityDescription | null>;
  /** Sign a server challenge (64 lowercase hex) for `POST /auth/verify`. */
  proveIdentity(challenge: string): Promise<CommonsIdentityProof | null>;
  /**
   * HKDF-SHA256 over the identity key, 32 bytes as lowercase hex, identical to
   * `KeyManager.deriveScopedSeed(info)` on the device that holds the key.
   * Commons allows each caller package only its own `info` labels.
   */
  deriveScopedSeed(info: string): Promise<string | null>;
  /**
   * Sign a 32-byte digest (64 hex) with the social-receive child key `index`
   * of the identity. Allowed for the wallet app only.
   */
  signSocialReceive(index: number, digest: string): Promise<CommonsSocialReceiveSignature | null>;
}
