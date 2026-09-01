/**
 * `app_grants` — a user's standing OAuth consent for an application.
 *
 * Ported from `models/AppGrant.ts`. The row is upserted on every
 * `POST /auth/oauth/authorize`, unioning scopes and refreshing `last_used_at`,
 * so a returning user skips the consent screen while the granted set still
 * covers what the app asks for.
 *
 * Keyed on `application_id` rather than the OAuth `client_id` because
 * `client_id` is `application_credentials.public_key`, which ROTATES — keying on
 * the credential would silently drop a user's consent every rotation. Ordinary
 * scopes may still be auto-approved for a trusted application, but privileged,
 * consent-required scopes such as `acting-as:offline` always record a grant.
 * This table is exactly the revocable set the "Connected apps" UI lists.
 *
 * `scopes` carries no CHECK: an OAuth request may name a scope this platform
 * does not grant, and the grant records what the USER consented to. Constraining
 * it to `APPLICATION_SCOPES` — as `applications.scopes` is — would make the
 * historical record un-writable the moment a scope is retired from the
 * vocabulary.
 */

import { sql } from 'drizzle-orm';
import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const appGrants = pgTable(
  'app_grants',
  {
    id: generatedId(),
    /** `CASCADE` — a deleted user's consents are meaningless and must not survive. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `CASCADE` — consent to an application that no longer exists grants nothing. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Union of every scope the user has granted this application. */
    scopes: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** First authorization. `NOT NULL` — Mongoose defaulted it, so every row has one. */
    firstGrantedAt: timestamptz().notNull().defaultNow(),
    /** Refreshed on each authorize. What the "Connected apps" UI sorts by. */
    lastUsedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One grant per (user, application) — the authorize upsert relies on this to
    // union scopes rather than insert a duplicate. Mongo's standalone
    // `{userId}` is dropped: a btree serves any leading prefix.
    unique('app_grants_user_id_application_id_key').on(t.userId, t.applicationId),
    // The reverse direction, which the unique above cannot serve: "who has
    // granted this app", and the index Postgres needs to cascade an application
    // delete without scanning the table.
    index('app_grants_application_id_idx').on(t.applicationId),
  ]
);
