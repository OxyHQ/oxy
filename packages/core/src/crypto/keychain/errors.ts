/**
 * The keychain's errors. Each carries a stable `code` a caller can branch on;
 * no message ever includes key material, plaintext or a member's name.
 */

/** Input that is not in the keychain's format (ADR 0063 D8). */
export class KeychainFormatError extends Error {
  readonly code = 'KEYCHAIN_FORMAT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'KeychainFormatError';
  }
}

/** A ciphertext, signature or commitment that does not verify. */
export class KeychainCryptoError extends Error {
  readonly code = 'KEYCHAIN_CRYPTO' as const;
  constructor(message: string) {
    super(message);
    this.name = 'KeychainCryptoError';
  }
}

/** Why a roster was refused. */
export type KeychainRosterErrorReason =
  | 'format'
  | 'genesis'
  | 'genesis_mismatch'
  | 'not_extension'
  | 'continuity'
  | 'vault_mismatch'
  | 'signature'
  | 'signer'
  | 'membership'
  | 'generation'
  | 'incomplete';

/**
 * A roster that does not verify (ADR 0063 D3). `not_extension` and
 * `genesis_mismatch` are the ones a device shows as a warning: the server
 * answered with a history other than the one this device already verified.
 */
export class KeychainRosterError extends Error {
  readonly code = 'KEYCHAIN_ROSTER' as const;
  readonly reason: KeychainRosterErrorReason;
  /** The `seq` of the entry that failed, when one did. */
  readonly seq: number | null;
  constructor(reason: KeychainRosterErrorReason, message: string, seq: number | null = null) {
    super(seq === null ? message : `roster entry ${seq}: ${message}`);
    this.name = 'KeychainRosterError';
    this.reason = reason;
    this.seq = seq;
  }
}
