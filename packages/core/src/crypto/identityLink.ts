/**
 * The code both screens show while Commons is being linked to an account
 * (ADR 0029 D3): 6 digits derived from the link request and the key Commons
 * signed with. The linking panel derives it from the key the API relayed,
 * Commons from its own; the person checks they match before the link is
 * confirmed, so a photographed QR cannot slip another key in.
 */

import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';

const DOMAIN = 'oxy-identity-link-code/v1';

export function deriveIdentityLinkCode(linkId: string, publicKey: string): string {
  const digest = sha256(utf8ToBytes(`${DOMAIN}|${linkId}|${publicKey.trim().toLowerCase()}`));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}
