/**
 * Recovery Phrase Service - BIP39 Mnemonic Generation
 * 
 * Handles generation and restoration of recovery phrases (mnemonic seeds)
 * for backing up and restoring user identities.
 * 
 * Note: This module requires the polyfill to be loaded first (done via crypto/index.ts)
 *
 * Oxy recovery phrases are English-only, so the English wordlist is imported by
 * its own subpath. Never reach for a package that exposes its wordlists through
 * a barrel: `bip39`'s `_wordlists` hard-requires all ten languages, which put
 * ~265 KB of unreachable wordlists into the initial chunk of every consuming
 * app. Adding another language means one more subpath import, ideally lazy.
 */

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { KeyManager } from './keyManager';
import { hkdfSha256 } from './kdf';

/**
 * Convert Uint8Array or array-like to hexadecimal string
 * Works in both Node.js and React Native without depending on Buffer
 */
function toHex(data: Uint8Array | ArrayLike<number>): string {
  // Convert to array of numbers if needed
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** UTF-8 encode an ASCII label to bytes (for HKDF salt/info). */
function utf8(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

/**
 * HKDF context tag for the encrypted-backup key schedule (b3 Feature 1). Used as
 * the HKDF `salt`; distinct from any other Oxy key-derivation salt so the backup
 * key schedule is independent. Versioned so a future scheme change is a new tag.
 */
export const BACKUP_KDF_SALT = 'oxy-identity-backup-v1';
/** HKDF `info` label that derives the symmetric AEAD key from the seed. */
export const BACKUP_KDF_ENCRYPTION_INFO = 'oxy-backup-encryption-key';
/** HKDF `info` label that derives the (server-hashed) backup locator from the seed. */
export const BACKUP_KDF_LOOKUP_INFO = 'oxy-backup-lookup-id';
/** Byte length of both the derived backup key and the derived lookup id (256-bit). */
export const BACKUP_MATERIAL_LENGTH = 32;

/**
 * The two pieces of key material derived from a recovery phrase for the
 * encrypted off-device backup, kept strictly separate by HKDF domain separation.
 */
export interface BackupMaterial {
  /**
   * The 32-byte symmetric key handed to `encryptAead`/`decryptAead`. NEVER
   * leaves the device — the server sees only ciphertext produced with it.
   */
  backupKey: Uint8Array;
  /**
   * The 256-bit backup locator, hex. Sent to the server, which stores ONLY
   * `sha256(lookupId)` — so possession of this value (which itself requires the
   * full seed to compute) is what locates a backup, and the server can never
   * recompute it from what it stores.
   */
  lookupId: string;
}

export interface RecoveryPhraseResult {
  phrase: string;
  words: string[];
  publicKey: string;
}

/**
 * A freshly-derived identity that has NOT been persisted to secure storage.
 *
 * Unlike {@link RecoveryPhraseResult} this also exposes the `privateKey`, because
 * the caller must be able to sign with (or later persist) the material itself —
 * the whole point of a "pending" identity is that nothing is committed until an
 * external step (e.g. a server-confirmed key rotation) succeeds.
 */
export interface PendingIdentityResult {
  phrase: string;
  words: string[];
  privateKey: string;
  publicKey: string;
}

export interface GenerateIdentityOptions {
  /**
   * Pass `true` to allow overwriting an existing on-device identity.
   *
   * Defaults to `false`. When false, this method throws
   * `IdentityAlreadyExistsError` if a complete identity already exists,
   * preventing accidental account loss. UI flows MUST only set this to
   * `true` after explicitly confirming the user has saved their previous
   * recovery phrase (or has otherwise been warned).
   */
  overwrite?: boolean;
}

export class RecoveryPhraseService {
  /**
   * Generate a new identity with a recovery phrase.
   * The mnemonic phrase MUST be shown to the user exactly once after this
   * call resolves — if it is lost, the account becomes unrecoverable.
   *
   * Refuses to overwrite an existing identity unless `options.overwrite === true`.
   *
   * @throws IdentityAlreadyExistsError if an identity already exists and overwrite is not set
   */
  static async generateIdentityWithRecovery(
    options?: GenerateIdentityOptions,
  ): Promise<RecoveryPhraseResult> {
    // Generate 128-bit entropy for 12-word mnemonic
    const mnemonic = generateMnemonic(wordlist, 128);

    // Derive private key from mnemonic
    // Using the seed directly as the private key (simplified approach)
    const seed = await mnemonicToSeed(mnemonic);

    // Use first 32 bytes of seed as private key
    const privateKeyHex = toHex(seed.subarray(0, 32));

    // Import the derived key pair. KeyManager.importKeyPair will refuse to
    // clobber an existing identity unless overwrite is explicitly requested.
    const publicKey = await KeyManager.importKeyPair(privateKeyHex, {
      overwrite: options?.overwrite === true,
    });

    return {
      phrase: mnemonic,
      words: mnemonic.split(' '),
      publicKey,
    };
  }

  /**
   * Generate a 24-word recovery phrase for higher security.
   *
   * Same overwrite-protection semantics as `generateIdentityWithRecovery`.
   */
  static async generateIdentityWithRecovery24(
    options?: GenerateIdentityOptions,
  ): Promise<RecoveryPhraseResult> {
    // Generate 256-bit entropy for 24-word mnemonic
    const mnemonic = generateMnemonic(wordlist, 256);

    const seed = await mnemonicToSeed(mnemonic);
    const privateKeyHex = toHex(seed.subarray(0, 32));
    const publicKey = await KeyManager.importKeyPair(privateKeyHex, {
      overwrite: options?.overwrite === true,
    });

    return {
      phrase: mnemonic,
      words: mnemonic.split(' '),
      publicKey,
    };
  }

  /**
   * Derive a brand-new identity + recovery phrase WITHOUT persisting anything.
   *
   * Pure: same derivation as {@link generateIdentityWithRecovery} (128-bit
   * mnemonic → seed → first 32 bytes as the secp256k1 private key) but it stops
   * BEFORE `KeyManager.importKeyPair`, so no on-device identity is touched. The
   * caller decides if/when to commit the material (e.g. only after a server
   * confirms a key rotation). Works on web too — it never reads or writes secure
   * storage.
   *
   * The 12-word `phrase` MUST be shown to the user before the identity is
   * committed anywhere — if it is lost the account becomes unrecoverable.
   */
  static async derivePendingIdentity(): Promise<PendingIdentityResult> {
    const mnemonic = generateMnemonic(wordlist, 128);
    const seed = await mnemonicToSeed(mnemonic);
    const privateKey = toHex(seed.subarray(0, 32));
    const publicKey = KeyManager.derivePublicKey(privateKey);

    return {
      phrase: mnemonic,
      words: mnemonic.split(' '),
      privateKey,
      publicKey,
    };
  }

  /**
   * Derive the private key from a recovery phrase WITHOUT storing it.
   *
   * The private-key counterpart of {@link derivePublicKeyFromPhrase}. Used to
   * re-derive a key in memory (e.g. to sign a rotation proof with the current
   * key when the device has no SecureStore copy). Never persists — the returned
   * material lives only in the caller's memory.
   */
  static async derivePrivateKeyFromPhrase(phrase: string): Promise<string> {
    const normalizedPhrase = phrase.trim().toLowerCase();

    if (!validateMnemonic(normalizedPhrase, wordlist)) {
      throw new Error('Invalid recovery phrase');
    }

    const seed = await mnemonicToSeed(normalizedPhrase);
    return toHex(seed.subarray(0, 32));
  }

  /**
   * Derive the encrypted-backup key material from a recovery phrase (b3 Feature
   * 1). PURE and additive — it does NOT touch the frozen phrase→privateKey
   * derivation ({@link derivePrivateKeyFromPhrase} slices the first 32 seed
   * bytes) and never reads or writes secure storage.
   *
   * Both outputs are derived from the FULL 64-byte BIP-39 seed via HKDF-SHA256
   * with domain-separated `info` labels, so the domain separation is real: a
   * device compromise that leaks only the raw 32-byte private key can compute
   * NEITHER the backup key nor the lookup id (both need the whole seed). Locating
   * AND decrypting a backup therefore requires the recovery phrase.
   *
   * @param phrase - The BIP-39 recovery phrase (validated + normalized here).
   * @returns `{ backupKey, lookupId }` — the AEAD key (kept local) and the hex
   *   locator (uploaded; server stores only its hash).
   * @throws if the phrase is not a valid BIP-39 mnemonic.
   */
  static async deriveBackupMaterial(phrase: string): Promise<BackupMaterial> {
    const normalizedPhrase = phrase.trim().toLowerCase();

    if (!validateMnemonic(normalizedPhrase, wordlist)) {
      throw new Error('Invalid recovery phrase. Please check the words and try again.');
    }

    const seed = await mnemonicToSeed(normalizedPhrase);
    const salt = utf8(BACKUP_KDF_SALT);
    const backupKey = hkdfSha256(seed, salt, utf8(BACKUP_KDF_ENCRYPTION_INFO), BACKUP_MATERIAL_LENGTH);
    const lookupId = toHex(hkdfSha256(seed, salt, utf8(BACKUP_KDF_LOOKUP_INFO), BACKUP_MATERIAL_LENGTH));

    return { backupKey, lookupId };
  }

  /**
   * Restore an identity from a recovery phrase.
   *
   * Refuses to overwrite a DIFFERENT existing identity unless
   * `options.overwrite === true`. Re-importing the same phrase that
   * matches the current identity is always allowed (it's a no-op refresh
   * of the backup record).
   */
  static async restoreFromPhrase(
    phrase: string,
    options?: GenerateIdentityOptions,
  ): Promise<string> {
    // Normalize and validate the phrase
    const normalizedPhrase = phrase.trim().toLowerCase();

    if (!validateMnemonic(normalizedPhrase, wordlist)) {
      throw new Error('Invalid recovery phrase. Please check the words and try again.');
    }

    // Derive the same private key from the mnemonic
    const seed = await mnemonicToSeed(normalizedPhrase);
    const privateKeyHex = toHex(seed.subarray(0, 32));

    // Import and store the key pair
    const publicKey = await KeyManager.importKeyPair(privateKeyHex, {
      overwrite: options?.overwrite === true,
    });

    return publicKey;
  }

  /**
   * Validate a recovery phrase without importing it
   */
  static validatePhrase(phrase: string): boolean {
    const normalizedPhrase = phrase.trim().toLowerCase();
    return validateMnemonic(normalizedPhrase, wordlist);
  }

  /**
   * Get the word list for autocomplete/validation
   */
  static getWordList(): string[] {
    return wordlist;
  }

  /**
   * Check if a word is valid in the BIP39 word list
   */
  static isValidWord(word: string): boolean {
    return wordlist.includes(word.toLowerCase());
  }

  /**
   * Get suggestions for a partial word
   */
  static getSuggestions(partial: string, limit = 5): string[] {
    const lowerPartial = partial.toLowerCase();
    return wordlist.filter((word: string) => word.startsWith(lowerPartial)).slice(0, limit);
  }

  /**
   * Derive the public key from a phrase without storing
   * Useful for verification before importing
   */
  static async derivePublicKeyFromPhrase(phrase: string): Promise<string> {
    const normalizedPhrase = phrase.trim().toLowerCase();
    
    if (!validateMnemonic(normalizedPhrase, wordlist)) {
      throw new Error('Invalid recovery phrase');
    }

    const seed = await mnemonicToSeed(normalizedPhrase);
    const privateKeyHex = toHex(seed.subarray(0, 32));

    return KeyManager.derivePublicKey(privateKeyHex);
  }

  /**
   * Convert a phrase to its word array
   */
  static phraseToWords(phrase: string): string[] {
    return phrase.trim().toLowerCase().split(/\s+/);
  }

  /**
   * Convert a word array to a phrase string
   */
  static wordsToPhrase(words: string[]): string {
    return words.map(w => w.toLowerCase().trim()).join(' ');
  }
}

export default RecoveryPhraseService;


