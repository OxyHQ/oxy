/**
 * `email_filter_actions` — one thing a mail rule does when it matches.
 *
 * Ported from the `actions` array in `models/EmailFilter.ts`.
 *
 * Ordered like the conditions, and for the same reason: the user arranged them.
 * "At least one action" is enforced by `incompleteEmailFilters()` in
 * `emailFilters.ts`.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId } from '@oxyhq/db';
import { emailFilters } from './emailFilters';

/** What the rule does. */
export const EMAIL_FILTER_ACTION_TYPES = [
  'move',
  'label',
  'star',
  'mark-read',
  'archive',
  'delete',
  'forward',
] as const;

export const emailFilterActions = pgTable(
  'email_filter_actions',
  {
    id: generatedId(),
    filterId: text()
      .notNull()
      .references(() => emailFilters.id, { onDelete: 'cascade' }),
    /** Position within the rule, 0-based. */
    ord: integer().notNull(),
    type: text({ enum: EMAIL_FILTER_ACTION_TYPES }).notNull(),
    /**
     * The action's operand, absent for the ones that take none (`star`,
     * `mark-read`, `archive`, `delete`).
     *
     * Its MEANING depends on `type`: a `mailboxes.id` for `move`, a label name
     * for `label`, an email address for `forward`. That is three different
     * relations in one column — the shape Mongo left behind — so it carries no
     * foreign key and the executor resolves it per type. Splitting it into
     * three nullable columns would encode the same union with three CHECKs and
     * no more integrity, since two of the three are not row ids at all.
     */
    value: text(),
  },
  (t) => [
    unique('email_filter_actions_filter_id_ord_key').on(t.filterId, t.ord),
    check(
      'email_filter_actions_type_check',
      sql`${t.type} in (${sql.raw(
        EMAIL_FILTER_ACTION_TYPES.map((value) => `'${value}'`).join(', ')
      )})`
    ),
    check('email_filter_actions_ord_check', sql`${t.ord} >= 0`),
  ]
);
