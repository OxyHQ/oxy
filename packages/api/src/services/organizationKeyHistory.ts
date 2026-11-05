/**
 * Whether a key was ever an organization's (ADR 0061 D2). Its own module, with
 * no service imports, so every key writer — personal sign-up, linking, rotation
 * and the organization-key service — can ask it without an import cycle.
 */

import { eq } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../config/postgres';
import { organizationIdentityKeys } from '../db/schema/organizationIdentityKeys';

/**
 * True when `publicKey` (any case) is or was an organization's key. Such a key
 * never becomes another account's: Peable derives the organization's receive
 * addresses from it, so reusing it would hand over that address tree.
 */
export async function organizationKeyEverUsed(
  db: DatabaseOrTransaction,
  publicKey: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: organizationIdentityKeys.id })
    .from(organizationIdentityKeys)
    .where(eq(organizationIdentityKeys.publicKey, publicKey.trim().toLowerCase()))
    .limit(1);
  return Boolean(row);
}
