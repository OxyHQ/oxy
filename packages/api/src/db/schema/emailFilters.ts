/**
 * `email_filters` — one user-defined mail rule.
 *
 * Ported from `models/EmailFilter.ts`.
 *
 * The two embedded arrays become `email_filter_conditions` and
 * `email_filter_actions`: ordered rule lists, each with an `ord` column,
 * because a filter is evaluated in the order the user arranged it.
 *
 * ## "At least one condition, at least one action"
 *
 * Mongoose declared both as `validate: [(v) => v.length > 0]`. Postgres cannot
 * express "this row must have a child" in a CHECK — a CHECK sees one row of one
 * table — and the only declarative alternative is a `DEFERRABLE` CONSTRAINT
 * TRIGGER, which is hand-written DDL `drizzle-kit generate` cannot emit from a
 * schema file. That is the same objection `CONVENTIONS.md` already recorded
 * against an IMMUTABLE SQL wrapper function, and it lands the same way.
 *
 * So the invariant lives where it can be enforced, and this schema owns the
 * check rather than leaving it to a comment: {@link incompleteEmailFilters} is
 * the predicate, and it has two jobs.
 *
 *   1. The WRITE path asserts it after inserting a filter and its children —
 *      one transaction, so a violation rolls the whole rule back.
 *   2. The BACKFILL runs it as a gate. A Mongo document that predates the
 *      validator, or was written around it, surfaces here instead of becoming a
 *      rule that silently matches everything or does nothing.
 *
 * `__tests__/emailFilters.test.ts` mutation-tests it: a filter with no actions
 * is representable in SQL, and the predicate names it.
 */

import { sql, type SQL } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const emailFilters = pgTable(
  'email_filters',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    enabled: boolean().notNull().default(true),
    /** True = every condition must match (AND); false = any (OR). */
    matchAll: boolean().notNull().default(true),
    /** Evaluation order among the user's filters. */
    order: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // "This user's enabled filters, in order" — the only read there is.
    // Mongo's standalone `{userId}` is dropped: this leads with `user_id`.
    index('email_filters_user_id_enabled_order_idx').on(t.userId, t.enabled, t.order),
  ]
);

/**
 * Every filter that has no conditions or no actions — i.e. every filter
 * Mongoose's two `length > 0` validators existed to prevent.
 *
 * ```ts
 * const broken = await db.select({ id: emailFilters.id })
 *   .from(emailFilters)
 *   .where(incompleteEmailFilters());
 * ```
 *
 * Returned as a predicate rather than a finished query so the caller decides
 * the scope: the write path adds `and id = $1`, the backfill gate does not.
 *
 * The OUTER PARENTHESES are load-bearing, not formatting. This is an `or`, and
 * drizzle's `and(...)` does not parenthesize its operands — so an unparenthesized
 * body composed as `and(eq(userId, $1), incompleteEmailFilters())` renders
 * `(user_id = $1 and not exists …) or not exists …`, which drops the scope and
 * returns every broken filter in the table. `__tests__/mailSettings.test.ts`
 * asserts the scoped form returns one user's row and only that row.
 *
 * The table names are spelled in SQL because importing the two child modules
 * here would close an import cycle — each of them references this table.
 */
export function incompleteEmailFilters(): SQL {
  return sql`(
    not exists (
      select 1 from email_filter_conditions c where c.filter_id = ${emailFilters.id}
    )
    or not exists (
      select 1 from email_filter_actions a where a.filter_id = ${emailFilters.id}
    )
  )`;
}
