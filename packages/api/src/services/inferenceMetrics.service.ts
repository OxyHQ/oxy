/**
 * Inference operational metrics — the numbers workstream 16 names, served from
 * the durable record (issue #972, workstream 16).
 *
 * ## Why this is not `GET /metrics`, and not a counter registry
 *
 * `server.ts` already exposes `GET /metrics`: `memory`, `database` and a
 * `performance` summary fed by a global `res.on('finish')` hook keyed by
 * `` `${req.method} ${req.path}` ``. That surface is **process-local** — an
 * in-memory ring buffer, one instance's view, discarded on every deploy — and it
 * gives `p50/p95/p99` for `POST /v1/responses` as a whole with no breakdown at
 * all. Everything here is a QUERY over the durable record instead, so the answer
 * is the same from any instance and survives a deploy. Those are two different
 * kinds of number and folding them into one endpoint would invite a reader to
 * compare them.
 *
 * A `prom-client` registry was considered and refused for the reason
 * `docs/inference/observability.md` states: an unexported counter is not
 * observability, and with no scrape target configured anywhere a second
 * in-process copy of these numbers would be weaker than the table it duplicates.
 *
 * ## Two metrics have NO DATA YET, and say so rather than reporting zero
 *
 * `time_to_first_token_ms` and `route_switches` are NULL/`0` on every row today.
 * Both are reported through a discriminated `state` — `pending` with a reason and
 * the row counts behind it, never a zero. A metric that reads `0` when it means
 * "unmeasurable" is indistinguishable from one that is correctly zero, and the
 * second reading is the one a dashboard takes.
 *
 * **The reason is NOT that the edge cannot produce them.** It once was, and that
 * changed: since the signed relay hop landed the edge streams both public dialects
 * and forwards the data plane's own `timeToFirstTokenMs` and `routeSwitches` when
 * the usage report carries them (`inferenceEdge.service.ts`). What is absent is a
 * data plane: `resolveRelayDataPlane()` answers `absent` unless `RELAY_BASE_URL`
 * and the two signing variables are all set, and no deployment sets them, so
 * nothing has ever streamed and no route has ever switched.
 *
 * That distinction is worth a field rather than a comment, because it is the one
 * that will matter the day Relay is deployed: `dataPlane` on the payload reports
 * what `resolveRelayDataPlane()` says, so "no data because nothing is deployed"
 * and "deployed, and STILL not reporting a first token" are different readings of
 * the same `pending`. The second is a bug in the data plane; the first is a
 * Tuesday.
 *
 * Both discriminators are DERIVED — `rowsCarryingValue` is a `count()` over the
 * column and `dataPlane` is read from the environment resolver — so neither arm is
 * a hardcoded state, and both stop being pending by themselves.
 *
 * ## Which table answers which question, and why
 *
 *  - **Counts** (request, error, cancellation) come from
 *    `inference_usage_daily_rollups`. It is not swept, so a count stays
 *    answerable past the ninety days `inference_usage_events` keeps.
 *  - **Distributions** (latency, time to first token, route switches) and the
 *    402 reserve refusals come from `inference_usage_events`, because a
 *    percentile cannot be reconstructed from a rollup — see
 *    {@link LATENCY_ROLLUP_DECISION}.
 *  - **Settlement lag** joins `usage_receipts` to `usage_reservations` on
 *    `reservation_id`. Money, so it comes from the financial tables and from no
 *    telemetry sum.
 *  - **Reconciliation drift** comes from `billing_reconciliation_runs` and its
 *    discrepancy rows.
 *
 * ## `latency_ms` is Oxy's own measurement, and the name says so
 *
 * `totalLatencyMs` is read from `inference_usage_events.latency_ms`, which the
 * edge measures on the monotonic clock from `EdgeExecutionContext.receivedAt` —
 * so it includes authentication, admission, routing, the reservation, the forward
 * and the settlement. It is deliberately NOT the data plane's
 * `completedAt - startedAt`: that measures the upstream. The difference between
 * the two IS the control-plane overhead, which is the only figure in this file
 * that measures Oxy rather than somebody else, and conflating them would destroy
 * it.
 *
 * ## The provider dimension is deliberately absent
 *
 * No metric here is broken down by serving provider, and that is not an
 * omission of convenience. The edge writes `route.provider` — the provider it
 * ADMITTED — at every telemetry, receipt and rollup site, and never reads
 * `completion.usage.servingProvider`, the provider the data plane REPORTS. A
 * same-model failover would therefore be recorded against the original provider,
 * so a per-provider error rate built here would be confidently wrong for exactly
 * the traffic it exists to explain. A follow-up fixes the write side; until then
 * this surface declines to publish the dimension rather than publish it
 * misattributed. `inferenceReporting.service.ts` still groups the customer's own
 * usage by provider, and inherits the same gap.
 *
 * ## Staff only, and money-free
 *
 * Mounted behind `requireStaff` on `routes/inferenceAdmin.ts`. Request counts per
 * application are customer data and a settlement-lag distribution is an internal
 * operational figure; neither is a customer surface. Nothing here selects
 * `upstream_wholesale_cost_*` or any price column — Oxy's commercial position
 * never appears on a metric, and the reconciliation totals that DO carry money
 * are the platform's own reconciliation figures on a staff-gated route.
 *
 * No metric, label or field here is derived from a user IP, and none can be: the
 * columns do not exist.
 */

import { sql } from 'drizzle-orm';
import { executeRows } from '@oxyhq/db';
import { getDb } from '../config/postgres';
import { resolveRelayDataPlane } from '../config/relayDataPlane';
import {
  billingReconciliationDiscrepancies,
  billingReconciliationRuns,
} from '../db/schema/billingReconciliation';
import { inferenceUsageDailyRollups } from '../db/schema/inferenceUsageDailyRollups';
import { inferenceUsageEvents } from '../db/schema/inferenceUsageEvents';
import { usageReceipts } from '../db/schema/usageReceipts';
import { usageReservations } from '../db/schema/usageReservations';

/**
 * Why there is no `latency_ms` column on the rollup, stated where a reader
 * looking for one will find it.
 *
 * A rollup row is a set of counters folded together by `ON CONFLICT DO UPDATE`.
 * The only latency figures that survive that fold are a SUM and a COUNT, which
 * yield a mean — and a mean is the one latency statistic that hides the tail,
 * which is the whole reason p95 and p99 are the numbers asked for. Percentiles
 * cannot be summed: `p95(a ∪ b)` is not derivable from `p95(a)` and `p95(b)`, so
 * a rollup column could not answer the question this endpoint is for.
 *
 * The per-event column CAN answer it, over a window bounded by
 * `inference_usage_events_created_at_idx` and by the ninety-day retention. So no
 * migration is taken here: the honest limitation is that a latency percentile is
 * unanswerable for a window older than ninety days, which a mean column would
 * have answered wrongly rather than not at all.
 */
export const LATENCY_ROLLUP_DECISION =
  'percentiles are not foldable into a rollup counter; the per-event column is the only source';

/** The HTTP status a reservation refusal is answered with. */
const RESERVE_REFUSAL_STATUS = 402;

/** `to_char` mask producing the ISO-8601 instant every projection reports. */
const ISO_INSTANT = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

/**
 * A quantity that was cast to `text` in SQL, as a number.
 *
 * Throws rather than coercing, for the reason `inferenceReporting.service.ts`
 * gives: `postgres.js` decodes `bigint` and `numeric` as strings, and a `NaN`
 * reaching a metric is a silent wrong answer while a throw is a 500 somebody
 * fixes.
 */
function toCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative safe integer from SQL, received ${String(value)}`);
  }
  return parsed;
}

/** A millisecond figure from a `percentile_cont`, rounded to a whole ms. */
function toMillis(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative duration from SQL, received ${String(value)}`);
  }
  return Math.round(parsed);
}

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                    */
/* -------------------------------------------------------------------------- */

export interface MetricsWindow {
  /** Inclusive UTC calendar day, `YYYY-MM-DD`. */
  readonly from: string;
  /** Inclusive UTC calendar day, `YYYY-MM-DD`. */
  readonly to: string;
}

export interface MetricsScope {
  readonly window: MetricsWindow;
  /** Narrow to one account. Absent means every tenant — this is a staff surface. */
  readonly accountId?: string;
  readonly applicationId?: string;
}

/** A duration distribution. `sampleCount` is the rows that carried a value. */
export interface DurationDistribution {
  readonly sampleCount: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

/**
 * The closed set of reasons a metric can be pending.
 *
 * Closed rather than free text: a reason a consumer can switch on is the
 * difference between "this cannot be measured yet, here is why" and a string
 * somebody has to read.
 */
export const METRIC_PENDING_REASONS = [
  /** Nothing was recorded in the window at all. */
  'no_requests_recorded',
  /**
   * Rows exist; no data plane has reported a first-token time for any of them.
   *
   * Names the MEASURED absence, not a cause. The edge streams and forwards the
   * figure when a report carries it, so read `dataPlane` beside this to tell
   * "nothing is deployed" from "deployed and not reporting".
   */
  'no_first_token_time_reported',
  /** Rows exist; no data plane has reported a route switch for any of them. */
  'no_route_switch_reported',
  /** Receipts exist; none is joined to a reservation, so no lag is measurable. */
  'no_settled_reservation',
  /** No reconciliation pass has completed in the window. */
  'no_completed_reconciliation',
] as const;

export type MetricPendingReason = (typeof METRIC_PENDING_REASONS)[number];

/**
 * A metric with no data yet, and the reason — never a zero.
 *
 * `observedRows` is what makes this arm falsifiable: "pending because nothing was
 * recorded" and "pending because 12,000 rows were recorded and not one carried
 * the value" are different facts about the platform, and a bare `state:
 * 'pending'` would collapse them.
 */
export interface PendingMetric {
  readonly state: 'pending';
  readonly reason: MetricPendingReason;
  readonly observedRows: number;
  readonly rowsCarryingValue: number;
}

export type DistributionMetric =
  | PendingMetric
  | ({ readonly state: 'measured'; readonly observedRows: number } & DurationDistribution);

/** Request, error and cancellation counts, from the rollup. */
export type RateMetric =
  | { readonly state: 'pending'; readonly reason: 'no_requests_recorded'; readonly requestCount: 0 }
  | {
      readonly state: 'measured';
      readonly requestCount: number;
      readonly errorCount: number;
      readonly cancelledCount: number;
      /**
       * Basis points of `requestCount`. Reported ONLY on this arm: a rate over
       * zero requests is undefined, and `0` is the value that reads as "no
       * errors" instead.
       */
      readonly errorRateBps: number;
      readonly cancellationRateBps: number;
    };

export type FallbackMetric =
  | PendingMetric
  | {
      readonly state: 'measured';
      readonly observedRows: number;
      readonly requestsWithSwitch: number;
      readonly totalSwitches: number;
    };

/**
 * Requests refused because the money was not there.
 *
 * Counted by HTTP status, because that is what the durable row carries. The two
 * refusals it covers — `insufficient_balance` and `spending_limit_exceeded` — are
 * told apart only by the `inference.edge.reservation_refused` log line, which is
 * named here so nobody reads this count as one cause.
 */
export interface ReserveFailureMetric {
  readonly refusedRequests: number;
  readonly observedRows: number;
  readonly reasonsDistinguishableBy: 'inference.edge.reservation_refused log line';
}

export interface ReconciliationDriftRun {
  readonly runId: string;
  readonly provider: string;
  readonly currency: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly completedAt: string;
  readonly ledgerTotal: string;
  readonly externalTotal: string;
  /** `external − ledger`, exact. Positive means the processor reported more. */
  readonly driftAmount: string;
  readonly discrepancyCount: number;
}

export type ReconciliationDriftMetric =
  | { readonly state: 'pending'; readonly reason: 'no_completed_reconciliation'; readonly runCount: number; readonly failedRuns: number }
  | {
      readonly state: 'measured';
      readonly runCount: number;
      readonly completedRuns: number;
      readonly failedRuns: number;
      /** The newest completed pass. The current drift is THIS, not a sum. */
      readonly latest: ReconciliationDriftRun;
      /**
       * Discrepancy OBSERVATIONS in the window, by kind — not distinct findings.
       * Scheduled windows can overlap and an unresolved discrepancy is re-reported
       * by every pass that sees it, which is how this module's design says
       * resolution is expressed. Summing these across runs counts one problem
       * several times, so the field name says `observations`.
       */
      readonly observationsByKind: Readonly<Record<string, number>>;
    };

/**
 * Whether this deployment has a data plane at all, from
 * `resolveRelayDataPlane()`.
 *
 * On the payload because it is what makes a `pending` metric readable: with
 * `absent`, no request can ever have streamed and no route can have switched, so
 * `timeToFirstTokenMs` and `fallback` are pending for a reason nobody needs to
 * investigate. With `configured`, the same `pending` means the data plane is not
 * reporting what it should — which is a bug, and one that would otherwise look
 * identical.
 *
 * `unreadable` is the third state the resolver has: the variables are set and
 * malformed. It is reported rather than folded into `absent` because a deployment
 * that believes it configured a data plane and has not is the case that produces
 * the most confusing pending metric of the three.
 */
export type DataPlanePresence = 'configured' | 'absent' | 'unreadable';

export interface InferenceOperationalMetrics {
  readonly schemaVersion: 1;
  readonly window: MetricsWindow;
  /** What `resolveRelayDataPlane()` says — see {@link DataPlanePresence}. */
  readonly dataPlane: DataPlanePresence;
  /**
   * Telemetry is written outside the ledger transaction, so every count and
   * distribution here can lag a settlement or miss a request whose recorder
   * failed. Required on the payload rather than left to a reader.
   */
  readonly consistency: 'eventually-consistent';
  readonly requests: RateMetric;
  readonly totalLatencyMs: DistributionMetric;
  readonly timeToFirstTokenMs: DistributionMetric;
  readonly fallback: FallbackMetric;
  readonly reserveFailures: ReserveFailureMetric;
  readonly settlementLagMs: DistributionMetric;
  readonly reconciliationDrift: ReconciliationDriftMetric;
}

/* -------------------------------------------------------------------------- */
/*  Queries                                                                   */
/* -------------------------------------------------------------------------- */

/** The rollup filters, as one fragment every rollup query shares. */
function rollupFilter(scope: MetricsScope) {
  return sql`
    r.day >= ${scope.window.from}::date
    and r.day <= ${scope.window.to}::date
    ${scope.accountId === undefined ? sql`` : sql`and r.account_id = ${scope.accountId}`}
    ${scope.applicationId === undefined ? sql`` : sql`and r.application_id = ${scope.applicationId}`}
  `;
}

/** The event filters. `to` is inclusive, so the upper bound is the next midnight. */
function eventFilter(scope: MetricsScope) {
  return sql`
    e.created_at >= ${scope.window.from}::date
    and e.created_at < (${scope.window.to}::date + interval '1 day')
    ${scope.accountId === undefined ? sql`` : sql`and e.account_id = ${scope.accountId}`}
    ${scope.applicationId === undefined ? sql`` : sql`and e.application_id = ${scope.applicationId}`}
  `;
}

/**
 * Request rate, error rate and cancellation, from the rollup.
 *
 * `cancelled` is a rollup DIMENSION rather than a counter, so it is counted with
 * a `filter` on the outcome key rather than read from a column of its own.
 */
async function readRates(scope: MetricsScope): Promise<RateMetric> {
  const [row] = await executeRows<Record<string, unknown>>(
    getDb(),
    sql`
      select
        coalesce(sum(r.request_count), 0)::bigint::text as request_count,
        coalesce(sum(r.error_count), 0)::bigint::text as error_count,
        coalesce(sum(r.request_count) filter (where r.outcome = 'cancelled'), 0)::bigint::text
          as cancelled_count
      from ${inferenceUsageDailyRollups} r
      where ${rollupFilter(scope)}
    `
  );

  const requestCount = toCount(row?.request_count ?? 0);
  if (requestCount === 0) {
    return { state: 'pending', reason: 'no_requests_recorded', requestCount: 0 };
  }

  const errorCount = toCount(row?.error_count ?? 0);
  const cancelledCount = toCount(row?.cancelled_count ?? 0);
  return {
    state: 'measured',
    requestCount,
    errorCount,
    cancelledCount,
    errorRateBps: Math.round((errorCount * 10_000) / requestCount),
    cancellationRateBps: Math.round((cancelledCount * 10_000) / requestCount),
  };
}

/**
 * One duration column's distribution over the event stream.
 *
 * `observedRows` counts every event in the window and `sampleCount` only those
 * carrying the column, which is what lets the caller tell "no traffic" from "this
 * column is never written". Both come from the SAME scan, so they cannot describe
 * different windows.
 */
async function readEventDistribution(
  scope: MetricsScope,
  column: 'latency_ms' | 'time_to_first_token_ms',
  pendingReason: MetricPendingReason
): Promise<DistributionMetric> {
  // `percentile_cont` takes `double precision` or `interval`, and both duration
  // columns are `bigint`. The cast is explicit here rather than left to the
  // planner: an implicit one does not exist for this aggregate, so without it the
  // query fails outright — which is the safe direction, but only once someone runs
  // it.
  const target = sql.raw(`e.${column}`);
  const ordering = sql.raw(`e.${column}::double precision`);
  const [row] = await executeRows<Record<string, unknown>>(
    getDb(),
    sql`
      select
        count(*)::bigint::text as observed_rows,
        count(${target})::bigint::text as sample_count,
        percentile_cont(0.5) within group (order by ${ordering}) as p50_ms,
        percentile_cont(0.95) within group (order by ${ordering}) as p95_ms,
        percentile_cont(0.99) within group (order by ${ordering}) as p99_ms,
        max(${target})::text as max_ms
      from ${inferenceUsageEvents} e
      where ${eventFilter(scope)}
    `
  );

  const observedRows = toCount(row?.observed_rows ?? 0);
  const sampleCount = toCount(row?.sample_count ?? 0);
  if (sampleCount === 0) {
    return {
      state: 'pending',
      reason: observedRows === 0 ? 'no_requests_recorded' : pendingReason,
      observedRows,
      rowsCarryingValue: 0,
    };
  }

  return {
    state: 'measured',
    observedRows,
    sampleCount,
    p50Ms: toMillis(row?.p50_ms),
    p95Ms: toMillis(row?.p95_ms),
    p99Ms: toMillis(row?.p99_ms),
    maxMs: toMillis(row?.max_ms),
  };
}

/**
 * Fallback, from `route_switches`.
 *
 * `> 0` rather than `is not null`: the column is `NOT NULL DEFAULT 0`, so "the
 * data plane reported no switch" and "the data plane reported nothing" are the
 * same stored value, and a `count(column)` would report every row as a sample.
 * That is precisely the zero this metric must not present as a measurement.
 *
 * The edge forwards `routeSwitches` and surfaces `route_switch` frames on both
 * dialects, so this is a reporting absence rather than a missing capability — read
 * `dataPlane` beside it. `inference_route_switch_events` is the customer-visible
 * record of the same event and has its own writer; this metric counts the
 * telemetry column, so the two are not the same number and are not compared here.
 */
async function readFallback(scope: MetricsScope): Promise<FallbackMetric> {
  const [row] = await executeRows<Record<string, unknown>>(
    getDb(),
    sql`
      select
        count(*)::bigint::text as observed_rows,
        count(*) filter (where e.route_switches > 0)::bigint::text as requests_with_switch,
        coalesce(sum(e.route_switches), 0)::bigint::text as total_switches
      from ${inferenceUsageEvents} e
      where ${eventFilter(scope)}
    `
  );

  const observedRows = toCount(row?.observed_rows ?? 0);
  const requestsWithSwitch = toCount(row?.requests_with_switch ?? 0);
  if (requestsWithSwitch === 0) {
    return {
      state: 'pending',
      reason: observedRows === 0 ? 'no_requests_recorded' : 'no_route_switch_reported',
      observedRows,
      rowsCarryingValue: 0,
    };
  }

  return {
    state: 'measured',
    observedRows,
    requestsWithSwitch,
    totalSwitches: toCount(row?.total_switches ?? 0),
  };
}

/** Requests refused at the reservation, by the status the customer received. */
async function readReserveFailures(scope: MetricsScope): Promise<ReserveFailureMetric> {
  const [row] = await executeRows<Record<string, unknown>>(
    getDb(),
    sql`
      select
        count(*)::bigint::text as observed_rows,
        count(*) filter (where e.status_code = ${RESERVE_REFUSAL_STATUS})::bigint::text
          as refused_requests
      from ${inferenceUsageEvents} e
      where ${eventFilter(scope)}
    `
  );

  return {
    observedRows: toCount(row?.observed_rows ?? 0),
    refusedRequests: toCount(row?.refused_requests ?? 0),
    reasonsDistinguishableBy: 'inference.edge.reservation_refused log line',
  };
}

/**
 * Settlement lag: how long a hold stood before it became a charge.
 *
 * The join is on `usage_receipts.reservation_id`, so a receipt with no
 * reservation behind it — shadow metering writes none — contributes no sample
 * rather than a lag of zero. `observedRows` is every receipt in the window, so
 * "no receipts" and "receipts that were never held" stay distinguishable.
 */
async function readSettlementLag(scope: MetricsScope): Promise<DistributionMetric> {
  const [row] = await executeRows<Record<string, unknown>>(
    getDb(),
    sql`
      select
        count(*)::bigint::text as observed_rows,
        count(s.lag_ms)::bigint::text as sample_count,
        percentile_cont(0.5) within group (order by s.lag_ms) as p50_ms,
        percentile_cont(0.95) within group (order by s.lag_ms) as p95_ms,
        percentile_cont(0.99) within group (order by s.lag_ms) as p99_ms,
        max(s.lag_ms)::text as max_ms
      from (
        select
          case
            when res.id is null then null
            -- Cast to double precision: percentile_cont accepts that or an
            -- interval, and extract(epoch ...) yields numeric.
            else (extract(epoch from (rc.settled_at - res.created_at)) * 1000)::double precision
          end as lag_ms
        from ${usageReceipts} rc
        left join ${usageReservations} res on res.id = rc.reservation_id
        where rc.settled_at >= ${scope.window.from}::date
          and rc.settled_at < (${scope.window.to}::date + interval '1 day')
          ${scope.accountId === undefined ? sql`` : sql`and rc.account_id = ${scope.accountId}`}
          ${
            scope.applicationId === undefined
              ? sql``
              : sql`and rc.application_id = ${scope.applicationId}`
          }
      ) s
    `
  );

  const observedRows = toCount(row?.observed_rows ?? 0);
  const sampleCount = toCount(row?.sample_count ?? 0);
  if (sampleCount === 0) {
    return {
      state: 'pending',
      reason: observedRows === 0 ? 'no_requests_recorded' : 'no_settled_reservation',
      observedRows,
      rowsCarryingValue: 0,
    };
  }

  return {
    state: 'measured',
    observedRows,
    sampleCount,
    p50Ms: toMillis(row?.p50_ms),
    p95Ms: toMillis(row?.p95_ms),
    p99Ms: toMillis(row?.p99_ms),
    maxMs: toMillis(row?.max_ms),
  };
}

/**
 * Reconciliation drift.
 *
 * The window is filtered on `started_at`, which is the only instant every run row
 * has — `completed_at` is NULL on a pass still in flight, and filtering on it
 * would make an in-flight pass invisible rather than counted.
 *
 * A run row is platform-wide (`account_id is null`) or account-scoped. Both are
 * counted when no account narrowing is asked for, because both are reconciliation
 * that happened; an account-scoped read counts only that account's.
 */
async function readReconciliationDrift(
  scope: MetricsScope
): Promise<ReconciliationDriftMetric> {
  const db = getDb();
  const accountNarrowing =
    scope.accountId === undefined ? sql`` : sql`and run.account_id = ${scope.accountId}`;
  const windowFilter = sql`
    run.started_at >= ${scope.window.from}::date
    and run.started_at < (${scope.window.to}::date + interval '1 day')
    ${accountNarrowing}
  `;

  const [counts] = await executeRows<Record<string, unknown>>(
    db,
    sql`
      select
        count(*)::bigint::text as run_count,
        count(*) filter (where run.status = 'completed')::bigint::text as completed_runs,
        count(*) filter (where run.status = 'failed')::bigint::text as failed_runs
      from ${billingReconciliationRuns} run
      where ${windowFilter}
    `
  );

  const runCount = toCount(counts?.run_count ?? 0);
  const completedRuns = toCount(counts?.completed_runs ?? 0);
  const failedRuns = toCount(counts?.failed_runs ?? 0);

  if (completedRuns === 0) {
    return { state: 'pending', reason: 'no_completed_reconciliation', runCount, failedRuns };
  }

  const [latest] = await executeRows<Record<string, unknown>>(
    db,
    sql`
      select
        run.id,
        run.provider,
        run.currency,
        to_char(run.period_start at time zone 'UTC', ${ISO_INSTANT}::text) as period_start,
        to_char(run.period_end at time zone 'UTC', ${ISO_INSTANT}::text) as period_end,
        to_char(run.completed_at at time zone 'UTC', ${ISO_INSTANT}::text) as completed_at,
        run.ledger_total::text as ledger_total,
        run.external_total::text as external_total,
        (run.external_total - run.ledger_total)::text as drift_amount,
        run.discrepancy_count
      from ${billingReconciliationRuns} run
      where ${windowFilter} and run.status = 'completed'
      order by run.completed_at desc, run.id desc
      limit 1
    `
  );

  if (latest === undefined) {
    // `completedRuns > 0` and no newest completed row cannot both be true of one
    // snapshot. Reaching here means the two queries saw different data, which is
    // a bug to see rather than a plausible zero to publish.
    throw new Error('reconciliation drift counted a completed run it could not then read');
  }

  const byKind = await executeRows<Record<string, unknown>>(
    db,
    sql`
      select d.kind, count(*)::bigint::text as observations
      from ${billingReconciliationDiscrepancies} d
      join ${billingReconciliationRuns} run on run.id = d.run_id
      where ${windowFilter}
      group by d.kind
      order by d.kind
    `
  );

  return {
    state: 'measured',
    runCount,
    completedRuns,
    failedRuns,
    latest: {
      runId: String(latest.id),
      provider: String(latest.provider),
      currency: String(latest.currency),
      periodStart: String(latest.period_start),
      periodEnd: String(latest.period_end),
      completedAt: String(latest.completed_at),
      ledgerTotal: String(latest.ledger_total),
      externalTotal: String(latest.external_total),
      driftAmount: String(latest.drift_amount),
      discrepancyCount: toCount(latest.discrepancy_count),
    },
    observationsByKind: Object.fromEntries(
      byKind.map((row) => [String(row.kind), toCount(row.observations)])
    ),
  };
}

/**
 * Every workstream-16 metric for one window, in one payload.
 *
 * Sequential rather than `Promise.all`: this is a staff diagnostic, and firing
 * seven analytical scans at the pool at once would take connections from the
 * request path for a report nobody is waiting on the latency of.
 */
export async function readInferenceOperationalMetrics(
  scope: MetricsScope
): Promise<InferenceOperationalMetrics> {
  return {
    schemaVersion: 1,
    window: scope.window,
    dataPlane: resolveRelayDataPlane().status,
    consistency: 'eventually-consistent',
    requests: await readRates(scope),
    totalLatencyMs: await readEventDistribution(scope, 'latency_ms', 'no_requests_recorded'),
    timeToFirstTokenMs: await readEventDistribution(
      scope,
      'time_to_first_token_ms',
      'no_first_token_time_reported'
    ),
    fallback: await readFallback(scope),
    reserveFailures: await readReserveFailures(scope),
    settlementLagMs: await readSettlementLag(scope),
    reconciliationDrift: await readReconciliationDrift(scope),
  };
}
