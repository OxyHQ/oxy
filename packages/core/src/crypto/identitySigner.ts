/**
 * The identity signer store: the copy of the identity key that Commons'
 * identity host signs with on Android.
 *
 * On Android no Oxy app shares a UID any more, so no app can read another's
 * storage. Commons is the ONLY holder of the identity private key. Its identity
 * host (a signature-protected ContentProvider in Commons) answers other Oxy
 * apps with the public key, challenge signatures and scoped derivations, never
 * with the key: the `AccountManager` model. The provider runs natively, so it
 * cannot read the key out of expo-secure-store; it signs with this native
 * copy instead, which `KeyManager` keeps in step with the primary identity.
 *
 * Only Commons registers a store ({@link KeyManager.setIdentitySignerStore}),
 * and only on Android. Everywhere else it is `null` and every path that uses it
 * is a no-op. iOS keeps the keychain access group `group.so.oxy.shared`.
 */
export interface IdentitySignerStore {
  /** Short label for logs. */
  readonly name: string;
  /** The stored key pair, or null when empty. Commons-local; never crosses IPC. */
  read(): Promise<{ privateKey: string; publicKey: string } | null>;
  /** Replace the stored key pair. Resolves whether a read-back confirmed it. */
  write(privateKey: string, publicKey: string): Promise<boolean>;
  /** Drop the stored key pair. */
  clear(): Promise<void>;
  /**
   * An ORGANIZATION key Commons holds (ADR 0061 D6), by the organization's
   * account id: the copy the identity host answers `accountId` requests from.
   * Optional so a store built before organization keys still type-checks; a
   * store without them cannot hold an organization key.
   */
  readOrganization?(accountId: string): Promise<{ privateKey: string; publicKey: string } | null>;
  /** Replace that organization's pair. Resolves whether a read-back confirmed it. */
  writeOrganization?(accountId: string, privateKey: string, publicKey: string): Promise<boolean>;
  /** Drop that organization's pair. */
  clearOrganization?(accountId: string): Promise<void>;
}

/**
 * The store Commons registered, readable by modules that `KeyManager` itself
 * imports (`./organizationKeys`), which therefore cannot import `KeyManager`.
 * Written only by `KeyManager.setIdentitySignerStore`. @internal
 */
let registeredSignerStore: IdentitySignerStore | null = null;

/** @internal */
export function registerIdentitySignerStore(store: IdentitySignerStore | null): void {
  registeredSignerStore = store;
}

/** @internal */
export function registeredIdentitySignerStore(): IdentitySignerStore | null {
  return registeredSignerStore;
}
