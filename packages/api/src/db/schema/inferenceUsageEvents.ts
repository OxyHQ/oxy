/**
 * `inference_usage_events` — append-only telemetry for one inference request.
 *
 * # Why a NEW table rather than reshaping `api_key_usage_events`
 *
 * The audit (`docs/audits/2026-08-15-account-and-application-ownership.md` §1.3)
 * measured three things about `api_key_usage_events`, and they point in
 * different directions:
 *
 *  1. It has **no writer anywhere in `packages/api/src` outside tests**, so both
 *     of its readers (`routes/credits.ts`, `routes/applications.ts`) query a
 *     table nothing populates. Whether it holds rows in PRODUCTION is
 *     **UNVERIFIED** — no production database is reachable from a worktree, and
 *     nothing here depends on the answer, because this migration neither drops
 *     it nor rewrites it.
 *  2. Its `user_id` is `NOT NULL` while its `application_id` is nullable — the
 *     exact attribution inversion ADR 0007 forbids — and its `credits_used` is
 *     `double precision`.
 *  3. It is nonetheless GENERAL API telemetry, not inference telemetry: `method`,
 *     `endpoint`, `status_code` and an `auth_type` of `api_key | session |
 *     internal` describe any served request.
 *
 * Reshaping it in place would mean making `application_id` NOT NULL and
 * retargeting its `api_key_id` off `developer_api_keys` — a narrowing migration
 * against a table whose two readers this PR does not rewrite, and one that
 * forces the `developer_api_keys` removal that is workstream 2.3's checkbox, not
 * this one's. It would also bolt eleven unit columns, a model reference, a
 * provider, a deployment and two data-plane ids onto rows describing a plain
 * REST call, where every one of them is null.
 *
 * So: a new stream for inference, and `api_key_usage_events` was left as it
 * stood. Workstream 2.3 has since dropped its `api_key_id` column and the
 * `developer_api_keys` table together
 * (`drizzle/0047_retire_developer_api_keys.sql`), and left the table itself in
 * place with its two readers — it remains general API telemetry, and merging it
 * into this stream is still not the tidy-up it looks like. The boundary is stated
 * in that table's header too, so whoever finds two usage tables finds the reason
 * before reaching for it.
 *
 * # There is no money column here, and that is the point
 *
 * `api_key_usage_events.credits_used` is a float, and #972's own framing is that
 * telemetry "must not become the financial ledger". The strongest available form
 * of that is not a comment: this table carries **no cost, credit or amount
 * column at all**. A customer-visible billed figure has nowhere to come from
 * except `usage_receipts`, and "the exact billed amount comes from the ledger,
 * never from telemetry sums" is therefore something the schema enforces rather
 * than something a reviewer has to remember.
 *
 * Units ARE here, in the same columns the receipts use, because a units figure
 * is what a dashboard shows and what a rate-limit analysis reads.
 *
 * # Retention is separate from financial retention
 *
 * Registered in `db/expiry.ts` at ninety days, the same window
 * `api_key_usage_events` has. `usage_receipts`, `usage_refunds`,
 * `usage_reservations` and the ledger tables are deliberately NOT registered,
 * and `db/__tests__/inferenceLedgerRetention.test.ts` fails if any of them ever
 * is — a financial record swept on a telemetry schedule is the failure this
 * separation exists to prevent, and it would be silent.
 *
 * # Eventual consistency
 *
 * A telemetry row is written OUTSIDE the ledger transaction. It can lag a
 * settlement, and a recorder failure drops a row without failing the request —
 * which is correct for telemetry and would be intolerable for a receipt. Every
 * customer-visible usage surface built on this table is eventually consistent
 * and must say so; the exact billed amount is not.
 *
 * Idempotency is by `(request_id, generation_id)`, as two partial unique indexes
 * rather than one compound: a compound unique over a nullable `generation_id`
 * would admit unlimited duplicates, because Postgres treats NULLs as distinct.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList } from '@oxyhq/db';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import {
  usageUnitColumns,
  usageUnitsNonNegativeCheck,
} from './ledgerColumns';
import { INFERENCE_REQUEST_OUTCOMES, USAGE_SOURCE_VALUES } from './usageReceipts';
import { INFERENCE_ENVIRONMENTS } from './usageReservations';
import { users } from './users';

/** Ninety days, matching `api_key_usage_events`. Financial records are not swept. */
export const INFERENCE_USAGE_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * A request that never reached a provider still needs a row, and the rollup's
 * primary key cannot hold a NULL. This sentinel is what an unrouted request
 * records instead — named rather than blank, because `''` is a value that reads
 * as data and this one has to read as an absence.
 */
export const UNROUTED_PROVIDER = 'unrouted';

export const inferenceUsageEvents = pgTable(
  'inference_usage_events',
  {
    id: generatedId(),

    // ---- attribution (ADR 0007) --------------------------------------------
    /**
     * The financially responsible account — the column `api_key_usage_events`
     * never had. `CASCADE`, unlike every financial table here: telemetry
     * attributed to a deleted account is neither billable nor reportable, and
     * these rows self-delete after ninety days anyway.
     */
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** NOT NULL, which is the half of the inversion ADR 0007 names. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /**
     * The credential, NOT the obsolete developer key. Credential-level
     * attribution is what makes rotation, per-credential limits, per-environment
     * separation and "which key leaked" answerable.
     */
    applicationCredentialId: text()
      .notNull()
      .references(() => applicationCredentials.id, { onDelete: 'cascade' }),
    /** Attribution only, never the payer. No foreign key — see `deferredForeignKeys.ts`. */
    delegatedUserId: text(),
    requestId: text().notNull(),
    generationId: text(),
    environment: text({ enum: INFERENCE_ENVIRONMENTS }).notNull(),

    // ---- what was asked for and what served it -----------------------------
    endpoint: text().notNull(),
    statusCode: integer().notNull(),
    outcome: text({ enum: INFERENCE_REQUEST_OUTCOMES }).notNull(),
    /** What the customer asked for, verbatim — a model reference or a profile. */
    requestedModelReference: text().notNull(),
    /** What actually served it. Null when the request never reached a route. */
    resolvedModelReference: text(),
    servingProvider: text(),
    /**
     * The data plane's endpoint identity. Opaque here and never resolved — see
     * `deferredForeignKeys.ts`. Customer-safe by policy, not by construction:
     * the serializer decides what is exposed.
     */
    deploymentId: text(),
    routeSwitches: integer().notNull().default(0),

    // ---- what it consumed --------------------------------------------------
    usageSource: text({ enum: USAGE_SOURCE_VALUES }).notNull(),
    ...usageUnitColumns(),

    latencyMs: bigint({ mode: 'number' }),
    timeToFirstTokenMs: bigint({ mode: 'number' }),

    /** The request's instant. Swept ninety days later — see the header. */
    createdAt: createdAt(),
  },
  (t) => [
    // Idempotent on the data plane's own ids, so a redelivered usage report
    // neither duplicates a row nor double-counts a rollup.
    uniqueIndex('inference_usage_events_request_generation_key')
      .on(t.requestId, t.generationId)
      .where(sql`${t.generationId} is not null`),
    uniqueIndex('inference_usage_events_request_key')
      .on(t.requestId)
      .where(sql`${t.generationId} is null`),

    // The three attribution reads, each with the time bound every caller uses.
    index('inference_usage_events_account_id_created_at_idx').on(t.accountId, t.createdAt.desc()),
    index('inference_usage_events_application_id_created_at_idx').on(
      t.applicationId,
      t.createdAt.desc()
    ),
    index('inference_usage_events_application_credential_id_created_at_idx').on(
      t.applicationCredentialId,
      t.createdAt.desc()
    ),
    // The expiry sweep's range scan. None of the compounds above LEADS with
    // `created_at`, so it needs its own.
    index('inference_usage_events_created_at_idx').on(t.createdAt),

    check(
      'inference_usage_events_environment_check',
      sql`${t.environment} in (${sql.raw(inList(INFERENCE_ENVIRONMENTS))})`
    ),
    check(
      'inference_usage_events_outcome_check',
      sql`${t.outcome} in (${sql.raw(inList(INFERENCE_REQUEST_OUTCOMES))})`
    ),
    check(
      'inference_usage_events_usage_source_check',
      sql`${t.usageSource} in (${sql.raw(inList(USAGE_SOURCE_VALUES))})`
    ),
    check(
      'inference_usage_events_status_code_check',
      sql`${t.statusCode} >= 100 and ${t.statusCode} < 600`
    ),
    check('inference_usage_events_request_id_check', sql`length(${t.requestId}) > 0`),
    check('inference_usage_events_endpoint_check', sql`length(${t.endpoint}) > 0`),
    check(
      'inference_usage_events_requested_model_check',
      sql`length(${t.requestedModelReference}) > 0`
    ),
    check(
      'inference_usage_events_latency_check',
      sql`(${t.latencyMs} is null or ${t.latencyMs} >= 0)
        and (${t.timeToFirstTokenMs} is null or ${t.timeToFirstTokenMs} >= 0)
        and ${t.routeSwitches} >= 0`
    ),
    usageUnitsNonNegativeCheck('inference_usage_events_units_check', t),
  ]
);
