import { and, count, desc, eq } from 'drizzle-orm';
import type { PostalAddress, PostalAddressInput, PostalAddressUpdate } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { users } from './schema/users';
import { postalAddresses } from './schema/postalAddresses';
import { ConflictError, NotFoundError } from '../utils/error';

/** A small, bounded address book; creation is serialized by its owner's lock. */
export const MAX_POSTAL_ADDRESSES = 100;

type Row = typeof postalAddresses.$inferSelect;
function dto(row: Row): PostalAddress {
  return {
    id: row.id,
    recipientName: row.recipientName,
    line1: row.line1,
    city: row.city,
    postalCode: row.postalCode,
    country: row.country,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.line2 === null ? {} : { line2: row.line2 }),
    ...(row.region === null ? {} : { region: row.region }),
    ...(row.phone === null ? {} : { phone: row.phone }),
    ...(row.label === null ? {} : { label: row.label }),
  };
}
export async function listPostalAddresses(userId: string): Promise<PostalAddress[]> {
  return (
    await getDb()
      .select()
      .from(postalAddresses)
      .where(eq(postalAddresses.userId, userId))
      .orderBy(desc(postalAddresses.isDefault), desc(postalAddresses.createdAt))
  ).map(dto);
}

/** Lock the owner before changing defaults: two simultaneous promotions cannot race. */
export async function savePostalAddress(
  userId: string,
  input: PostalAddressInput | PostalAddressUpdate,
  id?: string,
): Promise<PostalAddress> {
  return getDb().transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (!owner) throw new NotFoundError('Account not found');
    if (!id) {
      const [total] = await tx
        .select({ count: count() })
        .from(postalAddresses)
        .where(eq(postalAddresses.userId, userId));
      if ((total?.count ?? 0) >= MAX_POSTAL_ADDRESSES)
        throw new ConflictError('Address book limit reached');
    }
    const where = id
      ? and(eq(postalAddresses.userId, userId), eq(postalAddresses.id, id))
      : undefined;
    if (id) {
      const [existing] = await tx
        .select({ id: postalAddresses.id })
        .from(postalAddresses)
        .where(where);
      if (!existing) throw new NotFoundError('Address not found');
    }
    if (input.isDefault)
      await tx
        .update(postalAddresses)
        .set({ isDefault: false })
        .where(eq(postalAddresses.userId, userId));
    // Only contract-validated fields enter this repository. Ownership is never caller input.
    const [row] = id
      ? await tx.update(postalAddresses).set(input).where(where).returning()
      : await tx
          .insert(postalAddresses)
          .values({ ...(input as PostalAddressInput), userId })
          .returning();
    if (!row) throw new NotFoundError('Address not found');
    return dto(row);
  });
}
export async function deletePostalAddress(userId: string, id: string): Promise<void> {
  const [row] = await getDb()
    .delete(postalAddresses)
    .where(and(eq(postalAddresses.userId, userId), eq(postalAddresses.id, id)))
    .returning({ id: postalAddresses.id });
  if (!row) throw new NotFoundError('Address not found');
}
