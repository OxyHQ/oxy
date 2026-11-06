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
  /**
   * Set only on an answer for an ORGANIZATION key (ADR 0061 D6): the account id
   * Commons echoed, always equal to the one asked for. An answer without it is
   * the personal identity and is never taken as an organization's.
   */
  accountId?: string;
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
 * On iOS these methods resolve `null`: the keychain access groups in
 * `@oxy.so/core`'s `KeyManager` own iOS sharing (docs/identity/ios-keychain-access-groups.md).
 *
 * The three `*Retired*` methods (Commons protocol 4) reach a key the person,
 * or the organization with `accountId`, rotated away from, by its public key,
 * for SPENDING the coins still at its addresses: never for signing in. They are
 * always present on the bridge and resolve `null` on a native module or a
 * Commons that predates them; an answer that does not echo the key (and the
 * account) asked for is refused, because the current key taken for a retired
 * one is a payment signed by the wrong key.
 */
export interface CommonsIdentityBridge {
  /**
   * The public key of the identity Commons holds, or, with `accountId`, of that
   * organization's key (ADR 0061 D6).
   */
  describe(accountId?: string): Promise<CommonsIdentityDescription | null>;
  /** Sign a server challenge (64 lowercase hex) for `POST /auth/verify`. */
  proveIdentity(challenge: string): Promise<CommonsIdentityProof | null>;
  /**
   * HKDF-SHA256 over the identity key (or, with `accountId`, the organization's
   * key), 32 bytes as lowercase hex, identical to `KeyManager.deriveScopedSeed`
   * on the device that holds the key. Commons allows each caller package only
   * its own `info` labels.
   */
  deriveScopedSeed(info: string, accountId?: string): Promise<string | null>;
  /**
   * Sign a 32-byte digest (64 hex) with the social-receive child key `index`
   * of the identity, or with `accountId`, of that organization's key. Allowed
   * for the wallet app only.
   */
  signSocialReceive(
    index: number,
    digest: string,
    accountId?: string,
  ): Promise<CommonsSocialReceiveSignature | null>;
  /**
   * The public keys (lowercase uncompressed SEC1 hex, de-duplicated) of the
   * retired keys Commons holds for the person, or with `accountId` for that
   * organization, minus the current one. `[]` when it holds none; `null` when
   * Commons cannot say (absent, refused, or older than retired keys). Allowed
   * for the wallet app only.
   */
  listRetiredKeys(accountId?: string): Promise<string[] | null>;
  /**
   * {@link deriveScopedSeed} over the key of that scope whose public key is
   * `publicKey` (current or retired), never another key: `null` when Commons
   * does not hold it.
   */
  deriveRetiredScopedSeed(
    info: string,
    publicKey: string,
    accountId?: string,
  ): Promise<string | null>;
  /**
   * {@link signSocialReceive} with the social-receive child `index` of the key
   * of that scope whose public key is `publicKey` (current or retired), never
   * another key. Allowed for the wallet app only.
   */
  signRetiredSocialReceive(
    index: number,
    digest: string,
    publicKey: string,
    accountId?: string,
  ): Promise<CommonsSocialReceiveSignature | null>;
}

/**
 * What the iOS keychain says about this app's DEFAULT access group: the first
 * entry of its `keychain-access-groups` entitlement, team prefix included
 * (`ABCDE12345.so.oxy.identity`). The value is read back from a probe item the
 * native module writes without a group, because JavaScript cannot see the
 * entitlements or the team prefix (`$(AppIdentifierPrefix)` expands at build
 * time), and `kSecAttrAccessGroup` must equal an entitlement value exactly.
 *
 * - `resolved`: the group string, as the keychain reported it.
 * - `unsupported`: not iOS, or a native build whose `OxyIdentity` module
 *   predates the probe. Callers keep the single-group behaviour that build was
 *   made for.
 * - `unavailable`: the probe threw (before first unlock, keychain refused).
 *   Transient; never cached.
 */
export type KeychainDefaultAccessGroup =
  | { state: 'resolved'; accessGroup: string }
  | { state: 'unsupported' }
  | { state: 'unavailable'; cause: unknown };
