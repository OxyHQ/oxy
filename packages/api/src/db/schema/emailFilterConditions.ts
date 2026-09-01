/**
 * `email_filter_conditions` — one test in a mail rule.
 *
 * Ported from the `conditions` array in `models/EmailFilter.ts`.
 *
 * The list is ORDERED and the order is the user's, so `ord` is a column and it
 * is unique per filter. "At least one condition" is enforced by
 * `incompleteEmailFilters()` in `emailFilters.ts` — see that module for why it
 * cannot be a constraint here.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId } from '@oxyhq/db';
import { emailFilters } from './emailFilters';

/** What the condition looks at. */
export const EMAIL_FILTER_CONDITION_FIELDS = [
  'from',
  'to',
  'subject',
  'has-attachment',
  'size',
] as const;

/** How it compares. */
export const EMAIL_FILTER_CONDITION_OPERATORS = [
  'contains',
  'equals',
  'not-contains',
  'starts-with',
  'ends-with',
  'greater-than',
  'less-than',
] as const;

export const emailFilterConditions = pgTable(
  'email_filter_conditions',
  {
    id: generatedId(),
    filterId: text()
      .notNull()
      .references(() => emailFilters.id, { onDelete: 'cascade' }),
    /** Position within the rule, 0-based. */
    ord: integer().notNull(),
    field: text({ enum: EMAIL_FILTER_CONDITION_FIELDS }).notNull(),
    operator: text({ enum: EMAIL_FILTER_CONDITION_OPERATORS }).notNull(),
    /**
     * The comparand. A free-form string whose meaning depends on `field` — a
     * substring for `subject`, a byte count for `size` — so it stays `text`.
     */
    value: text().notNull(),
  },
  (t) => [
    unique('email_filter_conditions_filter_id_ord_key').on(t.filterId, t.ord),
    check(
      'email_filter_conditions_field_check',
      sql`${t.field} in (${sql.raw(
        EMAIL_FILTER_CONDITION_FIELDS.map((value) => `'${value}'`).join(', ')
      )})`
    ),
    check(
      'email_filter_conditions_operator_check',
      sql`${t.operator} in (${sql.raw(
        EMAIL_FILTER_CONDITION_OPERATORS.map((value) => `'${value}'`).join(', ')
      )})`
    ),
    check('email_filter_conditions_ord_check', sql`${t.ord} >= 0`),
  ]
);
