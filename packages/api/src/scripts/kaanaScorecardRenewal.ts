/**
 * Same-value validity renewal of the reviewed Kaana routing scorecards.
 *
 * Runtime refuses the complete route set when any selectable route's score is
 * stale, so a scorecard's `validUntil` is a production cliff. The catalogue
 * bootstrap is insert-only and refuses every existing-row difference; this is
 * the one narrow, repo-recorded writer that may move an existing row forward:
 *
 * - only deployments whose reviewed config carries a `scoreRenewal`;
 * - only when the live row equals, field by field, the exact state that
 *   renewal `supersedes` (anything else is drift and refuses the whole run);
 * - only the three validity instants, `reason`, `changedByUserId` and
 *   `changedAt` change; scores, sources, evidence and windows are asserted equal;
 * - every renewal appends one immutable provenance event at `reviewedAt`.
 *
 * A row already at the renewed state is a no-op, so a rerun is idempotent.
 */

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  KAANA_INITIAL_BALANCED_FORMULA_REF,
  KAANA_INITIAL_SCORE_POLICY,
  type KaanaInitialProvider,
  type KaanaScorecardReview,
  kaanaCurrentScorecardReview,
  kaanaScoreMeasuredAt,
  requireSingleKaanaBootstrapScoreEvent,
} from "../config/kaanaInitialCatalogue";
import type { getDb } from "../config/postgres";
import {
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  users,
} from "../db/schema";
import { kaanaBootstrapExistingFundingEvidence } from "./kaanaCatalogueBootstrapPlan";

export type KaanaScorecardTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

export const KAANA_SCORECARD_RENEWAL_OPERATION_PREFIX = "scorecard-renewal:";

/** Every reviewed column of a scorecard row, as the bootstrap writes it. */
export function kaanaReviewedScorecardFields(
  provider: KaanaInitialProvider,
  review: KaanaScorecardReview,
  bindings: {
    readonly priceVersionId: string;
    readonly reviewerUserId: string;
    readonly existingFundingEvidenceRef?: string;
  },
) {
  const measuredAt = new Date(kaanaScoreMeasuredAt(provider));
  const validUntil = new Date(review.validUntil);
  return {
    deploymentId: provider.deploymentId,
    priceScore: provider.scores.price,
    priceSource: "reviewed_scorecard" as const,
    priceEvidenceRef: provider.priceEvidenceRef,
    priceVersionId: bindings.priceVersionId,
    latencyScore: provider.scores.latency,
    latencySource: "reviewed_scorecard" as const,
    latencyEvidenceRef: KAANA_INITIAL_SCORE_POLICY.latencyEvidenceRef,
    latencyMeasurementWindowStart: measuredAt,
    latencyMeasurementWindowEnd: measuredAt,
    latencyValidUntil: validUntil,
    throughputScore: provider.scores.throughput,
    throughputSource: "reviewed_scorecard" as const,
    throughputEvidenceRef: provider.performanceEvidenceRef,
    throughputMeasurementWindowStart: measuredAt,
    throughputMeasurementWindowEnd: measuredAt,
    throughputValidUntil: validUntil,
    balancedScore: provider.scores.balanced,
    balancedSource: "reviewed_scorecard" as const,
    balancedEvidenceRef: `${provider.priceEvidenceRef};${provider.performanceEvidenceRef}`,
    balancedFormulaRef: KAANA_INITIAL_BALANCED_FORMULA_REF,
    balancedValidUntil: validUntil,
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
    reason: review.reason,
    changedByUserId: bindings.reviewerUserId,
    changedAt: new Date(review.changedAt),
  };
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
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
      ([key, value]) =>
        JSON.stringify(normalize(actual[key])) !==
        JSON.stringify(normalize(value)),
    )
    .map(([key]) => key);
}

export type KaanaScorecardRenewalDecision =
  | { readonly action: "current" }
  | { readonly action: "renew" }
  | { readonly action: "drift"; readonly fields: readonly string[] };

/**
 * Pure decision over one live row. Only the exact superseded state may be
 * renewed; a row matching neither state is drift and must never be "fixed".
 */
export function decideKaanaScorecardRenewal(
  row: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  superseded: Readonly<Record<string, unknown>> | undefined,
): KaanaScorecardRenewalDecision {
  const currentDifferences = kaanaScorecardFieldDifferences(row, current);
  if (currentDifferences.length === 0) return { action: "current" };
  if (superseded !== undefined) {
    const supersededDifferences = kaanaScorecardFieldDifferences(row, superseded);
    if (supersededDifferences.length === 0) return { action: "renew" };
  }
  return { action: "drift", fields: currentDifferences };
}

export interface KaanaScorecardRenewalOutcome {
  readonly deploymentId: string;
  readonly action: "current" | "renew";
  readonly fromValidUntil: string;
  readonly toValidUntil: string;
  readonly toChangedAt: string;
}

export async function requireKaanaCatalogueReviewer(
  tx: KaanaScorecardTransaction,
  reviewerUserId: string,
): Promise<void> {
  if (reviewerUserId.length === 0) {
    throw new Error("KAANA_CATALOGUE_REVIEWER_USER_ID is required");
  }
  const rows = await tx
    .select({
      isStaff: users.isStaff,
      staffCapabilities: users.staffCapabilities,
    })
    .from(users)
    .where(eq(users.id, reviewerUserId))
    .for("update");
  const reviewer = rows.length === 1 ? rows[0] : undefined;
  if (
    reviewer === undefined ||
    reviewer.isStaff !== true ||
    !reviewer.staffCapabilities.includes("inference:catalogue:publish")
  ) {
    throw new Error(
      "KAANA_CATALOGUE_REVIEWER_USER_ID must identify staff with inference:catalogue:publish",
    );
  }
}

async function requireOneProvenanceEvent(
  tx: KaanaScorecardTransaction,
  deploymentId: string,
  createdAt: Date,
  expected: Readonly<Record<string, unknown>>,
): Promise<void> {
  const events = await tx
    .select()
    .from(inferenceDeploymentRoutingScoreEvents)
    .where(
      and(
        eq(inferenceDeploymentRoutingScoreEvents.deploymentId, deploymentId),
        eq(inferenceDeploymentRoutingScoreEvents.createdAt, createdAt),
      ),
    )
    .for("update");
  const event = requireSingleKaanaBootstrapScoreEvent(deploymentId, events);
  const { changedAt: _rowOnly, ...eventExpected } = expected;
  const differences = kaanaScorecardFieldDifferences(event, eventExpected);
  if (differences.length > 0) {
    throw new Error(
      `scorecard-event:${deploymentId} at ${createdAt.toISOString()} differs from the reviewed state in: ${differences.join(", ")}`,
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
    /** `routingScoreValidityThreshold(now)`: the minimum acceptable expiry. */
    readonly minimumValidUntil: Date;
  },
): Promise<KaanaScorecardRenewalOutcome[]> {
  const outcomes: KaanaScorecardRenewalOutcome[] = [];
  for (const provider of input.providers) {
    const renewal = provider.scoreRenewal;
    if (renewal === undefined) continue;
    const review = kaanaCurrentScorecardReview(provider);
    if (new Date(review.validUntil) < input.minimumValidUntil) {
      throw new Error(
        `${provider.deploymentId} renewed validity ${review.validUntil} does not cover the configured minimum validity horizon`,
      );
    }
    if (new Date(review.changedAt).getTime() > Date.now()) {
      throw new Error(
        `${provider.deploymentId} renewal reviewedAt ${review.changedAt} is in the future`,
      );
    }

    const deployments = await tx
      .select({ priceVersionId: inferenceDeployments.priceVersionId })
      .from(inferenceDeployments)
      .where(eq(inferenceDeployments.internalRouteId, provider.deploymentId))
      .for("update");
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
      .select()
      .from(inferenceDeploymentRoutingScores)
      .where(eq(inferenceDeploymentRoutingScores.deploymentId, provider.deploymentId))
      .for("update");
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
    const current = kaanaReviewedScorecardFields(provider, review, bindings);
    const superseded = kaanaReviewedScorecardFields(provider, renewal.supersedes, bindings);
    const decision = decideKaanaScorecardRenewal(row, current, superseded);

    if (decision.action === "drift") {
      throw new Error(
        `Scorecard ${provider.deploymentId} matches neither its renewed nor its superseded reviewed state (differs in: ${decision.fields.join(", ")}); refusing to overwrite drift`,
      );
    }
    if (decision.action === "renew") {
      // The superseded state must itself be the product of an audited write.
      await requireOneProvenanceEvent(
        tx,
        provider.deploymentId,
        superseded.changedAt,
        superseded,
      );
      const updated = await tx
        .update(inferenceDeploymentRoutingScores)
        .set({
          latencyValidUntil: current.latencyValidUntil,
          throughputValidUntil: current.throughputValidUntil,
          balancedValidUntil: current.balancedValidUntil,
          reason: current.reason,
          changedByUserId: current.changedByUserId,
          changedAt: current.changedAt,
          updatedAt: new Date(),
        })
        .where(eq(inferenceDeploymentRoutingScores.deploymentId, provider.deploymentId))
        .returning();
      if (
        updated.length !== 1 ||
        kaanaScorecardFieldDifferences(updated[0], current).length > 0
      ) {
        throw new Error(`Scorecard ${provider.deploymentId} renewal did not persist exactly`);
      }
      const { changedAt, ...eventValues } = current;
      await tx
        .insert(inferenceDeploymentRoutingScoreEvents)
        .values({
          ...eventValues,
          // Stated, not only spread: the reviewed economics travel with every
          // routing-score event (routingScoreEconomicsCallsites.test.ts).
          fundingClass: current.fundingClass,
          fundingState: current.fundingState,
          fundingEvidenceRef: current.fundingEvidenceRef,
          createdAt: changedAt,
        });
    }
    await requireOneProvenanceEvent(tx, provider.deploymentId, current.changedAt, current);

    outcomes.push({
      deploymentId: provider.deploymentId,
      action: decision.action,
      fromValidUntil: (decision.action === "renew"
        ? superseded.balancedValidUntil
        : current.balancedValidUntil
      ).toISOString(),
      toValidUntil: current.balancedValidUntil.toISOString(),
      toChangedAt: current.changedAt.toISOString(),
    });
  }
  return outcomes;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
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
    action: "renew-kaana-routing-scores",
    databaseEngine: "postgresql",
    reviewerUserId: input.reviewerUserId,
    outcomes: input.outcomes,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(plan)), "utf8")
    .digest("hex");
}

/** Operation names the workflow allowlists; empty means an idempotent no-op. */
export function kaanaScorecardRenewalOperations(
  outcomes: readonly KaanaScorecardRenewalOutcome[],
): string[] {
  return outcomes
    .filter((outcome) => outcome.action === "renew")
    .map((outcome) => `${KAANA_SCORECARD_RENEWAL_OPERATION_PREFIX}${outcome.deploymentId}`);
}
