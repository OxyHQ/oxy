/**
 * The keychain's domain strings and sizes (ADR 0063 D8). Every AAD and every
 * signing input starts with one of these, so no ciphertext or signature of one
 * kind can be replayed as another.
 */

export const SEAL_INFO = 'oxy.keychain.seal.v1';
export const WRAP_DOMAIN = 'oxy.keychain.wrap.v1';
export const ITEM_DOMAIN = 'oxy.keychain.item.v1';
export const ROSTER_DOMAIN = 'oxy.keychain.roster.v1';
export const ENROLL_COMMIT_DOMAIN = 'oxy.keychain.enroll.commit.v1';
export const ENROLL_CODE_DOMAIN = 'oxy.keychain.enroll.code.v1';
export const RECOVERY_SALT = 'oxy.keychain.recovery.v1';
export const RECOVERY_SIGNING_INFO = 'ed25519';
export const RECOVERY_BOX_INFO = 'x25519';

/** The signer and recipient name of the recovery key. */
export const RECOVERY = 'recovery' as const;

export const KEY_LENGTH = 32;
export const NONCE_LENGTH = 24;
export const SIGNATURE_LENGTH = 64;
export const VAULT_KEY_LENGTH = 32;
export const RECOVERY_KEY_LENGTH = 20;
export const ENROLL_NONCE_LENGTH = 32;
export const COMMITMENT_LENGTH = 32;

/** Item plaintexts are padded with spaces to a multiple of this. */
export const ITEM_PADDING_BLOCK = 256;
/**
 * The largest padded item plaintext: its ciphertext (plus the 16-byte tag)
 * stays within the server's 64 KiB of base64url (docs/identity/keychain.md).
 */
export const MAX_ITEM_PLAINTEXT = 48_896;
