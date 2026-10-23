/**
 * Same-value validity renewal of the reviewed Kaana routing scorecards.
 *
 * Runtime refuses the complete route set when any selectable route's score is
 * stale, so a scorecard's `validUntil` is a production cliff. The catalogue
 * bootstrap never moves an existing row; this is the one narrow writer that may:
 *
 * - every reviewed deployment (text, speech and voice) is renewed together;
 * - the live row's reviewed values (scores, sources, evidence, measurement
 *   windows, funding, price version) must equal the reviewed config, and its
 *   current validity must be the product of an audited write (exactly one
 *   provenance event at its `changedAt`); anything else is drift and refuses
 *   the whole run;
 * - only the three validity instants, `reason`, `changedByUserId` and
 *   `changedAt` change, to `kaanaScorecardRenewalReview(now)`: the run's UTC
 *   day plus the reviewed validity window, never a date written in source;
 * - every renewal appends one immutable provenance event at that `changedAt`.
 *
 * A row already valid until the renewed instant is a no-op, so a rerun is
 * idempotent.
 */

import { createHash } from 'node:crypto';
import { and, eq, getTableColumns } from 'drizzle-orm';
import {
  KAANA_INITIAL_BALANCED_FORMULA_REF,
  KAANA_INITIAL_SCORE_POLICY,
  type KaanaInitialProvider,
  type KaanaScorecardReview,
  kaanaScoreMeasuredAt,
  requireSingleKaanaBootstrapScoreEvent,
} from '../config/kaanaInitialCatalogue';
import type { getDb } from '../config/postgres';
import {
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  users,
} from '../db/schema';
import { kaanaBootstrapExistingFundingEvidence } from './kaanaCatalogueBootstrapPlan';

export type KaanaScorecardTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0];

export const KAANA_SCORECARD_RENEWAL_OPERATION_PREFIX = 'scorecard-renewal:';

export interface KaanaScorecardBindings {
  readonly priceVersionId: string;
  readonly reviewerUserId: string;
  readonly existingFundingEvidenceRef?: string;
}

/**
 * The reviewed VALUES of a scorecard row: every reviewed column except its
 * validity (the three `validUntil` instants, `reason`, `changedByUserId`,
 * `changedAt`), which the bootstrap writes once and only a renewal moves.
 */
export function kaanaReviewedScorecardValues(
  provider: KaanaInitialProvider,
  bindings: KaanaScorecardBindings,
) {
  const measuredAt = new Date(kaanaScoreMeasuredAt(provider));
  return {
    deploymentId: provider.deploymentId,
    priceScore: provider.scores.price,
    priceSource: 'reviewed_scorecard' as const,
    priceEvidenceRef: provider.priceEvidenceRef,
    priceVersionId: bindings.priceVersionId,
    latencyScore: provider.scores.latency,
    latencySource: 'reviewed_scorecard' as const,
    latencyEvidenceRef: KAANA_INITIAL_SCORE_POLICY.latencyEvidenceRef,
    latencyMeasurementWindowStart: measuredAt,
    latencyMeasurementWindowEnd: measuredAt,
    throughputScore: provider.scores.throughput,
    throughputSource: 'reviewed_scorecard' as const,
    throughputEvidenceRef: provider.performanceEvidenceRef,
    throughputMeasurementWindowStart: measuredAt,
    throughputMeasurementWindowEnd: measuredAt,
    balancedScore: provider.scores.balanced,
    balancedSource: 'reviewed_scorecard' as const,
    balancedEvidenceRef: `${provider.priceEvidenceRef};${provider.performanceEvidenceRef}`,
    balancedFormulaRef: KAANA_INITIAL_BALANCED_FORMULA_REF,
    fundingClass: KAANA_INITIAL_SCORE_POLICY.fundingClass,
    fundingState: KAANA_INITIAL_SCORE_POLICY.fundingState,
    fundingEvidenceRef: kaanaBootstrapExistingFundingEvidence(
      provider.deploymentId,
      provider.priceEvidenceRef,
      bindings.existingFundingEvidenceRef,
    ),
    fundingRemaining: null,
    fundingRemainingUnit: null,
    fundingObservedAt: null,
    fundingValidUntil: null,
  };
}

/** Every reviewed column of a scorecard row written with `review`'s validity. */
export function kaanaReviewedScorecardFields(
  provider: KaanaInitialProvider,
  review: KaanaScorecardReview,
  bindings: KaanaScorecardBindings,
) {
  const validUntil = new Date(review.validUntil);
  return {
    ...kaanaReviewedScorecardValues(provider, bindings),
    latencyValidUntil: validUntil,
    throughputValidUntil: validUntil,
    balancedValidUntil: validUntil,
    reason: review.reason,
    changedByUserId: bindings.reviewerUserId,
    changedAt: new Date(review.changedAt),
  };
}

/** The validity columns of a live scorecard row. */
export interface KaanaScorecardValidity {
  readonly latencyValidUntil: Date;
  readonly throughputValidUntil: Date;
  readonly balancedValidUntil: Date;
  readonly reason: string;
  readonly changedByUserId: string;
  readonly changedAt: Date;
}

/** The complete reviewed state a live row holds: reviewed values, its own validity. */
export function kaanaScorecardRowState(
  values: ReturnType<typeof kaanaReviewedScorecardValues>,
  row: KaanaScorecardValidity,
) {
  return {
    ...values,
    latencyValidUntil: row.latencyValidUntil,
    throughputValidUntil: row.throughputValidUntil,
    balancedValidUntil: row.balancedValidUntil,
    reason: row.reason,
    changedByUserId: row.changedByUserId,
    changedAt: row.changedAt,
  };
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

/** Names of every expected field the actual row does not hold exactly. */
export function kaanaScorecardFieldDifferences(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): string[] {
  return Object.entries(expected)
    .filter(
      ([key, value]) => JSON.stringify(normalize(actual[key])) !== JSON.stringify(normalize(value)),
    )
    .map(([key]) => key);
}

export type KaanaScorecardRenewalDecision =
  | { readonly action: 'current' }
  | { readonly action: 'renew' }
  | { readonly action: 'drift'; readonly fields: readonly string[] };

/**
 * Pure decision over one live row. A row whose reviewed values differ, whose
 * three validity instants disagree, or that changed after the renewal's
 * instant is drift and must never be "fixed"; a row already valid until the
 * renewed instant is current; every other row is renewed.
 */
export function decideKaanaScorecardRenewal(
  row: Readonly<Record<string, unknown>> & KaanaScorecardValidity,
  values: Readonly<Record<string, unknown>>,
  renewal: { readonly validUntil: Date; readonly changedAt: Date },
): KaanaScorecardRenewalDecision {
  const valueDifferences = kaanaScorecardFieldDifferences(row, values);
  if (valueDifferences.length > 0) return { action: 'drift', fields: valueDifferences };
  const validityDifferences = kaanaScorecardFieldDifferences(row, {
    latencyValidUntil: row.balancedValidUntil,
    throughputValidUntil: row.balancedValidUntil,
  });
  if (validityDifferences.length > 0) return { action: 'drift', fields: validityDifferences };
  if (row.balancedValidUntil.getTime() >= renewal.validUntil.getTime()) {
    return { action: 'current' };
  }
  if (row.changedAt.getTime() > renewal.changedAt.getTime()) {
    return { action: 'drift', fields: ['changedAt'] };
  }
  return { action: 'renew' };
}

export interface KaanaScorecardRenewalOutcome {
  readonly deploymentId: string;
  readonly action: 'current' | 'renew';
  readonly fromValidUntil: string;
  readonly toValidUntil: string;
  readonly toChangedAt: string;
}

export async function requireKaanaCatalogueReviewer(
  tx: KaanaScorecardTransaction,
  reviewerUserId: string,
): Promise<void> {
  if (reviewerUserId.length === 0) {
    throw new Error('KAANA_CATALOGUE_REVIEWER_USER_ID is required');
  }
  const rows = await tx
    .select({
      isStaff: users.isStaff,
      staffCapabilities: users.staffCapabilities,
    })
    .from(users)
    .where(eq(users.id, reviewerUserId))
    .for('update');
  const reviewer = rows.length === 1 ? rows[0] : undefined;
  if (
    reviewer === undefined ||
    reviewer.isStaff !== true ||
    !reviewer.staffCapabilities.includes('inference:catalogue:publish')
  ) {
    throw new Error(
      'KAANA_CATALOGUE_REVIEWER_USER_ID must identify staff with inference:catalogue:publish',
    );
  }
}

/**
 * A scorecard state is real only as the product of an audited write: exactly
 * one append-only event at its `changedAt`, holding every other column.
 */
export async function requireKaanaScorecardProvenanceEvent(
  tx: KaanaScorecardTransaction,
  deploymentId: string,
  expected: Readonly<Record<string, unknown>> & { readonly changedAt: Date },
): Promise<void> {
  const createdAt = expected.changedAt;
  // Named columns, not `.select()`: every column of the score tables is
  // staff-only (protectedColumns.ts), and this staff script reads them all
  // deliberately to compare the whole scorecard.
  const events = await tx
    .select(getTableColumns(inferenceDeploymentRoutingScoreEvents))
    .from(inferenceDeploymentRoutingScoreEvents)
    .where(
      and(
        eq(inferenceDeploymentRoutingScoreEvents.deploymentId, deploymentId),
        eq(inferenceDeploymentRoutingScoreEvents.createdAt, createdAt),
      ),
    )
    .for('update');
  const event = requireSingleKaanaBootstrapScoreEvent(deploymentId, events);
  const { changedAt: _rowOnly, ...eventExpected } = expected;
  const differences = kaanaScorecardFieldDifferences(event, eventExpected);
  if (differences.length > 0) {
    throw new Error(
      `scorecard-event:${deploymentId} at ${createdAt.toISOString()} differs from the reviewed state in: ${differences.join(', ')}`,
    );
  }
}

/**
 * Renew every listed provider's scorecard inside the caller's transaction.
 * The caller owns the advisory lock, the dry-run rollback and apply authority.
 */
export async function renewKaanaRoutingScorecards(
  tx: KaanaScorecardTransaction,
  input: {
    readonly providers: readonly KaanaInitialProvider[];
    readonly reviewerUserId: string;
    /** `kaanaScorecardRenewalReview(now)`: the validity every row is renewed to. */
    readonly renewal: KaanaScorecardReview;
    /** `routingScoreValidityThreshold(now)`: the minimum acceptable expiry. */
    readonly minimumValidUntil: Date;
  },
): Promise<KaanaScorecardRenewalOutcome[]> {
  const renewal = {
    validUntil: new Date(input.renewal.validUntil),
    changedAt: new Date(input.renewal.changedAt),
  };
  if (renewal.validUntil < input.minimumValidUntil) {
    throw new Error(
      `renewed validity ${input.renewal.validUntil} does not cover the configured minimum validity horizon`,
    );
  }
  if (renewal.changedAt.getTime() > Date.now()) {
    throw new Error(`renewal changedAt ${input.renewal.changedAt} is in the future`);
  }

  const outcomes: KaanaScorecardRenewalOutcome[] = [];
  for (const provider of input.providers) {
    const deployments = await tx
      .select({ priceVersionId: inferenceDeployments.priceVersionId })
      .from(inferenceDeployments)
      .where(eq(inferenceDeployments.internalRouteId, provider.deploymentId))
      .for('update');
    if (deployments.length !== 1) {
      throw new Error(
        `Exact deployment ID ${provider.deploymentId} must resolve to one catalogue row; found ${deployments.length}`,
      );
    }
    const priceVersionId = deployments[0].priceVersionId;
    if (priceVersionId === null) {
      throw new Error(
        `Exact deployment ID ${provider.deploymentId} has no price version; its scorecard cannot be renewed`,
      );
    }

    const rows = await tx
      .select(getTableColumns(inferenceDeploymentRoutingScores))
      .from(inferenceDeploymentRoutingScores)
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, provider.deploymentId))
      .for('update');
    if (rows.length !== 1) {
      throw new Error(
        `Scorecard ${provider.deploymentId} must exist exactly once before it can be renewed; found ${rows.length}`,
      );
    }
    const row = rows[0];
    const bindings = {
      priceVersionId,
      reviewerUserId: input.reviewerUserId,
      existingFundingEvidenceRef: row.fundingEvidenceRef,
    };
    const values = kaanaReviewedScorecardValues(provider, bindings);
    const decision = decideKaanaScorecardRenewal(row, values, renewal);
    if (decision.action === 'drift') {
      throw new Error(
        `Scorecard ${provider.deploymentId} is not a reviewed state this renewal may move forward (differs in: ${decision.fields.join(', ')}); refusing to overwrite drift`,
      );
    }
    // The state being kept or replaced must itself be the product of an audited write.
    await requireKaanaScorecardProvenanceEvent(
      tx,
      provider.deploymentId,
      kaanaScorecardRowState(values, row),
    );

    let state: KaanaScorecardValidity = row;
    if (decision.action === 'renew') {
      const renewed = kaanaReviewedScorecardFields(provider, input.renewal, bindings);
      const updated = await tx
        .update(inferenceDeploymentRoutingScores)
        .set({
          latencyValidUntil: renewed.latencyValidUntil,
          throughputValidUntil: renewed.throughputValidUntil,
          balancedValidUntil: renewed.balancedValidUntil,
          reason: renewed.reason,
          changedByUserId: renewed.changedByUserId,
          changedAt: renewed.changedAt,
          updatedAt: new Date(),
        })
        .where(eq(inferenceDeploymentRoutingScores.deploymentId, provider.deploymentId))
        .returning();
      if (updated.length !== 1 || kaanaScorecardFieldDifferences(updated[0], renewed).length > 0) {
        throw new Error(`Scorecard ${provider.deploymentId} renewal did not persist exactly`);
      }
      const { changedAt, ...eventValues } = renewed;
      await tx.insert(inferenceDeploymentRoutingScoreEvents).values({
        ...eventValues,
        // Stated, not only spread: the reviewed economics travel with every
        // routing-score event (routingScoreEconomicsCallsites.test.ts).
        fundingClass: renewed.fundingClass,
        fundingState: renewed.fundingState,
        fundingEvidenceRef: renewed.fundingEvidenceRef,
        createdAt: changedAt,
      });
      await requireKaanaScorecardProvenanceEvent(tx, provider.deploymentId, renewed);
      state = renewed;
    }

    outcomes.push({
      deploymentId: provider.deploymentId,
      action: decision.action,
      fromValidUntil: row.balancedValidUntil.toISOString(),
      toValidUntil: state.balancedValidUntil.toISOString(),
      toChangedAt: state.changedAt.toISOString(),
    });
  }
  return outcomes;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

/** Deterministic plan identity an apply must repeat exactly. */
export function createKaanaScorecardRenewalPlanSha256(input: {
  readonly reviewerUserId: string;
  readonly outcomes: readonly KaanaScorecardRenewalOutcome[];
}): string {
  const plan = {
    schemaVersion: 1,
    action: 'renew-kaana-routing-scores',
    databaseEngine: 'postgresql',
    reviewerUserId: input.reviewerUserId,
    outcomes: input.outcomes,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(plan)), 'utf8')
    .digest('hex');
}

/** Operation names the workflow allowlists; empty means an idempotent no-op. */
export function kaanaScorecardRenewalOperations(
  outcomes: readonly KaanaScorecardRenewalOutcome[],
): string[] {
  return outcomes
    .filter((outcome) => outcome.action === 'renew')
    .map((outcome) => `${KAANA_SCORECARD_RENEWAL_OPERATION_PREFIX}${outcome.deploymentId}`);
}
