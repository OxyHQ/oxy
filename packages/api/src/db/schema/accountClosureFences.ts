/**
 * Durable account-closure fence for BYOK custody.
 *
 * A self-delete performs external, non-transactional cleanup before it can
 * remove/archive the account row. Archiving first would make a transient cleanup
 * failure lock the person out of retrying; holding a PostgreSQL transaction open
 * across S3/mail/session work would be worse. This one-row fence is the durable
 * middle state: provider-connection creation and service-principal reads refuse
 * it, while the person's account remains active long enough to retry cleanup.
 * Hard delete cascades it; retained accounts keep it permanently when archived.
 */

import { pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt } from '@oxyhq/db';
import { users } from './users';

export const accountClosureFences = pgTable('account_closure_fences', {
  accountId: text()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
});

export type AccountClosureFenceRow = typeof accountClosureFences.$inferSelect;
