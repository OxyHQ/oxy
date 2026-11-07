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

/** Why a `KeychainClient` refused what Oxy answered (ADR 0063 D3, D4, D7). */
export type KeychainIntegrityReason =
  /** The roster does not verify (a bad signature, signer, chain or schema). */
  | 'roster'
  /** The roster is not an extension of the head this device verified: a fork or a rewrite. */
  | 'fork'
  /** The roster is shorter than the head this device verified, or the item revision went back. */
  | 'rollback'
  /** The roster's genesis is not the one this device pinned. */
  | 'genesis_mismatch'
  /** Oxy's summary of the vault does not match the verified roster. */
  | 'summary'
  /** A wrap that does not verify, open, or keep the generations this device holds. */
  | 'wrap'
  /** An item that does not decrypt, or is not in the keychain's format. */
  | 'item'
  /** An item whose counter is lower than one this device already saw, or a deleted one back. */
  | 'counter'
  /** Oxy left out a change it announced, or an item this device knows (full sync). */
  | 'incomplete'
  /** An enrollment that is not the one this device made or opened. */
  | 'enrollment'
  /** An answer to a write that does not reflect the write. */
  | 'answer';

/**
 * Oxy answered something this device cannot verify (ADR 0063: Oxy is not
 * trusted with the membership or the items). The operation that met it wrote
 * nothing, locally or to Oxy. `fork`, `rollback` and `genesis_mismatch` are
 * shown to the person as a warning; the device does not write to the vault
 * until it is resolved.
 */
export class KeychainIntegrityError extends Error {
  readonly code = 'KEYCHAIN_INTEGRITY' as const;
  readonly reason: KeychainIntegrityReason;
  /** The cryptography's own refusal, when there was one. */
  readonly detail?: unknown;
  constructor(reason: KeychainIntegrityReason, message: string, detail?: unknown) {
    super(message);
    this.name = 'KeychainIntegrityError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** Why a `KeychainClient` operation cannot run in this device's state. */
export type KeychainStateReason =
  /** The account has no vault. */
  | 'no_vault'
  /** The account already has a vault. */
  | 'vault_exists'
  /** This device is not a member of the vault. */
  | 'not_member'
  /** This device is already a member. */
  | 'already_member'
  /** The roster no longer has this device: another device removed it. */
  | 'removed'
  /** Oxy no longer serves this device's member (the account left the device). */
  | 'orphaned'
  /** The vault this device was a member of is gone (reset), or another replaced it. */
  | 'vault_gone'
  /** No request to join, vault creation or recovery-key replacement is in progress. */
  | 'nothing_pending'
  /** The typed recovery key is not the one shown, or not the vault's. */
  | 'recovery_key_mismatch'
  /** An approval without the person's confirmation that both codes match. */
  | 'code_not_confirmed'
  /** The request to join was refused, withdrawn or expired. */
  | 'join_refused'
  /** That request to join was not opened on this device, or its code is not shown yet. */
  | 'join_request_not_open'
  /** A device removes another member, never itself; it leaves by signing out. */
  | 'cannot_remove_self'
  /** No such member, or no such item. */
  | 'not_found';

/** The operation does not apply to this device's keychain state; nothing was written. */
export class KeychainStateError extends Error {
  readonly code = 'KEYCHAIN_STATE' as const;
  readonly reason: KeychainStateReason;
  constructor(reason: KeychainStateReason, message: string) {
    super(message);
    this.name = 'KeychainStateError';
    this.reason = reason;
  }
}

/** A write kept meeting newer writes from other devices; nothing of it was lost locally. */
export class KeychainConflictError extends Error {
  readonly code = 'KEYCHAIN_CONFLICT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'KeychainConflictError';
  }
}
