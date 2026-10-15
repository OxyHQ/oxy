/**
 * Settling the grants Oxy signs for `kaana.ai/v1`, exactly once (Kaana ADR
 * 0002, decision 3), and reconciling what never arrived.
 *
 * ## One settlement per grant, whichever way it arrives
 *
 * Kaana writes each settlement into a durable outbox in its own PostgreSQL
 * and delivers it, signed, to `POST /internal/kaana/v1/settlements`; Oxy also
 * reads the same settlements back over `GET kaana.ai/internal/v1/settlements`.
 * Both paths land in {@link applySettlement}, and every write it makes is
 * idempotent on its own key, so a redelivery, a reconciliation of a settlement
 * already delivered, or two deliveries racing on two tasks charge once:
 *
 *  - the ledger's `settle` is keyed on the request's ledger key (a second call
 *    answers `already-settled` with the first receipt);
 *  - `settleMeteredUsage` writes only an `admitted` row;
 *  - the usage event is unique on `(request_id, generation_id)`;
 *  - the grant moves `issued|expired → settled` by compare-and-set, so exactly
 *    one caller is told `settled` and every other `duplicate`.
 *
 * ## Priced from the grant, never from Kaana
 *
 * Kaana reports units and the line that served; it never names a price. The
 * price is the `priceVersionId` the grant admitted for that line at that step
 * (`kaana_grant_admitted_lines`). A line the grant did NOT admit is settled as
 * the edge always settled — at the price of the deployment that served — and
 * recorded as `served_outside_grant`, the evidence of a `policy_violation`.
 * The served funding tier is compared with the step's ceiling and a breach is
 * logged (`fundingCeilingBreach`'s rule); the tier never changes the price.
 *
 * ## What reconciliation adds
 *
 * Holds and usage rows already lapse on their own: `expireReservations`
 * releases a hold at its deadline and an `admitted` usage row stops counting
 * against capacity once it expires. {@link expireLapsedGrants} closes the grant
 * row the same way, and {@link syncKaanaSettlementFeed} reads Kaana's outbox so
 * a settlement whose delivery was lost still settles — late, but once.
 */

import { createHash, sign } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  type Settlement,
  type SettlementAcknowledgement,
  settlementPageSchema,
} from '@kaana.ai/contracts/internal';
import type { UsageUnit } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { type KaanaDataPlaneConfig, resolveKaanaDataPlane } from '../config/kaanaDataPlane';
import { resolveKaanaSettlementKeys } from '../config/kaanaSettlementKeys';
import { inferenceDeployments } from '../db/schema/inferenceDeployments';
import { inferenceMeteredUsage } from '../db/schema/inferenceMeteredUsage';
import { inferenceProviderCostFeedCursors } from '../db/schema/inferenceProviderCostAttempts';
import { type KaanaGrantRow, kaanaGrants } from '../db/schema/kaanaGrants';
import { modelLineOf } from './inferenceEdge.service';
import { type LedgerAttribution, settle } from './inferenceLedger.service';
import { settleMeteredUsage } from './inferenceMeteredUsage.service';
import { recordInferenceUsage } from './inferenceTelemetry.service';
import { readGrantLines } from './kaanaGrant.service';
import { logger } from '../utils/logger';
import { tracedFetch } from '../utils/tracedFetch';

export type SettlementResult =
  | { readonly status: 'acknowledged'; readonly acknowledgement: SettlementAcknowledgement }
  /**
   * A settlement Oxy can never apply: it names no grant Oxy issued, or a grant
   * it does not match. Permanent, so Kaana's outbox stops redelivering it.
   */
  | { readonly status: 'rejected'; readonly reason: 'unknown-grant' | 'grant-mismatch' };

const FUNDING_TIER_ORDER: Readonly<Record<string, number>> = { free: 0, credit: 1, paid: 2 };

function unitsOf(settlement: Settlement): Partial<Record<UsageUnit, number>> {
  const units: Partial<Record<UsageUnit, number>> = {};
  for (const quantity of settlement.report.units) units[quantity.unit] = quantity.quantity;
  return units;
}

/** The status a usage event records for an outcome Kaana reported. */
function statusCodeFor(outcome: Settlement['report']['outcome']): number {
  switch (outcome) {
    case 'completed':
    case 'partial':
      return 200;
    case 'cancelled':
      return 499;
    case 'failed':
      return 502;
  }
}

/** Whether `settlement` names the grant it settles, field for field. */
function matchesGrant(settlement: Settlement, grant: KaanaGrantRow): boolean {
  const meteredExpected =
    grant.economicTreatment === 'internal_metered' ? grant.meteredUsageId : undefined;
  return (
    settlement.requestId === grant.requestId &&
    (settlement.reservationId ?? null) === grant.reservationId &&
    settlement.meteredUsageId === meteredExpected &&
    (settlement.servedStep === undefined || settlement.servedStep <= 7)
  );
}

interface Pricing {
  readonly priceVersionId: string;
  readonly servedOutsideGrant: boolean;
  readonly stepCeiling: string | null;
}

/**
 * The price version this settlement is billed at, and whether Kaana served
 * inside the grant. `undefined` only when the grant admitted nothing priceable
 * and the served deployment is unknown — which no stored grant can be.
 */
async function pricingFor(
  settlement: Settlement,
  grant: KaanaGrantRow,
): Promise<Pricing | undefined> {
  const steps = await readGrantLines(grant.id);
  const servedLine = modelLineOf(settlement.report.resolvedModelReference);
  const servedStep = settlement.servedStep;
  if (servedStep !== undefined) {
    const step = steps.get(servedStep);
    const price = step?.lines.get(servedLine);
    if (step !== undefined && price !== undefined) {
      return { priceVersionId: price, servedOutsideGrant: false, stepCeiling: step.maxFundingTier };
    }
  }
  const nothingServed = servedStep === undefined && settlement.report.units.length === 0;
  if (nothingServed) {
    // Nothing to price: any admitted line's version prices zero units at zero.
    for (const step of steps.values()) {
      for (const price of step.lines.values()) {
        return { priceVersionId: price, servedOutsideGrant: false, stepCeiling: null };
      }
    }
  }
  // Served outside the grant (or a step that does not admit the line): settle
  // as the edge always did, at the served deployment's own price.
  const [deployment] = await getDb()
    .select({ priceVersionId: inferenceDeployments.priceVersionId })
    .from(inferenceDeployments)
    .where(eq(inferenceDeployments.internalRouteId, settlement.report.deploymentId))
    .limit(1);
  if (deployment?.priceVersionId != null) {
    return {
      priceVersionId: deployment.priceVersionId,
      servedOutsideGrant: true,
      stepCeiling: null,
    };
  }
  return undefined;
}

/**
 * Apply one settlement. Idempotent: every call after the first that settled the
 * grant answers `duplicate`, and none of them writes a second charge.
 */
export async function applySettlement(
  settlement: Settlement,
  source: 'delivery' | 'reconciliation',
): Promise<SettlementResult> {
  const db = getDb();
  const [grant] = await db
    .select()
    .from(kaanaGrants)
    .where(eq(kaanaGrants.id, settlement.grantId))
    .limit(1);
  if (grant === undefined) {
    logger.warn('inference.settlement.unknown_grant', { grantId: settlement.grantId, source });
    return { status: 'rejected', reason: 'unknown-grant' };
  }
  if (!matchesGrant(settlement, grant)) {
    logger.error(
      'inference.settlement.grant_mismatch',
      new Error('settlement does not name its grant'),
      {
        grantId: grant.id,
        requestId: grant.requestId,
        settlementId: settlement.settlementId,
        source,
      },
    );
    return { status: 'rejected', reason: 'grant-mismatch' };
  }
  const duplicate = (): SettlementResult => ({
    status: 'acknowledged',
    acknowledgement: {
      schemaVersion: 1,
      settlementId: settlement.settlementId,
      status: 'duplicate',
    },
  });
  if (grant.status === 'settled') {
    if (grant.settlementId !== settlement.settlementId) {
      logger.error('inference.settlement.second_settlement', new Error('a grant settled twice'), {
        grantId: grant.id,
        settled: grant.settlementId,
        received: settlement.settlementId,
      });
    }
    return duplicate();
  }

  const pricing = await pricingFor(settlement, grant);
  if (pricing === undefined) {
    logger.error(
      'inference.settlement.unpriceable',
      new Error('no price version for the served route'),
      {
        grantId: grant.id,
        deploymentId: settlement.report.deploymentId,
      },
    );
    return { status: 'rejected', reason: 'grant-mismatch' };
  }
  const report = settlement.report;
  if (pricing.servedOutsideGrant) {
    logger.error(
      'inference.settlement.policy_violation',
      new Error('Kaana served outside the grant'),
      {
        grantId: grant.id,
        requestId: grant.requestId,
        servedStep: settlement.servedStep,
        deploymentId: report.deploymentId,
      },
    );
  }
  if (
    pricing.stepCeiling !== null &&
    report.fundingTier !== undefined &&
    (FUNDING_TIER_ORDER[report.fundingTier] ?? 0) > (FUNDING_TIER_ORDER[pricing.stepCeiling] ?? 0)
  ) {
    logger.error(
      'inference.settlement.funding_ceiling_breached',
      new Error('a tier above the step ceiling'),
      {
        grantId: grant.id,
        requestId: grant.requestId,
        ceiling: pricing.stepCeiling,
        served: report.fundingTier,
      },
    );
  }

  const [metered] = await db
    .select({ idempotencyKey: inferenceMeteredUsage.idempotencyKey })
    .from(inferenceMeteredUsage)
    .where(eq(inferenceMeteredUsage.id, grant.meteredUsageId))
    .limit(1);
  const units = unitsOf(settlement);
  const attribution: LedgerAttribution = {
    accountId: grant.accountId,
    applicationId: grant.applicationId,
    applicationCredentialId: grant.applicationCredentialId,
    ...(grant.delegatedUserId === null ? {} : { delegatedUserId: grant.delegatedUserId }),
    requestId: grant.requestId,
    environment: grant.environment,
  };

  // The money: only a charged grant, and only against its own hold.
  let usageReceiptId: string | undefined;
  if (grant.reservationId !== null && metered !== undefined) {
    const result = await settle({
      idempotencyKey: metered.idempotencyKey,
      reservationId: grant.reservationId,
      attribution,
      ...(report.generationId === undefined ? {} : { generationId: report.generationId }),
      outcome: report.outcome,
      usageSource: report.usageSource,
      units,
      resolvedModelReference: report.resolvedModelReference,
      servingProvider: report.servingProvider,
      priceVersionId: pricing.priceVersionId,
      platformFeeOnly: grant.economicTreatment === 'platform_fee_only',
      ...(grant.routingPolicyVersionId === null
        ? {}
        : { routingPolicyVersionId: grant.routingPolicyVersionId }),
    });
    if (result.status === 'settled' || result.status === 'already-settled') {
      usageReceiptId = result.receipt.receiptId;
    } else {
      // The same answer the edge gives a settlement it cannot write: logged, and
      // the hold lapses to the sweeper. A refused write is never retried into a
      // second charge.
      logger.error(
        'inference.settlement.ledger_refused',
        new Error(`settlement returned ${result.status}`),
        {
          grantId: grant.id,
          requestId: grant.requestId,
          reservationId: grant.reservationId,
          status: result.status,
        },
      );
    }
  }

  await settleMeteredUsage({
    meteredUsageId: grant.meteredUsageId,
    outcome: report.outcome,
    usageSource: report.usageSource,
    units,
    resolvedModelReference: report.resolvedModelReference,
    servingProvider: report.servingProvider,
    generationId: report.generationId,
    priceVersionId: pricing.priceVersionId,
    ...(usageReceiptId === undefined ? {} : { usageReceiptId }),
  });

  try {
    await recordInferenceUsage({
      accountId: grant.accountId,
      applicationId: grant.applicationId,
      applicationCredentialId: grant.applicationCredentialId,
      ...(grant.delegatedUserId === null ? {} : { delegatedUserId: grant.delegatedUserId }),
      requestId: grant.requestId,
      ...(report.generationId === undefined ? {} : { generationId: report.generationId }),
      environment: grant.environment,
      endpoint: grant.endpoint,
      statusCode: statusCodeFor(report.outcome),
      outcome: report.outcome,
      requestedModelReference: report.resolvedModelReference,
      resolvedModelReference: report.resolvedModelReference,
      servingProvider: report.servingProvider,
      deploymentId: report.deploymentId,
      routeSwitches: report.routeSwitches,
      usageSource: report.usageSource,
      units,
      // From the grant to the end of serving: the whole of what Oxy authorized.
      latencyMs: Math.max(0, Date.parse(report.completedAt) - grant.issuedAt.getTime()),
      ...(report.timeToFirstTokenMs === undefined
        ? {}
        : { timeToFirstTokenMs: report.timeToFirstTokenMs }),
    });
  } catch (error) {
    logger.error(
      'inference.settlement.telemetry_failed',
      error instanceof Error ? error : new Error(String(error)),
      {
        requestId: grant.requestId,
      },
    );
  }

  const closed = await db
    .update(kaanaGrants)
    .set({
      status: 'settled',
      settlementId: settlement.settlementId,
      settledAt: new Date(),
      servedStep: settlement.servedStep ?? null,
      servedOutsideGrant: pricing.servedOutsideGrant,
      servedFundingTier: report.fundingTier ?? null,
    })
    .where(and(eq(kaanaGrants.id, grant.id), inArray(kaanaGrants.status, ['issued', 'expired'])))
    .returning({ id: kaanaGrants.id });
  if (closed.length === 0) return duplicate();

  logger.info('inference.settlement.settled', {
    grantId: grant.id,
    requestId: grant.requestId,
    settlementId: settlement.settlementId,
    outcome: report.outcome,
    source,
    late: grant.status === 'expired',
  });
  return {
    status: 'acknowledged',
    acknowledgement: { schemaVersion: 1, settlementId: settlement.settlementId, status: 'settled' },
  };
}

/* -------------------------------------------------------------------------- */
/*  Reconciliation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How long past its own expiry a grant stays `issued` before the reconciler
 * closes it. Its hold and usage row have lapsed by then already; the grace
 * leaves an in-flight delivery room to land first.
 */
export const GRANT_EXPIRY_GRACE_MS = 5 * 60_000;

/** Close grants nothing settled. A settlement that arrives later still settles them. */
export async function expireLapsedGrants(limit = 500): Promise<number> {
  const lapsed = await getDb()
    .update(kaanaGrants)
    .set({ status: 'expired' })
    .where(
      sql`${kaanaGrants.id} in (
        select ${kaanaGrants.id} from ${kaanaGrants}
        where ${kaanaGrants.status} = 'issued'
          and ${kaanaGrants.expiresAt} < now() - make_interval(secs => ${GRANT_EXPIRY_GRACE_MS / 1000})
        limit ${limit}
      )`,
    )
    .returning({ id: kaanaGrants.id });
  return lapsed.length;
}

/** The feed cursor row Oxy keeps for Kaana's settlement outbox. */
export const SETTLEMENT_FEED_NAME = 'kaana-settlements';
export const SETTLEMENT_FEED_PATH = '/internal/v1/settlements';
/**
 * The domain Oxy signs its read of Kaana's settlement outbox under, with the
 * edge key. The signed bytes are the request target (`path?query`), so a
 * captured read cannot be replayed with another cursor. Kaana verifies it in
 * phase 3, when the endpoint exists (ADR 0002 phase 3.1).
 */
export const SETTLEMENT_READ_DOMAIN = 'oxy-kaana-settlements-read:v1';
const SETTLEMENT_FEED_MAX_BYTES = 8 * 1024 * 1024;
const SETTLEMENT_FEED_MAX_PAGES = 20;
export const SETTLEMENT_FEED_INTERVAL_MS = 60_000;

export interface SettlementFeedReader {
  readPage(cursor: string | null): Promise<{ data: Settlement[]; nextCursor?: string }>;
}

export function settlementReadSigningInput(
  keyId: string,
  timestamp: number,
  target: string,
): Buffer {
  const digest = createHash('sha256').update(target, 'utf8').digest('hex');
  return Buffer.from([SETTLEMENT_READ_DOMAIN, keyId, String(timestamp), digest].join('\n'), 'utf8');
}

export class HttpKaanaSettlementFeedReader implements SettlementFeedReader {
  constructor(private readonly config: KaanaDataPlaneConfig) {}

  async readPage(cursor: string | null): Promise<{ data: Settlement[]; nextCursor?: string }> {
    const target =
      cursor === null
        ? SETTLEMENT_FEED_PATH
        : `${SETTLEMENT_FEED_PATH}?cursor=${encodeURIComponent(cursor)}`;
    const timestamp = Date.now();
    const signature = sign(
      null,
      settlementReadSigningInput(this.config.keyId, timestamp, target),
      this.config.privateKey,
    ).toString('base64');
    const response = await tracedFetch(`${this.config.baseUrl}${target}`, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'cache-control': 'no-store',
        'X-Oxy-Kaana-Key-Id': this.config.keyId,
        'X-Oxy-Kaana-Timestamp': String(timestamp),
        'X-Oxy-Kaana-Signature': `v1=${signature}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await response.text();
    if (raw.length > SETTLEMENT_FEED_MAX_BYTES)
      throw new Error('Kaana settlement feed exceeded its bound');
    if (response.status !== 200)
      throw new Error(`Kaana settlement feed answered ${response.status}`);
    return settlementPageSchema.parse(JSON.parse(raw));
  }
}

async function readSettlementCursor(): Promise<string | null> {
  const [row] = await getDb()
    .select({ cursor: inferenceProviderCostFeedCursors.cursor })
    .from(inferenceProviderCostFeedCursors)
    .where(eq(inferenceProviderCostFeedCursors.feed, SETTLEMENT_FEED_NAME))
    .limit(1);
  return row?.cursor ?? null;
}

/** Compare-and-set, so two tasks reading at once cannot move the cursor backwards. */
async function advanceSettlementCursor(from: string | null, to: string): Promise<boolean> {
  const db = getDb();
  if (from === null) {
    const inserted = await db
      .insert(inferenceProviderCostFeedCursors)
      .values({ feed: SETTLEMENT_FEED_NAME, cursor: to })
      .onConflictDoNothing()
      .returning({ feed: inferenceProviderCostFeedCursors.feed });
    if (inserted.length > 0) return true;
  }
  const updated = await db
    .update(inferenceProviderCostFeedCursors)
    .set({ cursor: to, updatedAt: new Date() })
    .where(
      sql`${inferenceProviderCostFeedCursors.feed} = ${SETTLEMENT_FEED_NAME}
        and ${inferenceProviderCostFeedCursors.cursor} is not distinct from ${from}`,
    )
    .returning({ feed: inferenceProviderCostFeedCursors.feed });
  return updated.length > 0;
}

export interface SettlementFeedSync {
  readonly pages: number;
  readonly settled: number;
  readonly duplicates: number;
  readonly rejected: number;
}

/** Read Kaana's settlement outbox from the stored cursor and apply every settlement in it. */
export async function syncKaanaSettlementFeed(
  reader: SettlementFeedReader,
  maxPages = SETTLEMENT_FEED_MAX_PAGES,
): Promise<SettlementFeedSync> {
  let cursor = await readSettlementCursor();
  let pages = 0;
  let settled = 0;
  let duplicates = 0;
  let rejected = 0;
  while (pages < maxPages) {
    const page = await reader.readPage(cursor);
    pages += 1;
    for (const settlement of page.data) {
      const result = await applySettlement(settlement, 'reconciliation');
      if (result.status === 'rejected') rejected += 1;
      else if (result.acknowledgement.status === 'settled') settled += 1;
      else duplicates += 1;
    }
    const next = page.nextCursor ?? null;
    if (next === null || next === cursor) break;
    if (!(await advanceSettlementCursor(cursor, next))) break;
    cursor = next;
  }
  return { pages, settled, duplicates, rejected };
}

/**
 * Run the expiry and the outbox read on an interval in this task. The outbox
 * read registers only when this deployment both reaches Kaana and trusts its
 * settlement keys — i.e. once Kaana delivers settlements at all (phase 3).
 */
export function startKaanaSettlementSchedule(): { stop(): void } {
  const plane = resolveKaanaDataPlane();
  const reader =
    plane.status === 'configured' && resolveKaanaSettlementKeys().status === 'configured'
      ? new HttpKaanaSettlementFeedReader(plane.config)
      : undefined;
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    (async () => {
      const expired = await expireLapsedGrants();
      if (expired > 0) logger.info('inference.settlement.grants_expired', { count: expired });
      if (reader !== undefined) {
        const result = await syncKaanaSettlementFeed(reader);
        if (result.settled > 0 || result.rejected > 0)
          logger.info('inference.settlement.reconciled', { ...result });
      }
    })()
      .catch((error: unknown) =>
        logger.error(
          'inference.settlement.reconciliation_failed',
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
      .finally(() => {
        running = false;
      });
  };
  const interval = setInterval(tick, SETTLEMENT_FEED_INTERVAL_MS);
  interval.unref();
  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}
