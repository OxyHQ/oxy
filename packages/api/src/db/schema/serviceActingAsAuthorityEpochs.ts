/**
 * Durable authority generation for one user/application pair. Unlike the grant,
 * this row survives revoke/delete/regrant so an in-flight verification cannot
 * mistake a new grant for the old one (ABA). Bump in the grant/revoke transaction.
 * User/application deletion cascades because those UUID identities cease to exist.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

export const serviceActingAsAuthorityEpochs = pgTable(
  'service_acting_as_authority_epochs',
  {
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    applicationId: text().notNull().references(() => applications.id, { onDelete: 'cascade' }),
    /** Bigint stays exact; transport serializes decimal text rather than a JS number. */
    epoch: bigint({ mode: 'bigint' }).notNull().default(sql`0`),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.applicationId] }),
    check('service_acting_as_authority_epochs_nonnegative_check', sql`${t.epoch} >= 0`),
  ],
);
