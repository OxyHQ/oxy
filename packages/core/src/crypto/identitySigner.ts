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
}
