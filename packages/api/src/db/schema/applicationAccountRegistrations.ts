/**
 * `application_account_registrations` — which accounts a first-party deployment
 * has registered as its own users, and the bounded aggregate over them.
 *
 * Oxy accounts are global: one account signs in to every Oxy product, and a
 * first-party session carries no application (`sessions.application_id` is NULL
 * for the shared device session). Nothing else in this schema records "this
 * account is a user of deployment X", so the number a federated product reports
 * as `usage.users.total` (Mention's NodeInfo) cannot be derived from existing
 * rows, and counting all accounts would be wrong for every deployment.
 *
 * The deployment's own workload registers the accounts it provisioned locally
 * (`POST /application-accounts/self/registrations`). The application id is the
 * verified workload's, never a request value, so one deployment (the main app or
 * a managed instance, each its own `applications` row) can neither read nor
 * write another's rows or total.
 *
 * ## The total is a snapshot, not a per-request count
 *
 * `application_account_totals` holds one row per application: the number of
 * registered accounts that are ELIGIBLE (a local, personal, active account with
 * no closure fence) as of `computed_at`. It is recomputed by a bounded,
 * single-flight refresh (`applicationAccountTotals.service.ts`), never by a
 * public request. A trigger-maintained counter was rejected: eligibility also
 * changes when an account is archived or fenced, and no single write path owns
 * those transitions, so a counter would drift where a recount cannot.
 *
 * Both tables cascade from `applications` and `users`: a deleted account stops
 * being counted at once (its registration row is gone), and a deleted application
 * takes its ledger and snapshot with it.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

export const applicationAccountRegistrations = pgTable(
  'application_account_registrations',
  {
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.applicationId, t.userId] }),
    // The referencing side of `user_id`: without it every account deletion scans the ledger.
    index('application_account_registrations_user_id_idx').on(t.userId),
  ],
);

export const applicationAccountTotals = pgTable(
  'application_account_totals',
  {
    applicationId: text()
      .primaryKey()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Eligible registered accounts at `computed_at`. */
    total: bigint({ mode: 'number' }).notNull(),
    computedAt: timestamptz().notNull(),
  },
  (t) => [check('application_account_totals_total_check', sql`${t.total} >= 0`)],
);
