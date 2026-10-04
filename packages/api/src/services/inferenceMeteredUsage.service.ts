/**
 * Durable usage and cost records for every admitted inference request, and the
 * report that keeps usage, tariff, provider cost and customer charge apart —
 * issue #1526 (plan item I09).
 *
 * ## The claim IS the idempotency guarantee
 *
 * {@link claimMeteredAdmission} inserts one `inference_metered_usage` row per
 * admitted request, keyed on the edge's ledger key. The partial unique index
 * (`status <> 'refused'`) is what decides a race between two requests carrying
 * one key, so idempotency no longer depends on a monetary hold having been
 * taken: it holds for `internal_metered`, for shadow metering, and for charged
 * commercial requests alike.
 *
 * ## Technical capacity for `internal_metered`
 *
 * Without a hold there is no balance to run out, so the relationship's
 * {@link InternalMeteredCapacity} bounds it instead: in-flight requests and
 * requests per UTC day, per application + environment. The check and the
 * insert run under one transaction-scoped advisory lock on that pair, so N
 * concurrent claims cannot all observe "one slot left". A refusal is a
 * capacity answer (`rate_limited` / `quota_exceeded`), never "top up".
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { executeRows, type SqlExecutor } from '@oxy.so/db';
import {
  costCenterUsageSchema,
  USAGE_UNITS,
  type CostCenterUsage,
  type InferenceEconomicTreatment,
  type InferenceEnvironment,
  type InferenceRequestOutcome,
  type UsageSource,
  type UsageUnit,
} from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import type {
  EconomicTreatmentDecision,
  InternalMeteredCapacity,
} from '../config/inferenceEconomicPolicy';
import { inferenceMeteredUsage } from '../db/schema/inferenceMeteredUsage';
import { internalCostCenters } from '../db/schema/internalCostCenters';
import { usageUnitColumnValues, USAGE_UNIT_COLUMN_KEYS } from '../db/schema/ledgerColumns';
import { usageReceipts } from '../db/schema/usageReceipts';
import { logger } from '../utils/logger';
import { quoteUnits } from './inferenceLedger.service';

/* -------------------------------------------------------------------------- */
/*  Admission                                                                 */
/* -------------------------------------------------------------------------- */

export interface MeteredAdmissionInput {
  readonly requestId: string;
  readonly parentRequestId?: string;
  readonly idempotencyKey: string;
  readonly economics: EconomicTreatmentDecision;
  readonly accountId: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly delegatedUserId?: string;
  readonly environment: InferenceEnvironment;
  readonly endpoint: string;
  readonly requestedModelReference: string;
  readonly admittedModelReference: string;
  readonly admittedProvider: string;
  readonly admittedDeploymentId: string;
  readonly routingPolicyVersionId: string | undefined;
  readonly ceiling: { readonly amount: string; readonly currency: string } | undefined;
  readonly expiresInSeconds: number;
}

export type MeteredAdmission =
  | { readonly status: 'claimed'; readonly meteredUsageId: string }
  /** Another request already holds this idempotency key (or this request id). */
  | { readonly status: 'duplicate' }
  | {
      readonly status: 'capacity-exceeded';
      readonly limit: 'concurrency' | 'daily';
      readonly capacity: InternalMeteredCapacity;
    };

/**
 * The nearest ACTIVE cost centre above an account, as one scalar subquery, so
 * the snapshot is taken in the same statement as the insert — the same walk
 * `resolveCostCenterForAccount` makes.
 */
function costCenterSnapshot(accountId: string) {
  return sql`(
    select candidate.account_id from (
      select c.account_id, true as is_self, 0 as depth
      from ${internalCostCenters} c
      where c.account_id = ${accountId} and c.status = 'active'
      union all
      select c.account_id, false as is_self, ua.depth
      from ${internalCostCenters} c
      join user_ancestors ua on ua.ancestor_id = c.account_id and ua.user_id = ${accountId}
      where c.status = 'active'
    ) candidate
    order by candidate.is_self desc, candidate.depth desc
    limit 1
  )`;
}

/** A stable 64-bit lock key for one application + environment's capacity. */
function capacityLockKey(applicationId: string, environment: string): bigint {
  const digest = createHash('sha256').update(`inference-capacity:${applicationId}:${environment}`).digest();
  return digest.readBigInt64BE(0);
}

/** Read the exact admission population; the caller decides whether to lock it. */
export async function readMeteredCapacity(
  executor: SqlExecutor, applicationId: string, environment: InferenceEnvironment, relationshipId?: string
): Promise<{ activeAdmissions: number; dailyAdmissions: number }> {
  const [counts] = await executeRows<{ in_flight: string; today: string }>(
    executor,
    sql`
      select
        count(*) filter (where ${inferenceMeteredUsage.status} = 'admitted'
          and ${inferenceMeteredUsage.expiresAt} > now())::text as in_flight,
        count(*) filter (where ${inferenceMeteredUsage.createdAt}
          >= (date_trunc('day', now() at time zone 'utc') at time zone 'utc'))::text as today
      from ${inferenceMeteredUsage}
      where ${inferenceMeteredUsage.applicationId} = ${applicationId}
        and ${inferenceMeteredUsage.environment} = ${environment}
        and ${relationshipId === undefined ? sql`true` : sql`${inferenceMeteredUsage.economicRelationshipId} = ${relationshipId}`}
        and ${inferenceMeteredUsage.status} <> 'refused'
        and ${inferenceMeteredUsage.createdAt} >= now() - interval '2 days'
    `
  );
  return { activeAdmissions: Number(counts?.in_flight ?? 0), dailyAdmissions: Number(counts?.today ?? 0) };
}

/**
 * Claim the durable usage row for an admitted request. NOTHING may be
 * forwarded unless this returned `claimed`.
 */
export async function claimMeteredAdmission(input: MeteredAdmissionInput): Promise<MeteredAdmission> {
  const values = {
    requestId: input.requestId,
    parentRequestId: input.parentRequestId ?? null,
    idempotencyKey: input.idempotencyKey,
    economicTreatment: input.economics.treatment,
    economicPolicyVersion: input.economics.policyVersion,
    economicRelationshipId:
      input.economics.treatment === 'internal_metered'
        ? input.economics.relationship.relationshipId
        : null,
    accountId: input.accountId,
    applicationId: input.applicationId,
    applicationCredentialId: input.applicationCredentialId,
    delegatedUserId: input.delegatedUserId ?? null,
    environment: input.environment,
    costCenterAccountId: costCenterSnapshot(input.accountId),
    endpoint: input.endpoint,
    requestedModelReference: input.requestedModelReference,
    admittedModelReference: input.admittedModelReference,
    admittedProvider: input.admittedProvider,
    admittedDeploymentId: input.admittedDeploymentId,
    routingPolicyVersionId: input.routingPolicyVersionId ?? null,
    ceilingAmount: input.ceiling?.amount ?? null,
    ceilingCurrency: input.ceiling?.currency ?? null,
    expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
  } as const;

  return getDb().transaction(async (tx): Promise<MeteredAdmission> => {
    if (input.economics.treatment === 'internal_metered') {
      const { capacity } = input.economics.relationship;
      await tx.execute(
        sql`select pg_advisory_xact_lock(${capacityLockKey(input.applicationId, input.environment).toString()}::bigint)`
      );
      const counts = await readMeteredCapacity(tx, input.applicationId, input.environment,
        capacity.scope === 'relationship' ? input.economics.relationship.relationshipId : undefined);
      if (counts.activeAdmissions >= capacity.maxConcurrentRequests) {
        return { status: 'capacity-exceeded', limit: 'concurrency', capacity };
      }
      if (counts.dailyAdmissions >= capacity.maxRequestsPerUtcDay) {
        return { status: 'capacity-exceeded', limit: 'daily', capacity };
      }
    }

    // Any unique conflict — the idempotency key or the request id — is a
    // duplicate. `DO NOTHING` without a target covers the partial index too.
    const [row] = await tx
      .insert(inferenceMeteredUsage)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: inferenceMeteredUsage.id });
    return row === undefined
      ? { status: 'duplicate' }
      : { status: 'claimed', meteredUsageId: row.id };
  });
}

/** Preserve the admitted floor, and append one final authorization before dispatch. */
export async function finalizeMeteredAuthorization(
  meteredUsageId: string, input: MeteredAdmissionInput
): Promise<boolean> {
  const rows = await getDb().update(inferenceMeteredUsage).set({
    finalAuthorizedModelReference: input.admittedModelReference,
    finalAuthorizedProvider: input.admittedProvider,
    finalAuthorizedDeploymentId: input.admittedDeploymentId,
    finalAuthorizedCeilingAmount: input.ceiling?.amount ?? null,
    finalAuthorizedCeilingCurrency: input.ceiling?.currency ?? null,
  }).where(and(eq(inferenceMeteredUsage.id, meteredUsageId),
    eq(inferenceMeteredUsage.requestId, input.requestId),
    eq(inferenceMeteredUsage.idempotencyKey, input.idempotencyKey),
    eq(inferenceMeteredUsage.accountId, input.accountId),
    eq(inferenceMeteredUsage.applicationId, input.applicationId),
    eq(inferenceMeteredUsage.applicationCredentialId, input.applicationCredentialId),
    eq(inferenceMeteredUsage.environment, input.environment),
    eq(inferenceMeteredUsage.status, 'admitted'),
    sql`${inferenceMeteredUsage.expiresAt} > now()`,
    sql`${inferenceMeteredUsage.finalAuthorizedDeploymentId} is null`))
    .returning({ id: inferenceMeteredUsage.id });
  return rows.length === 1;
}

/** Dispatch-time proof of the durable internal claim; expiry never permits replay. */
export async function hasActiveInternalMeteredAdmission(meteredUsageId: string, requestId: string): Promise<boolean> {
  const rows = await getDb().select({ id: inferenceMeteredUsage.id }).from(inferenceMeteredUsage)
    .where(and(eq(inferenceMeteredUsage.id, meteredUsageId), eq(inferenceMeteredUsage.requestId, requestId),
      eq(inferenceMeteredUsage.status, 'admitted'), eq(inferenceMeteredUsage.economicTreatment, 'internal_metered'),
      sql`${inferenceMeteredUsage.expiresAt} > now()`)).limit(1);
  return rows.length === 1;
}

/**
 * Release a claim whose request was refused BEFORE anything was forwarded
 * (a commercial reservation the ledger declined). The row stays, as history;
 * its key and its capacity slot are freed.
 */
export async function markMeteredAdmissionRefused(meteredUsageId: string): Promise<void> {
  await getDb()
    .update(inferenceMeteredUsage)
    .set({ status: 'refused' })
    .where(and(eq(inferenceMeteredUsage.id, meteredUsageId), eq(inferenceMeteredUsage.status, 'admitted')));
}

/* -------------------------------------------------------------------------- */
/*  Settlement                                                                */
/* -------------------------------------------------------------------------- */

export interface MeteredSettlementInput {
  readonly meteredUsageId: string;
  readonly outcome: InferenceRequestOutcome;
  readonly usageSource: UsageSource;
  readonly units: Partial<Record<UsageUnit, number>>;
  readonly resolvedModelReference: string;
  readonly servingProvider: string;
  readonly generationId: string | undefined;
  /** The SERVED route's price version — the one a receipt would bill from. */
  readonly priceVersionId: string;
  /** The receipt, when a customer was actually charged. Never for `internal_metered`. */
  readonly usageReceiptId?: string;
}

export type MeteredSettlement =
  | { readonly status: 'settled'; readonly tariff: 'quoted' | 'unpriced' }
  /** Already settled (or never claimed): the first settlement stands. */
  | { readonly status: 'not-admitted' };

/**
 * Write the terminal usage record, ONCE.
 *
 * The tariff is priced here from the pinned price version and copied onto the
 * row, so a later price change never alters what this request is recorded as
 * having been worth. An unpriceable request is `unpriced` with no amount.
 */
export async function settleMeteredUsage(input: MeteredSettlementInput): Promise<MeteredSettlement> {
  const quote = await quoteUnits(input.priceVersionId, input.units);
  const tariff =
    quote.status === 'quoted'
      ? { tariffStatus: 'quoted' as const, tariffAmount: quote.amount, tariffCurrency: quote.currency }
      : { tariffStatus: 'unpriced' as const, tariffAmount: null, tariffCurrency: null };

  const updated = await getDb()
    .update(inferenceMeteredUsage)
    .set({
      status: 'settled',
      outcome: input.outcome,
      usageSource: input.usageSource,
      ...usageUnitColumnValues(input.units),
      resolvedModelReference: input.resolvedModelReference,
      servingProvider: input.servingProvider,
      generationId: input.generationId ?? null,
      settledPriceVersionId: input.priceVersionId,
      ...tariff,
      usageReceiptId: input.usageReceiptId ?? null,
      settledAt: new Date(),
    })
    .where(
      and(
        eq(inferenceMeteredUsage.id, input.meteredUsageId),
        eq(inferenceMeteredUsage.status, 'admitted')
      )
    )
    .returning({ id: inferenceMeteredUsage.id });

  return updated.length === 0
    ? { status: 'not-admitted' }
    : { status: 'settled', tariff: tariff.tariffStatus };
}

/**
 * Recover the crash window after a commercial receipt commits but before usage
 * is linked. Only immutable receipts with the exact authenticated attribution
 * can recover a terminal fact; provider-cost subtotals do not prove completion.
 * No reservation, charge or provider request is made by this reconciliation.
 */
export async function reconcileMeteredReceipts(limit = 100): Promise<number> {
  const matchingUnits = sql.join(Object.values(USAGE_UNIT_COLUMN_KEYS)
    .map((key) => sql`${inferenceMeteredUsage[key]} = ${usageReceipts[key]}`), sql` and `);
  const pending = await getDb().select({ metering: inferenceMeteredUsage, receipt: usageReceipts })
    .from(inferenceMeteredUsage)
    .innerJoin(usageReceipts, and(
      eq(usageReceipts.requestId, inferenceMeteredUsage.requestId),
      eq(usageReceipts.idempotencyKey, inferenceMeteredUsage.idempotencyKey),
      eq(usageReceipts.accountId, inferenceMeteredUsage.accountId),
      eq(usageReceipts.applicationId, inferenceMeteredUsage.applicationId),
      eq(usageReceipts.applicationCredentialId, inferenceMeteredUsage.applicationCredentialId),
      eq(usageReceipts.environment, inferenceMeteredUsage.environment),
      sql`${usageReceipts.delegatedUserId} is not distinct from ${inferenceMeteredUsage.delegatedUserId}`,
    ))
    .where(sql`${inferenceMeteredUsage.economicTreatment} = 'commercial'
      and ${inferenceMeteredUsage.status} in ('admitted', 'settled')
      and ${inferenceMeteredUsage.usageReceiptId} is null
      and (${inferenceMeteredUsage.status} = 'admitted' or (
        ${inferenceMeteredUsage.outcome} = ${usageReceipts.outcome}
        and ${inferenceMeteredUsage.usageSource} = ${usageReceipts.usageSource}
        and ${inferenceMeteredUsage.resolvedModelReference} = ${usageReceipts.resolvedModelReference}
        and ${inferenceMeteredUsage.servingProvider} = ${usageReceipts.servingProvider}
        and ${inferenceMeteredUsage.generationId} is not distinct from ${usageReceipts.generationId}
        and ${inferenceMeteredUsage.settledPriceVersionId} = ${usageReceipts.priceVersionId}
        and ${matchingUnits}
      ))`)
    .limit(limit);
  let recovered = 0;
  for (const { metering, receipt } of pending) {
    const units = Object.fromEntries(Object.entries(USAGE_UNIT_COLUMN_KEYS)
      .map(([unit, key]) => [unit, receipt[key]]));
    if (metering.status === 'admitted') {
      const result = await settleMeteredUsage({
        meteredUsageId: metering.id,
        outcome: receipt.outcome, usageSource: receipt.usageSource, units,
        resolvedModelReference: receipt.resolvedModelReference,
        servingProvider: receipt.servingProvider,
        generationId: receipt.generationId ?? undefined,
        priceVersionId: receipt.priceVersionId, usageReceiptId: receipt.id,
      });
      if (result.status === 'settled') recovered += 1;
    } else {
      // Link only if the already-recorded technical facts agree. Conflicting
      // evidence remains unresolved; never replace technical usage or receipts.
      const matchingUnits = sql.join(Object.keys(USAGE_UNIT_COLUMN_KEYS)
        .map((unit) => sql.raw(`m.${unit} = r.${unit}`)), sql` and `);
      const rows = await executeRows(getDb(), sql`
        update inference_metered_usage m set usage_receipt_id = r.id
        from usage_receipts r where m.id = ${metering.id} and r.id = ${receipt.id}
          and m.status = 'settled' and m.usage_receipt_id is null
          and m.outcome = r.outcome and m.usage_source = r.usage_source
          and m.resolved_model_reference = r.resolved_model_reference
          and m.serving_provider = r.serving_provider
          and m.generation_id is not distinct from r.generation_id
          and m.settled_price_version_id = r.price_version_id and ${matchingUnits}
        returning m.id`);
      recovered += rows.length;
    }
  }
  return recovered;
}

/** Recover committed receipts on every API task, without depending on Kaana configuration. */
export function startMeteredReceiptReconciliationSchedule(): { stop(): void } {
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    reconcileMeteredReceipts().catch((error: unknown) =>
      logger.error('inference.metered_usage.reconciliation_failed',
        error instanceof Error ? error : new Error(String(error))))
      .finally(() => { running = false; });
  };
  const interval = setInterval(tick, 60_000);
  interval.unref();
  return { stop(): void { clearInterval(interval); } };
}

/* -------------------------------------------------------------------------- */
/*  Report                                                                    */
/* -------------------------------------------------------------------------- */

export interface CostCenterUsageQuery {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly currency: string;
}

type UsageReportRow = Record<string, unknown> & {
  cost_center_account_id: string | null;
  economic_treatment: InferenceEconomicTreatment;
  request_count: string;
  in_flight_count: string;
  expired_count: string;
  tariff_amount: string;
  tariff_known: string;
  tariff_unknown: string;
  provider_amount: string;
  provider_known: string;
  provider_unknown: string;
  provider_partial: string;
  provider_missing: string;
  provider_other_currency: string;
  provider_reported_amount: string;
  provider_reported_count: string;
  provider_estimated_amount: string;
  provider_estimated_count: string;
  charge_amount: string;
  charge_count: string;
};

/**
 * Usage and cost per cost centre and economic treatment over a window.
 *
 * Settled requests count by `settled_at`; in-flight requests by `created_at`.
 * Provider cost is every attempt Kaana reported for those requests — failed
 * failovers included — in the report's currency; attempts with an unknown cost
 * are COUNTED (`unknownCount`), never summed. Tariffs quoted in another
 * currency are outside a report in this one. Customer charge is read from the
 * linked receipts only.
 */
export async function costCenterUsage(query: CostCenterUsageQuery): Promise<CostCenterUsage[]> {
  const start = query.periodStart.toISOString();
  const end = query.periodEnd.toISOString();
  const unitSums = sql.join(
    USAGE_UNITS.map((unit) =>
      sql.raw(`coalesce(sum(r.${unit}) filter (where r.status = 'settled'), 0)::text as "u_${unit}"`)
    ),
    sql`, `
  );

  const rows = await executeRows<UsageReportRow>(
    getDb(),
    sql`
      with scoped as (
        select m.* from ${inferenceMeteredUsage} m
        where (m.status = 'settled'
                and m.settled_at >= ${start}::timestamptz and m.settled_at < ${end}::timestamptz)
           or (m.status = 'admitted'
                and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz)
      ),
      costs as (
        select a.request_id,
          sum(a.cost_amount) filter (where a.cost_currency = ${query.currency}) as known_amount,
          count(*) filter (where a.cost_currency = ${query.currency} and a.cost_complete) as known_count,
          count(*) filter (where a.cost_amount is null) as unknown_count,
          count(*) filter (where a.cost_currency = ${query.currency} and not a.cost_complete) as partial_count,
          count(*) filter (where a.cost_currency <> ${query.currency}) as other_currency_count,
          sum(a.cost_amount) filter (where a.cost_currency = ${query.currency} and a.cost_source = 'provider_reported') as reported_amount,
          count(*) filter (where a.cost_currency = ${query.currency} and a.cost_source = 'provider_reported') as reported_count,
          sum(a.cost_amount) filter (where a.cost_currency = ${query.currency} and a.cost_source = 'rate_card') as estimated_amount,
          count(*) filter (where a.cost_currency = ${query.currency} and a.cost_source = 'rate_card') as estimated_count
        from inference_provider_cost_attempts a
        where a.request_id in (select request_id from scoped)
        group by a.request_id
      )
      select
        r.cost_center_account_id,
        r.economic_treatment,
        count(*) filter (where r.status = 'settled')::text as request_count,
        count(*) filter (where r.status = 'admitted' and r.expires_at > now())::text as in_flight_count,
        count(*) filter (where r.status = 'admitted' and r.expires_at <= now())::text as expired_count,
        ${unitSums},
        coalesce(round(sum(r.tariff_amount) filter (where r.status = 'settled'
          and r.tariff_status = 'quoted' and r.tariff_currency = ${query.currency}), 12), 0)::text as tariff_amount,
        count(*) filter (where r.status = 'settled' and r.tariff_status = 'quoted'
          and r.tariff_currency = ${query.currency})::text as tariff_known,
        count(*) filter (where r.status = 'settled' and r.tariff_status = 'unpriced')::text as tariff_unknown,
        coalesce(round(sum(c.known_amount), 12), 0)::text as provider_amount,
        coalesce(sum(c.known_count), 0)::text as provider_known,
        coalesce(sum(c.unknown_count), 0)::text as provider_unknown,
        coalesce(sum(c.partial_count), 0)::text as provider_partial,
        count(*) filter (where c.request_id is null)::text as provider_missing,
        coalesce(sum(c.other_currency_count), 0)::text as provider_other_currency,
        coalesce(round(sum(c.reported_amount), 12), 0)::text as provider_reported_amount,
        coalesce(sum(c.reported_count), 0)::text as provider_reported_count,
        coalesce(round(sum(c.estimated_amount), 12), 0)::text as provider_estimated_amount,
        coalesce(sum(c.estimated_count), 0)::text as provider_estimated_count,
        coalesce(round(sum(rc.billed_amount) filter (where rc.currency = ${query.currency}), 12), 0)::text as charge_amount,
        count(rc.id) filter (where rc.currency = ${query.currency})::text as charge_count
      from scoped r
      left join costs c on c.request_id = r.request_id
      left join usage_receipts rc on rc.id = r.usage_receipt_id
      group by r.cost_center_account_id, r.economic_treatment
      order by r.cost_center_account_id nulls last, r.economic_treatment
    `
  );

  const centerIds = [
    ...new Set(rows.map((row) => row.cost_center_account_id).filter((id): id is string => id !== null)),
  ];
  // Validated as a `costCenterSchema` by the report parse below.
  const centers = new Map<string, Record<string, unknown>>();
  if (centerIds.length > 0) {
    const found = await getDb()
      .select()
      .from(internalCostCenters)
      .where(inArray(internalCostCenters.accountId, centerIds));
    for (const center of found) {
      centers.set(center.accountId, {
        schemaVersion: 1,
        accountId: center.accountId,
        slug: center.slug,
        label: center.label,
        status: center.status,
        createdAt: center.createdAt.toISOString(),
        updatedAt: center.updatedAt.toISOString(),
      });
    }
  }

  return rows.map((row) => {
    const units: Record<string, number> = {};
    for (const unit of USAGE_UNITS) {
      const quantity = Number(row[`u_${unit}`]);
      if (quantity > 0) units[unit] = quantity;
    }
    return costCenterUsageSchema.parse({
      schemaVersion: 1,
      costCenter:
        row.cost_center_account_id === null ? null : centers.get(row.cost_center_account_id) ?? null,
      treatment: row.economic_treatment,
      currency: query.currency,
      periodStart: start,
      periodEnd: end,
      requestCount: Number(row.request_count),
      inFlightCount: Number(row.in_flight_count),
      expiredCount: Number(row.expired_count),
      units,
      tariff: {
        amount: row.tariff_amount,
        knownCount: Number(row.tariff_known),
        unknownCount: Number(row.tariff_unknown),
      },
      providerCost: {
        amount: row.provider_amount,
        knownCount: Number(row.provider_known),
        unknownCount: Number(row.provider_unknown),
        partialCount: Number(row.provider_partial),
        missingRequestCount: Number(row.provider_missing),
        otherCurrencyCount: Number(row.provider_other_currency),
        providerReportedAmount: row.provider_reported_amount,
        providerReportedCount: Number(row.provider_reported_count),
        estimatedAmount: row.provider_estimated_amount,
        estimatedCount: Number(row.provider_estimated_count),
      },
      customerCharge: { amount: row.charge_amount, receiptCount: Number(row.charge_count) },
    });
  });
}
