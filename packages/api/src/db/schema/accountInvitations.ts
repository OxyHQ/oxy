import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { users } from './users';

/** Delivery addresses are not identities; a bearer may choose any personal account. */
export const accountInvitations = pgTable(
  'account_invitations',
  {
    id: generatedId(),
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    invitedByUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text({ enum: ['admin', 'editor', 'developer', 'billing', 'viewer'] }).notNull(),
    inherit: boolean().notNull().default(true),
    tokenHash: text().notNull(),
    expiresAt: timestamptz().notNull(),
    cancelledAt: timestamptz(),
    acceptedAt: timestamptz(),
    acceptedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('account_invitations_account_id_idx').on(t.accountId),
    index('account_invitations_expires_at_idx').on(t.expiresAt),
    unique('account_invitations_token_hash_key').on(t.tokenHash),
    check(
      'account_invitations_role_check',
      sql`${t.role} in ('admin', 'editor', 'developer', 'billing', 'viewer')`,
    ),
  ],
);
