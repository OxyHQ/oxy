/** Durable owned-byte claims survive crashes and account deletion until cleanup. */
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
export const storageByteReservations = pgTable('storage_byte_reservations', {
  id: generatedId(),
  accountId: text().notNull(), // intentionally no FK: account deletion must not lose cleanup
  sha256: text().notNull(),
  objectKey: text().notNull(),
  size: bigint({ mode: 'number' }).notNull(),
  kind: text({ enum: ['server', 'presigned'] }).notNull(),
  recoverAfter: timestamptz().notNull(),
  cleanedAt: timestamptz(),
  createdAt: createdAt(),
}, t => [unique('storage_byte_reservation_account_key_unique').on(t.accountId, t.objectKey),
  index('storage_byte_reservation_recovery_idx').on(t.recoverAfter),
  check('storage_byte_reservation_size_check', sql`${t.size} >= 0`),
  check('storage_byte_reservation_kind_check', sql`${t.kind} in ('server', 'presigned')`)]);
