/**
 * `api_key_usage_events` — one served API request, for usage and credit
 * reporting.
 *
 * Ported from `models/ApiKeyUsage.ts`. Named for what it holds: a row is one
 * request event, and `auth_type` records whether it arrived on an API key, a
 * user session, or an internal service token — so the Mongoose model name is
 * narrower than the table's contents.
 *
 * ## `timestamp` becomes `created_at`
 *
 * The Mongoose model set `timestamps: false` and declared its own
 * `timestamp: { default: Date.now }`. That is the row's birth column and
 * nothing else: `CONVENTIONS.md` maps exactly this shape onto `created_at`, and
 * doing so is what lets the 90-day retention below read as an ordinary window on
 * a birth column rather than a special case.
 *
 * The wire format does not observe the rename. `timestamp` appears in the two
 * aggregates that read this collection only as a `$match` bound and a
 * `$dateToString` grouping key (`routes/applications.ts:316`,
 * `routes/credits.ts:59`); neither emits a field under that name.
 *
 * ## No `updated_at`
 *
 * The absence IS the append-only contract — a served request does not change
 * after the fact.
 *
 * ## Retention is the Mongo TTL, moved
 *
 * Mongo auto-deleted these after 90 days. The same 90 days is registered in
 * `db/expiry.ts` against `created_at`, with the supporting btree the sweep
 * requires. That retention is also why the one `SET NULL`-shaped foreign key
 * below is `CASCADE` instead — see `application_id`.
 *
 * ## This is NOT the inference telemetry stream — read this before merging them
 *
 * `inference_usage_events` (#972 workstream 8) is a separate table, and the two
 * are not duplicates: this one is GENERAL API telemetry (`method`, `endpoint`,
 * `auth_type` of `api_key | session | internal`) and that one is one inference
 * request, with unit totals, a model reference, a serving provider and the
 * account/application/credential attribution ADR 0007 requires. The reasoning
 * for keeping them apart — including why this table was not reshaped in place —
 * is in `inferenceUsageEvents.ts`'s header.
 *
 * ## The `api_key` in the name is now historical
 *
 * This table has **no writer anywhere in `packages/api/src` outside tests**, and
 * as of #972 workstream 2.3 it no longer references any key table: the
 * `api_key_id` column and the `developer_api_keys` table it pointed at were
 * dropped together (`drizzle/0047_retire_developer_api_keys.sql`). What survives
 * is the two READERS — `routes/applications.ts` (per-application usage stats) and
 * `routes/credits.ts` (per-user credit history) — neither of which ever selected
 * that column, plus the expiry registration in `db/expiry.ts`.
 *
 * `auth_type` still carries `'api_key'` as a value and as its default. That is a
 * record of how a historical request authenticated, not a reference to a live
 * credential table, and rewriting it would change the meaning of rows already
 * written. Nothing in the inference ledger reads or writes this table.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId } from '@oxyhq/db';
import { users } from './users';

/** How a request authenticated. Decides which attribution columns are populated. */
export const API_KEY_USAGE_AUTH_TYPES = ['api_key', 'session', 'internal'] as const;

/** HTTP methods a recorded request may use. */
export const API_KEY_USAGE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Ninety days, the retention Mongo's TTL index enforced. Exported so
 * `db/expiry.ts` states the same number this table was designed around rather
 * than a second copy of it.
 */
export const API_KEY_USAGE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** Renders a `const` tuple as a SQL `in (…)` list. */
function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const apiKeyUsageEvents = pgTable(
  'api_key_usage_events',
  {
    id: generatedId(),
    /**
     * The user the request is billed to. `CASCADE` — usage attributed to a
     * deleted account is not billable and not reportable.
     *
     * Mongoose typed this as a bare `String` with no `ref`; the values are
     * `User._id` strings and this is a real relation the port gets to enforce.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The application the request is attributed to.
     *
     * `CASCADE`, not `SET NULL`, and for the same reason
     * `push_tokens.application_id` is: NULL here already MEANS something — "not
     * attributed to an application" — so `SET NULL` would silently reclassify a
     * deleted application's requests as unattributed traffic and corrupt the very
     * aggregate this table exists to produce (`routes/applications.ts` groups by
     * exactly this column). Losing them outright is honest, and the rows are
     * 90-day telemetry that self-delete anyway.
     */
    applicationId: text().references(() => applications.id, { onDelete: 'cascade' }),

    endpoint: text().notNull(),
    method: text({ enum: API_KEY_USAGE_METHODS }).notNull(),
    statusCode: integer().notNull(),
    /** LLM tokens consumed. A count, so an integer. */
    tokensUsed: integer().notNull().default(0),
    /** Billing credits consumed. `doublePrecision` — a credit is divisible. */
    creditsUsed: doublePrecision().notNull().default(0),
    /** Milliseconds. Averaged by the usage report, never summed. */
    responseTime: doublePrecision(),
    /**
     * The client's `User-Agent`. Explicitly NOT an IP, a geo-derivation, or
     * anything else the no-user-IPs-at-rest invariant forbids — the Mongoose
     * model's `ipAddress` field was removed under that invariant and does not
     * reappear here.
     */
    userAgent: text(),
    authType: text({ enum: API_KEY_USAGE_AUTH_TYPES }).notNull().default('api_key'),
    /**
     * Free-form label of the internal service that made the call. Carried
     * forward unchanged: no code in this package writes or reads it today, and
     * the contract permits dropping a field only once it is confirmed absent in
     * production.
     */
    serviceApp: text(),

    /** The request's instant. Swept 90 days later — see the header. */
    createdAt: createdAt(),
  },
  (t) => [
    // `getUsageStats({appId, timestamp: {$gte}})` (`routes/applications.ts:961`).
    index('api_key_usage_events_application_id_created_at_idx').on(
      t.applicationId,
      t.createdAt.desc()
    ),
    // `{userId, timestamp: {$gte}}` (`routes/credits.ts:59`).
    index('api_key_usage_events_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
    // Supports the expiry sweep in `db/expiry.ts` — the replacement for Mongo's
    // TTL index. None of the compounds above LEAD with this column, so the
    // sweep's range scan needs its own.
    index('api_key_usage_events_created_at_idx').on(t.createdAt),
    // Mongo's `{userId, authType, timestamp: -1}` is dropped: `auth_type` never
    // appears in a filter — both readers match on `userId` or `appId` plus a
    // time bound only.
    check(
      'api_key_usage_events_method_check',
      sql`${t.method} in (${sql.raw(inList(API_KEY_USAGE_METHODS))})`
    ),
    check(
      'api_key_usage_events_auth_type_check',
      sql`${t.authType} in (${sql.raw(inList(API_KEY_USAGE_AUTH_TYPES))})`
    ),
    // An HTTP status code. A row outside this range is a recording bug, and it
    // would silently distort the success/error split the usage report computes
    // from `status_code < 400`.
    check(
      'api_key_usage_events_status_code_check',
      sql`${t.statusCode} >= 100 and ${t.statusCode} < 600`
    ),
    // Consumption is never negative: a negative would subtract from a `$sum`
    // that bills a user.
    check(
      'api_key_usage_events_consumption_check',
      sql`${t.tokensUsed} >= 0 and ${t.creditsUsed} >= 0
        and (${t.responseTime} is null or ${t.responseTime} >= 0)`
    ),
  ]
);
