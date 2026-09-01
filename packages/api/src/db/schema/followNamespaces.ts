/**
 * `follow_namespaces` — who owns which prefix.
 *
 * `follow_target_kinds` already enforces that `mercaria.store` lives in the
 * namespace `mercaria`. What it does NOT enforce, on its own, is that only
 * Mercaria may say so: any application holding `follow-targets:register` could
 * register `syra.artist` and, from then on, define what a Syra artist is.
 *
 * With a handful of first-party applications that gap reads as theoretical.
 * With a thousand it is the whole tenancy model, and it fails silently — the
 * squatting application's registration simply wins, and the rightful owner's
 * first attempt fails with a uniqueness error naming a row it does not
 * recognise.
 *
 * So a namespace is a CLAIM, held by exactly one application, and a kind's
 * namespace is a foreign key into it rather than a string somebody typed.
 *
 * ## Why claims are irrevocable
 *
 * `application_id` is `SET NULL` on delete rather than `CASCADE`, and the row
 * stays. Every target and every relationship in the graph names its kind, and
 * that kind names this namespace; releasing the name would let a different
 * application later adopt an identity that thousands of existing rows already
 * point at. A deleted application's namespace becomes unowned and unclaimable,
 * which is the only honest end state.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId } from '@oxyhq/db';

export const followNamespaces = pgTable(
  'follow_namespaces',
  {
    id: generatedId(),
    /**
     * The prefix itself — `oxy`, `mercaria`, `syra`. UNIQUE, because ownership
     * is the entire purpose of the row.
     */
    namespace: text().notNull(),
    /**
     * The owning application. NULL means the platform's own (`oxy`), or an
     * application that has since been deleted.
     */
    applicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('follow_namespaces_namespace_key').on(t.namespace),
    index('follow_namespaces_application_idx').on(t.applicationId),
    // Same shape rule the kinds table applies, restated here because this is
    // now the table that CREATES a namespace: a single lowercase segment, so
    // `a.b` cannot claim to be its own namespace and then register `a.b.c`.
    check('follow_namespaces_shape_check', sql`${t.namespace} ~ '^[a-z][a-z0-9_]*$'`),
  ]
);
