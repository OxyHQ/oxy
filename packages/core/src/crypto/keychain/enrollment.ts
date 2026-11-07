/**
 * Adding a device (ADR 0063 D5): the commitment the new device posts first and
 * the six-digit code both screens show.
 *
 *   commitment = SHA-256("oxy.keychain.enroll.commit.v1\n" ‖ JCS({ vaultId, member }) ‖ 0x00 ‖ deviceNonce)
 *   h          = SHA-256("oxy.keychain.enroll.code.v1\n" ‖ JCS({ vaultId, member }) ‖ 0x00 ‖ approverNonce ‖ deviceNonce)
 *   code       = (first four bytes of h, big-endian unsigned) mod 10⁶, zero-padded to six digits
 *
 * Both nonces are 32 random bytes; the commitment travels base64url.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import {
  COMMITMENT_LENGTH,
  ENROLL_CODE_DOMAIN,
  ENROLL_COMMIT_DOMAIN,
  ENROLL_NONCE_LENGTH,
} from './constants';
import {
  assertUuid,
  bytesEqual,
  concatBytes,
  fromBase64Url,
  jcsBytes,
  randomBytes,
  toBase64Url,
  utf8,
} from './encoding';
import { KeychainFormatError } from './errors';
import { type KeychainMember, parseMember } from './roster';

/** A fresh 32-byte enrollment nonce (the device's or the approver's). */
export function generateEnrollmentNonce(): Uint8Array {
  return randomBytes(ENROLL_NONCE_LENGTH);
}

function assertNonce(nonce: Uint8Array, what: string): void {
  if (nonce.length !== ENROLL_NONCE_LENGTH)
    throw new KeychainFormatError(`${what} must be 32 bytes`);
}

function memberStatement(vaultId: string, member: KeychainMember): Uint8Array {
  assertUuid(vaultId, 'vaultId');
  return jcsBytes({ vaultId, member: parseMember(member) });
}

/** The bytes the commitment hashes. */
export function enrollmentCommitInput(
  vaultId: string,
  member: KeychainMember,
  deviceNonce: Uint8Array,
): Uint8Array {
  assertNonce(deviceNonce, 'deviceNonce');
  return concatBytes(
    utf8(`${ENROLL_COMMIT_DOMAIN}\n`),
    memberStatement(vaultId, member),
    new Uint8Array([0]),
    deviceNonce,
  );
}

/** The new device's commitment to its member and nonce, base64url. */
export function enrollmentCommitment(
  vaultId: string,
  member: KeychainMember,
  deviceNonce: Uint8Array,
): string {
  return toBase64Url(sha256(enrollmentCommitInput(vaultId, member, deviceNonce)));
}

/** Whether a revealed `deviceNonce` opens the commitment the new device posted. */
export function verifyEnrollmentCommitment(
  vaultId: string,
  member: KeychainMember,
  deviceNonce: Uint8Array,
  commitment: string,
): boolean {
  const expected = fromBase64Url(commitment, COMMITMENT_LENGTH, 'commitment');
  return bytesEqual(sha256(enrollmentCommitInput(vaultId, member, deviceNonce)), expected);
}

/** The bytes the comparison code hashes. */
export function enrollmentCodeInput(
  vaultId: string,
  member: KeychainMember,
  approverNonce: Uint8Array,
  deviceNonce: Uint8Array,
): Uint8Array {
  assertNonce(approverNonce, 'approverNonce');
  assertNonce(deviceNonce, 'deviceNonce');
  return concatBytes(
    utf8(`${ENROLL_CODE_DOMAIN}\n`),
    memberStatement(vaultId, member),
    new Uint8Array([0]),
    approverNonce,
    deviceNonce,
  );
}

/** The six-digit code both screens show. */
export function enrollmentComparisonCode(
  vaultId: string,
  member: KeychainMember,
  approverNonce: Uint8Array,
  deviceNonce: Uint8Array,
): string {
  const h = sha256(enrollmentCodeInput(vaultId, member, approverNonce, deviceNonce));
  const value = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}
