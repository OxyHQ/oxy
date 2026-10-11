/**
 * `bundles` — a user's collapsible groupings of labelled mail.
 *
 * Ported from `models/Bundle.ts`.
 *
 * ## The uniqueness is case-INSENSITIVE
 *
 * Three sibling tables name the same kind of thing — a user-created container
 * shown in one list in mail settings — and all three are unique per user on
 * `lower(name)`: `labels`, `email_templates` and this one. Nothing in the
 * product treats a bundle name as case-sensitive, and the UI renders the three
 * lists identically, so a user cannot hold bundles `Promotions` and
 * `promotions`.
 *
 * Every lookup must be written `where user_id = $1 and lower(name) = lower($2)`.
 * A write of a second bundle differing only by case fails on this index — the
 * alternative is silently keeping a pair the product cannot tell apart.
 */

import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { users } from './users';

/** Applied when a bundle is created without one. */
export const DEFAULT_BUNDLE_ICON = 'folder-outline';
/** Applied when a bundle is created without one. */
export const DEFAULT_BUNDLE_COLOR = '#5F6368';

export const bundles = pgTable(
  'bundles',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stored exactly as the user typed it; uniqueness ignores case. */
    name: text().notNull(),
    icon: text().notNull().default(DEFAULT_BUNDLE_ICON),
    color: text().notNull().default(DEFAULT_BUNDLE_COLOR),
    /**
     * Label NAMES this bundle collects — the same string space as
     * `messages.labels`, which is what makes the match a plain array overlap.
     * NOT NULL with an empty default rather than nullable.
     */
    matchLabels: text().array().notNull().default([]),
    enabled: boolean().notNull().default(true),
    collapsed: boolean().notNull().default(true),
    /** Display order in the mail list. */
    order: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // No standalone `(user_id)` index, since this index leads with `user_id`. No
  // index backs the `order` sort: a user holds a handful of bundles and sorting
  // them is free.
  (t) => [uniqueIndex('bundles_user_id_lower_name_key').on(t.userId, sql`lower(${t.name})`)],
);
