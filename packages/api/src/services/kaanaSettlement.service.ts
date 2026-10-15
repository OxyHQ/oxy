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
 * ## Priced from the grant, with Kaana's list of that version
 *
 * Kaana reports units and the line that served; it never names a price. The
 * price is the list Kaana DECLARED for that line when the grant was signed: its
 * `priceVersionId` and its unit prices are on the grant
 * (`kaana_grant_admitted_lines`, `kaana_grant_line_unit_prices`), so the charge
 * is computed from exactly that version — a price Kaana publishes later is a
 * new version and never reaches a grant already signed. Oxy's own price tables
 * are not read (Kaana ADR 0002, amendment 2026-10-15; the guard test
 * `kaanaGrantCatalogueGuard.test.ts` holds that).
 *
 * Two things are refused, typed and permanently (`422`), never settled at zero:
 * a unit the list does not price (`unpriced_unit`) and a served line that has
 * no price to rate it at (`model_not_priced`). A line the grant did NOT admit
 * is rated at Kaana's CURRENT declared list for the model that served and
 * recorded as `served_outside_grant`, the evidence of a `policy_violation`; if
 * Kaana's catalogue cannot be read at that moment the settlement is deferred
 * (`503`, redelivered) rather than guessed. The served funding tier is compared
 * with the step's ceiling and a breach is logged (`fundingCeilingBreach`'s
 * rule); the tier never changes the price.
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
  SETTLEMENT_READ_PATH,
  SETTLEMENT_READ_SIGNATURE_DOMAIN,
  type Settlement,
  type SettlementAcknowledgement,
  settlementPageSchema,
  settlementReadQuery,
  signatureInput,
} from '@kaana.ai/contracts/internal';
import type { UsageUnit } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { type KaanaDataPlaneConfig, resolveKaanaDataPlane } from '../config/kaanaDataPlane';
import { resolveKaanaSettlementKeys } from '../config/kaanaSettlementKeys';
import { inferenceMeteredUsage } from '../db/schema/inferenceMeteredUsage';
import { inferenceProviderCostFeedCursors } from '../db/schema/inferenceProviderCostAttempts';
import { type KaanaGrantRow, kaanaGrants } from '../db/schema/kaanaGrants';
import { modelLineOf } from './inferenceEdge.service';
import { type LedgerAttribution, type PriceSnapshotInput, settle } from './inferenceLedger.service';
import { settleMeteredUsage } from './inferenceMeteredUsage.service';
import { recordInferenceUsage } from './inferenceTelemetry.service';
import {
  DeclaredPriceError,
  currentDeclaredCatalogue,
  requirePriceSnapshot,
  unpricedUnits,
} from './kaanaDeclaredCatalogue.service';
import { readGrantLines } from './kaanaGrant.service';
import { logger } from '../utils/logger';
import { tracedFetch } from '../utils/tracedFetch';

export type SettlementResult =
  | { readonly status: 'acknowledged'; readonly acknowledgement: SettlementAcknowledgement }
  /**
   * A settlement Oxy can never apply: it names no grant Oxy issued, a grant it
   * does not match, or something it cannot price (a unit the grant's list does
   * not carry, a model with no list). Permanent, so Kaana's outbox stops
   * redelivering it.
   */
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'unknown-grant'
        | 'grant-mismatch'
        | 'unpriced_unit'
        | 'model_not_priced'
        | 'price_version_changed';
    }
  /**
   * A settlement Oxy cannot apply YET: the price of a line outside the grant is
   * Kaana's current declared list and the catalogue cannot be read right now.
   * Transient: answered `503`, redelivered, never advanced past by the feed.
   */
  | { readonly status: 'deferred'; readonly reason: 'catalogue_unavailable' };

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
  /** The list the charge is computed from, by value. */
  readonly price: PriceSnapshotInput;
  readonly servedOutsideGrant: boolean;
  readonly stepCeiling: string | null;
}

type PricingResult =
  | { readonly status: 'priced'; readonly pricing: Pricing }
  | Extract<SettlementResult, { status: 'rejected' | 'deferred' }>;

/**
 * The list this settlement is billed at, and whether Kaana served inside the
 * grant. The grant's own copy of the list when the served line was admitted;
 * otherwise Kaana's current declared list for the line that served.
 */
async function pricingFor(settlement: Settlement, grant: KaanaGrantRow): Promise<PricingResult> {
  const steps = await readGrantLines(grant.id);
  const servedLine = modelLineOf(settlement.report.resolvedModelReference);
  const servedStep = settlement.servedStep;
  if (servedStep !== undefined) {
    const step = steps.get(servedStep);
    const price = step?.lines.get(servedLine);
    if (step !== undefined && price !== undefined) {
      return {
        status: 'priced',
        pricing: { price, servedOutsideGrant: false, stepCeiling: step.maxFundingTier },
      };
    }
  }
  const nothingServed = servedStep === undefined && settlement.report.units.length === 0;
  if (nothingServed) {
    // Nothing to price: any admitted line's list prices zero units at zero.
    for (const step of steps.values()) {
      for (const price of step.lines.values()) {
        return {
          status: 'priced',
          pricing: { price, servedOutsideGrant: false, stepCeiling: null },
        };
      }
    }
  }
  // Served outside the grant (or a step that does not admit the line): rated at
  // the list Kaana declares NOW for the model that served, and recorded.
  const catalogue = await currentDeclaredCatalogue();
  if (catalogue.status !== 'observed') {
    return { status: 'deferred', reason: 'catalogue_unavailable' };
  }
  const model = catalogue.models.get(servedLine);
  if (model === undefined) return { status: 'rejected', reason: 'model_not_priced' };
  try {
    return {
      status: 'priced',
      pricing: {
        price: requirePriceSnapshot(catalogue, model),
        servedOutsideGrant: true,
        stepCeiling: null,
      },
    };
  } catch (error) {
    if (error instanceof DeclaredPriceError) {
      return {
        status: 'rejected',
        reason:
          error.code === 'price_version_changed' ? 'price_version_changed' : 'model_not_priced',
      };
    }
    throw error;
  }
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

  const priced = await pricingFor(settlement, grant);
  if (priced.status === 'deferred') {
    logger.warn('inference.settlement.deferred', {
      grantId: grant.id,
      settlementId: settlement.settlementId,
      reason: priced.reason,
      source,
    });
    return priced;
  }
  if (priced.status === 'rejected') {
    logger.error('inference.settlement.unpriceable', new Error(`not priceable: ${priced.reason}`), {
      grantId: grant.id,
      settlementId: settlement.settlementId,
      deploymentId: settlement.report.deploymentId,
      reason: priced.reason,
    });
    return priced;
  }
  const { pricing } = priced;
  // A unit the list does not price is a settlement Oxy refuses, typed: it is
  // never a free unit, and nothing is written for it.
  const unpriced = unpricedUnits(pricing.price, unitsOf(settlement));
  if (unpriced.length > 0) {
    logger.error('inference.settlement.unpriced_unit', new Error('a settled unit has no price'), {
      grantId: grant.id,
      settlementId: settlement.settlementId,
      priceVersionId: pricing.price.priceVersionId,
      units: unpriced,
    });
    return { status: 'rejected', reason: 'unpriced_unit' };
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
      priceVersionId: pricing.price.priceVersionId,
      priceSnapshot: pricing.price,
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
    priceVersionId: pricing.price.priceVersionId,
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
const SETTLEMENT_FEED_MAX_BYTES = 8 * 1024 * 1024;
const SETTLEMENT_FEED_MAX_PAGES = 20;
export const SETTLEMENT_FEED_INTERVAL_MS = 60_000;

export interface SettlementFeedReader {
  readPage(cursor: string | null): Promise<{ data: Settlement[]; nextCursor?: string }>;
}

/**
 * The exact bytes Oxy signs for a read of Kaana's settlement outbox: the raw
 * query under `SETTLEMENT_READ_SIGNATURE_DOMAIN`, with the edge key. The domain,
 * the path and the query are Kaana's (`@kaana.ai/contracts/internal`), never
 * restated here — until 2026-10-15 they were, one letter and one path apart,
 * and every read was refused as unsigned.
 */
export function settlementReadSigningInput(
  keyId: string,
  timestamp: number,
  query: string,
): Buffer {
  const digest = createHash('sha256').update(query, 'utf8').digest('hex');
  return Buffer.from(
    signatureInput(SETTLEMENT_READ_SIGNATURE_DOMAIN, keyId, timestamp, digest),
    'utf8',
  );
}

export class HttpKaanaSettlementFeedReader implements SettlementFeedReader {
  constructor(private readonly config: KaanaDataPlaneConfig) {}

  async readPage(cursor: string | null): Promise<{ data: Settlement[]; nextCursor?: string }> {
    const query = settlementReadQuery(cursor);
    const timestamp = Date.now();
    const signature = sign(
      null,
      settlementReadSigningInput(this.config.keyId, timestamp, query),
      this.config.privateKey,
    ).toString('base64');
    const target = query === '' ? SETTLEMENT_READ_PATH : `${SETTLEMENT_READ_PATH}?${query}`;
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
      // Not yet appliable: stop BEFORE the cursor moves past it, so the next
      // read finds it again.
      if (result.status === 'deferred') return { pages, settled, duplicates, rejected };
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
