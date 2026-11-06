/**
 * Whether a key was ever an organization's (ADR 0061 D2) or a person's retired
 * root. Its own module, with no service imports, so every key writer — personal
 * sign-up, linking, rotation and the organization-key service — can ask it
 * without an import cycle.
 *
 * Both answers mean the same thing: Peable derived someone's FairCoin receive
 * addresses from that key, so it never becomes another account's (or comes back
 * as the same one's) and hands over that address tree.
 */

import { eq } from 'drizzle-orm';
import { isValidSecp256k1PublicKey, normalizeSecp256k1PublicKey } from '@oxy.so/protocol/secp256k1';
import type { DatabaseOrTransaction } from '../config/postgres';
import { organizationIdentityKeys } from '../db/schema/organizationIdentityKeys';
import { personalIdentityKeyRetirements } from '../db/schema/personalIdentityKeyRetirements';

/**
 * The stored spelling of a key: uncompressed lowercase hex, as both history
 * tables hold it (each CHECKs `^04[0-9a-f]{128}$`). A compressed encoding of a
 * retired point is the same key, so it is compared in that form; a string that
 * is not a key at all is only trimmed and lower-cased, and matches nothing.
 */
function storedForm(publicKey: string): string {
  const trimmed = publicKey.trim();
  return isValidSecp256k1PublicKey(trimmed)
    ? normalizeSecp256k1PublicKey(trimmed)
    : trimmed.toLowerCase();
}

/** True when `publicKey` (any case or encoding) is or was an organization's key. */
export async function organizationKeyEverUsed(
  db: DatabaseOrTransaction,
  publicKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationIdentityKeys.id })
    .from(organizationIdentityKeys)
    .where(eq(organizationIdentityKeys.publicKey, storedForm(publicKey)))
    .limit(1);
  return Boolean(row);
}

/**
 * True when `publicKey` (any case or encoding) is a personal root that a
 * rotation replaced (`personal_identity_key_retirements`).
 */
export async function personalKeyEverRetired(
  db: DatabaseOrTransaction,
  publicKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: personalIdentityKeyRetirements.id })
    .from(personalIdentityKeyRetirements)
    .where(eq(personalIdentityKeyRetirements.publicKey, storedForm(publicKey)))
    .limit(1);
  return Boolean(row);
}

/**
 * True when `publicKey` can never be a personal root: an organization's key,
 * current or retired, or a person's retired root. Every personal key writer
 * answers this exactly as it answers "already linked to another account", so a
 * caller learns nothing more about whose key it was.
 */
export async function identityKeyEverUsed(
  db: DatabaseOrTransaction,
  publicKey: string,
): Promise<boolean> {
  return (
    (await organizationKeyEverUsed(db, publicKey)) || (await personalKeyEverRetired(db, publicKey))
  );
}
