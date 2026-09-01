/**
 * `app_categories` — the shelves of the app store.
 *
 * ## Why this is a table and not a `text` + CHECK
 *
 * Every other closed vocabulary in this schema is a CHECK-constrained `text`
 * (see `CONVENTIONS.md`), and this one deliberately is not: a category carries
 * DATA — a human label, a running order, and eventually a description — and it
 * is edited by whoever curates the store rather than by a migration. A CHECK
 * would put the vocabulary in the DDL and the label in the application, which
 * is the split that leaves `finance-commerce` printed on a page.
 *
 * ## Store, not platform
 *
 * Nothing outside the store reads this. An application's OAuth identity, its
 * grants and its updates do not know what shelf it sits on, and turning the
 * store off would not break them — which is the test that says this table
 * belongs to the store module rather than to the platform.
 */

import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

export const appCategories = pgTable(
  'app_categories',
  {
    id: generatedId(),
    /**
     * The URL segment — `productivity`, `developer-tools`. Unique, and the only
     * identifier a link or a client should carry: the row id is internal.
     */
    slug: text().notNull().unique(),
    /** What a person reads. Never derived from the slug at render time. */
    label: text().notNull(),
    /** One sentence under the heading on a category page. Absent is NULL, never `''`: an empty string is a VALUE, and the schema gate rejects the default outright — see `CONVENTIONS.md`. */
    description: text(),
    /**
     * Running order on the storefront. Not unique — two shelves may tie, and
     * the reader breaks it by `id`, which is stable. A unique constraint here
     * would make reordering a two-step dance around a collision.
     */
    order: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('app_categories_order_idx').on(t.order)]
);
