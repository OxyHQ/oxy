/** User-owned saved searches. The query is kept as entered; filters are the
 * normalized structured form used to replay it without reparsing the UI. */

import { index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

export interface SavedEmailSearchFilters {
  q?: string;
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  dateAfter?: string;
  dateBefore?: string;
  mailbox?: string;
  starred?: boolean;
  unread?: boolean;
  label?: string;
}

export const emailSavedSearches = pgTable(
  'email_saved_searches',
  {
    id: generatedId(),
    userId: text().notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    query: text().notNull(),
    filters: jsonb().$type<SavedEmailSearchFilters>().notNull().default({}),
    order: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('email_saved_searches_user_name_key').on(t.userId, t.name),
    index('email_saved_searches_user_order_idx').on(t.userId, t.order, t.createdAt.desc()),
  ],
);
