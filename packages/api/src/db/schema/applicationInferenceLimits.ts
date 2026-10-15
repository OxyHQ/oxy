/**
 * `application_inference_limits` — the technical limits an application's owner
 * sets in Oxy Console, applied by Oxy when it grants a request Kaana serves
 * (Kaana ADR 0002 decision 1; Alia ADR 0017 §5).
 *
 * ## Configuration, never a constant
 *
 * Kaana is a provider and serves the concurrency it is asked for; the product
 * that consumes it (Alia, for one) sets no global cap of its own. What bounds
 * an application is THIS row, written in Console. A column left NULL is not a
 * default somebody forgot: it means the application set no such limit.
 *
 * ## What each column bounds
 *
 *  - `max_concurrent_realtime_sessions`, `..._per_credential` — realtime
 *    sessions open at once. A session holds its slot for its whole life, so it
 *    is configured apart from the request concurrency of one-shot traffic.
 *    NULL: no session limit beyond the application's other limits.
 *  - `max_concurrent_requests`, `max_requests_per_utc_day` — the technical
 *    capacity of an `internal_metered` relationship (`config/inferenceEconomicPolicy.ts`).
 *    NULL keeps the relationship's reviewed default; a value replaces it for
 *    this application only.
 *
 * Spend is not here: budgets and spending limits are `spending_limits`, which
 * Console already writes and the ledger already enforces.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '@oxy.so/db';
import { applications } from './applications';
import { users } from './users';

/** The most any one of these limits may be set to; a typo must not mean "unlimited". */
export const MAX_APPLICATION_INFERENCE_LIMIT = 1_000_000;

export const applicationInferenceLimits = pgTable(
  'application_inference_limits',
  {
    applicationId: text()
      .primaryKey()
      .references(() => applications.id, { onDelete: 'cascade' }),
    maxConcurrentRealtimeSessions: integer(),
    maxConcurrentRealtimeSessionsPerCredential: integer(),
    maxConcurrentRequests: integer(),
    maxRequestsPerUtcDay: integer(),
    /** Who last wrote the row in Console. */
    updatedByAccountId: text().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'application_inference_limits_range_check',
      sql`(${t.maxConcurrentRealtimeSessions} is null or ${t.maxConcurrentRealtimeSessions} between 1 and ${sql.raw(String(MAX_APPLICATION_INFERENCE_LIMIT))})
        and (${t.maxConcurrentRealtimeSessionsPerCredential} is null or ${t.maxConcurrentRealtimeSessionsPerCredential} between 1 and ${sql.raw(String(MAX_APPLICATION_INFERENCE_LIMIT))})
        and (${t.maxConcurrentRequests} is null or ${t.maxConcurrentRequests} between 1 and ${sql.raw(String(MAX_APPLICATION_INFERENCE_LIMIT))})
        and (${t.maxRequestsPerUtcDay} is null or ${t.maxRequestsPerUtcDay} between 1 and ${sql.raw(String(MAX_APPLICATION_INFERENCE_LIMIT))})`,
    ),
    // A per-credential session limit above the application's is a limit that never applies.
    check(
      'application_inference_limits_credential_check',
      sql`${t.maxConcurrentRealtimeSessionsPerCredential} is null or ${t.maxConcurrentRealtimeSessions} is null
        or ${t.maxConcurrentRealtimeSessionsPerCredential} <= ${t.maxConcurrentRealtimeSessions}`,
    ),
  ],
);

export type ApplicationInferenceLimitsRow = typeof applicationInferenceLimits.$inferSelect;
