/**
 * Inference Telemetry Service — the append-only usage stream and its aggregates.
 *
 * #972 workstream 8. Two writes per request, both outside any ledger
 * transaction: the event row, and an incremental daily rollup.
 *
 * ## Telemetry carries units. It never carries money.
 *
 * There is no cost, credit or amount column on either table, so
 * "the exact billed amount comes from the financial ledger, never from
 * telemetry sums" is enforced by the schema rather than by a convention a future
 * reader has to know. A spend figure has one source: `usage_receipts`.
 *
 * ## Eventually consistent, and that is the contract
 *
 * A recorder failure drops a telemetry row without failing the request, and a
 * rollup can lag a settlement. Both are correct for a dashboard and would be
 * intolerable for a bill. Every customer-visible surface built on
 * {@link summarizeUsage} must say so.
 *
 * ## `excluded.<column>` is spelled out, and that is the whole reason this file
 * is careful
 *
 * The rollup upsert adds each column to itself, which means naming the EXCLUDED
 * row's columns. Interpolating a drizzle column object there emits the
 * TypeScript property name — `excluded.inputTokens` — and Postgres answers
 * `42703 column does not exist` at runtime, not at build time. Every reference
 * goes through `sqlColumnName`, and the test exercises the upsert TWICE against
 * a real database, because a single insert never reaches the conflict branch at
 * all.
 */

import { and, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { sqlColumnName } from '@oxyhq/db';
import type { InferenceRequestOutcome, UsageSource, UsageUnit } from '@oxyhq/contracts';
import type { InferenceEnvironment } from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { inferenceUsageDailyRollups } from '../db/schema/inferenceUsageDailyRollups';
import {
  inferenceUsageEvents,
  UNROUTED_PROVIDER,
} from '../db/schema/inferenceUsageEvents';
import {
  USAGE_UNIT_COLUMN_KEYS,
  usageUnitColumnValues,
  type UsageUnitColumnKey,
} from '../db/schema/ledgerColumns';

/** HTTP status at or above which a request counts as an error in the rollup. */
const ERROR_STATUS_FLOOR = 400;

export interface RecordUsageInput {
  /** ADR 0007's tuple. The account is the billable principal, never the user. */
  readonly accountId: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly delegatedUserId?: string;
  readonly requestId: string;
  readonly generationId?: string;
  readonly environment: InferenceEnvironment;

  readonly endpoint: string;
  readonly statusCode: number;
  readonly outcome: InferenceRequestOutcome;
  readonly requestedModelReference: string;
  readonly resolvedModelReference?: string;
  readonly servingProvider?: string;
  readonly deploymentId?: string;
  readonly routeSwitches?: number;

  readonly usageSource: UsageSource;
  readonly units: Partial<Record<UsageUnit, number>>;
  readonly latencyMs?: number;
  readonly timeToFirstTokenMs?: number;
  /** Defaults to now. Decides which UTC day the rollup lands on. */
  readonly occurredAt?: Date;
}

export type RecordUsageResult =
  | { readonly status: 'recorded'; readonly eventId: string }
  /** A redelivered report for a request already recorded. Nothing was written. */
  | { readonly status: 'already-recorded' };

/**
 * Record one served inference request and fold it into the daily rollup.
 *
 * Idempotent on `(request_id, generation_id)`. The rollup is only incremented
 * when the event row was actually INSERTED — a redelivered report that
 * incremented the rollup anyway would inflate every usage chart while the event
 * stream stayed correct, which is the hardest kind of drift to notice.
 *
 * Both writes are in one transaction so the two can never disagree about
 * whether a request happened.
 */
export async function recordInferenceUsage(
  input: RecordUsageInput
): Promise<RecordUsageResult> {
  const occurredAt = input.occurredAt ?? new Date();
  const units = usageUnitColumnValues(input.units);

  return getDb().transaction(async (tx): Promise<RecordUsageResult> => {
    const [event] = await tx
      .insert(inferenceUsageEvents)
      .values({
        accountId: input.accountId,
        applicationId: input.applicationId,
        applicationCredentialId: input.applicationCredentialId,
        delegatedUserId: input.delegatedUserId,
        requestId: input.requestId,
        generationId: input.generationId,
        environment: input.environment,
        endpoint: input.endpoint,
        statusCode: input.statusCode,
        outcome: input.outcome,
        requestedModelReference: input.requestedModelReference,
        resolvedModelReference: input.resolvedModelReference,
        servingProvider: input.servingProvider,
        deploymentId: input.deploymentId,
        routeSwitches: input.routeSwitches ?? 0,
        usageSource: input.usageSource,
        ...units,
        latencyMs: input.latencyMs,
        timeToFirstTokenMs: input.timeToFirstTokenMs,
        createdAt: occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: inferenceUsageEvents.id });

    if (!event) {
      return { status: 'already-recorded' };
    }

    await tx
      .insert(inferenceUsageDailyRollups)
      .values({
        day: utcDay(occurredAt),
        accountId: input.accountId,
        applicationId: input.applicationId,
        applicationCredentialId: input.applicationCredentialId,
        environment: input.environment,
        requestedModelReference: input.requestedModelReference,
        // A request that never reached a route still has to land somewhere, and
        // the rollup's primary key cannot hold a NULL.
        servingProvider: input.servingProvider ?? UNROUTED_PROVIDER,
        outcome: input.outcome,
        requestCount: 1,
        errorCount: input.statusCode >= ERROR_STATUS_FLOOR ? 1 : 0,
        ...units,
      })
      .onConflictDoUpdate({
        target: [
          inferenceUsageDailyRollups.day,
          inferenceUsageDailyRollups.accountId,
          inferenceUsageDailyRollups.applicationId,
          inferenceUsageDailyRollups.applicationCredentialId,
          inferenceUsageDailyRollups.environment,
          inferenceUsageDailyRollups.requestedModelReference,
          inferenceUsageDailyRollups.servingProvider,
          inferenceUsageDailyRollups.outcome,
        ],
        set: rollupIncrements(),
      });

    return { status: 'recorded', eventId: event.id };
  });
}

/**
 * `column = table.column + excluded.column` for every counter on the rollup.
 *
 * `sqlColumnName` on BOTH sides. The `excluded` side is the one that bites: a
 * drizzle column interpolated there renders the TypeScript property name, so
 * `excluded.inputTokens` reaches Postgres and fails with `42703` at runtime.
 */
function rollupIncrements(): Record<string, SQL> {
  const counters: (UsageUnitColumnKey | 'requestCount' | 'errorCount')[] = [
    'requestCount',
    'errorCount',
    ...Object.values(USAGE_UNIT_COLUMN_KEYS),
  ];

  const increments: Record<string, SQL> = {
    updatedAt: sql`date_trunc('milliseconds', now())`,
  };
  for (const key of counters) {
    const column = inferenceUsageDailyRollups[key];
    increments[key] = sql`${column} + ${sql.raw(`excluded.${sqlColumnName(column)}`)}`;
  }
  return increments;
}

/** The UTC calendar day an instant falls in, as the `date` column stores it. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface UsageSummaryQuery {
  readonly accountId: string;
  readonly from: string;
  readonly to: string;
  readonly applicationId?: string;
  readonly applicationCredentialId?: string;
}

export interface UsageSummaryRow {
  readonly day: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly environment: InferenceEnvironment;
  readonly requestedModelReference: string;
  readonly servingProvider: string;
  readonly outcome: InferenceRequestOutcome;
  readonly requestCount: number;
  readonly errorCount: number;
  readonly units: Record<UsageUnitColumnKey, number>;
}

/**
 * Read the aggregate for one account over a date range.
 *
 * EVENTUALLY CONSISTENT — see the module header. A customer surface built on
 * this must say so, and must not present the figures beside a billed amount as
 * though the two were derived from the same record.
 */
export async function summarizeUsage(
  query: UsageSummaryQuery
): Promise<UsageSummaryRow[]> {
  const filters = [
    eq(inferenceUsageDailyRollups.accountId, query.accountId),
    gte(inferenceUsageDailyRollups.day, query.from),
    lte(inferenceUsageDailyRollups.day, query.to),
  ];
  if (query.applicationId !== undefined) {
    filters.push(eq(inferenceUsageDailyRollups.applicationId, query.applicationId));
  }
  if (query.applicationCredentialId !== undefined) {
    filters.push(
      eq(inferenceUsageDailyRollups.applicationCredentialId, query.applicationCredentialId)
    );
  }

  const rows = await getDb()
    .select()
    .from(inferenceUsageDailyRollups)
    .where(and(...filters))
    .orderBy(inferenceUsageDailyRollups.day);

  return rows.map((row) => ({
    day: row.day,
    applicationId: row.applicationId,
    applicationCredentialId: row.applicationCredentialId,
    environment: row.environment,
    requestedModelReference: row.requestedModelReference,
    servingProvider: row.servingProvider,
    outcome: row.outcome,
    requestCount: row.requestCount,
    errorCount: row.errorCount,
    units: Object.fromEntries(
      Object.values(USAGE_UNIT_COLUMN_KEYS).map((key) => [key, row[key]])
    ) as Record<UsageUnitColumnKey, number>,
  }));
}
