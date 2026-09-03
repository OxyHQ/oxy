#!/usr/bin/env bun
/**
 * Bootstrap the first reviewed Oxy catalogue backed by exact Kaana deployments.
 *
 * Safe by default: without APPLY=1 the complete transaction is exercised and
 * rolled back. Existing identities are never overwritten; any factual drift is
 * an error that requires a reviewed code change.
 *
 * Required env:
 *   DATABASE_URL
 *   KAANA_CATALOGUE_REVIEWER_USER_ID  existing staff user with catalogue publish
 *   KAANA_INVENTORY_BUCKET            live Kaana inventory bucket
 *   KAANA_INVENTORY_KEY               live Kaana inventory object key
 *   AWS_REGION                        inventory bucket region
 *
 * AWS authentication must come from the dedicated ECS task role in production,
 * or an operator's named AWS profile locally. Static AWS keys in env are refused.
 *   INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS
 *
 * Apply:
 *   APPLY=1 bun run packages/api/scripts/bootstrap-kaana-catalogue.ts
 *
 * If no reviewer exists yet, first follow
 * docs/runbooks/bootstrap-catalogue-reviewer.md. This script never grants its
 * own reviewer authority.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import {
  KAANA_INITIAL_BALANCED_FORMULA_REF,
  KAANA_INITIAL_MODEL,
  KAANA_INITIAL_MODEL_REFERENCE,
  KAANA_INITIAL_PROVIDERS,
  KAANA_INITIAL_PUBLISHER,
  KAANA_INITIAL_REVIEWED_AT,
  KAANA_INITIAL_REVISION,
  KAANA_INITIAL_ROUTING_PROFILES,
  KAANA_INITIAL_SCORECARD_REASON,
  KAANA_INITIAL_SCORE_VALID_UNTIL,
  requireSingleKaanaBootstrapScoreEvent,
  type KaanaInitialProvider,
} from "../src/config/kaanaInitialCatalogue";
import {
  assertKaanaInventoryCredentialSource,
  createKaanaInventoryAbortDeadline,
  KAANA_INITIAL_INVENTORY_FETCH_TIMEOUT_MS,
  readBoundedKaanaInventoryBody,
  validateKaanaInitialInventory,
  type KaanaInitialInventoryAttestation,
} from "../src/config/kaanaInitialInventory";
import { routingScoreValidityThreshold } from "../src/config/inferenceRoutingScoreValidity";
import { closePostgres, connectPostgres, getDb } from "../src/config/postgres";
import {
  inferenceDeploymentRoutingScoreEvents,
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  inferenceRoutingProfileCandidates,
  inferenceRoutingProfiles,
  priceVersionUnitPrices,
  priceVersions,
  users,
} from "../src/db/schema";
import { logger } from "../src/utils/logger";

const APPLY = process.env.APPLY === "1";
// These values are authorities and object identities, not display input. Use
// the exact configured bytes so whitespace or any other mismatch fails closed
// instead of silently selecting a different reviewer or inventory object.
const reviewerUserId = process.env.KAANA_CATALOGUE_REVIEWER_USER_ID;
const inventoryBucket = process.env.KAANA_INVENTORY_BUCKET;
const inventoryKey = process.env.KAANA_INVENTORY_KEY;
const inventoryRegion = process.env.AWS_REGION;

class DryRunRollback extends Error {}

interface BootstrapSummary {
  inventorySnapshotId: string;
  inventoryIssuedAt: string;
  inventoryVersionId: string;
  publisher: string;
  model: string;
  revision: string;
  providers: string[];
  deployments: string[];
  routingProfileIds: string[];
  inserted: string[];
}

type Transaction = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

/**
 * Read the inventory Kaana is actually serving from AWS with the task role.
 *
 * This is deliberately not an env-provided list of IDs and does not derive an
 * ID from provider/model names. A stale local fixture or a plausible-looking
 * string cannot approve a catalogue row: the exact opaque identity must exist
 * in the fresh published snapshot and every bound fact must match byte-for-byte.
 */
async function requireLiveInventory(): Promise<KaanaInitialInventoryAttestation> {
  assertKaanaInventoryCredentialSource(process.env);
  if (!inventoryBucket || !inventoryKey || !inventoryRegion) {
    throw new Error(
      "KAANA_INVENTORY_BUCKET, KAANA_INVENTORY_KEY and AWS_REGION are required",
    );
  }
  const client = new S3Client({ region: inventoryRegion });
  const deadline = createKaanaInventoryAbortDeadline();
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: inventoryBucket, Key: inventoryKey }),
      { abortSignal: deadline.signal },
    );
    if (response.Body === undefined)
      throw new Error("The live Kaana inventory object is empty");
    const body = response.Body as AsyncIterable<Uint8Array>;
    const decoded: unknown = JSON.parse(
      await readBoundedKaanaInventoryBody(body, response.ContentLength),
    );
    return validateKaanaInitialInventory(
      decoded,
      response.VersionId,
      Date.now(),
    );
  } catch (error) {
    if (deadline.signal.aborted) {
      throw new Error(
        `Kaana inventory fetch exceeded ${KAANA_INITIAL_INVENTORY_FETCH_TIMEOUT_MS}ms`,
        { cause: error },
      );
    }
    if (error instanceof SyntaxError) {
      throw new Error("The live Kaana inventory is not valid JSON", {
        cause: error,
      });
    }
    throw error;
  } finally {
    deadline.clear();
    client.destroy();
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "string" && /^-?\d+\.\d+$/.test(value)) {
    return value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, normalize(nested)]),
    );
  }
  return value;
}

function assertFields(
  label: string,
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (
      JSON.stringify(normalize(actualValue)) !==
      JSON.stringify(normalize(expectedValue))
    ) {
      throw new Error(
        `${label}.${key} differs from the reviewed bootstrap: expected ${JSON.stringify(
          normalize(expectedValue),
        )}, found ${JSON.stringify(normalize(actualValue))}`,
      );
    }
  }
}

async function requireReviewer(tx: Transaction): Promise<void> {
  if (reviewerUserId === undefined || reviewerUserId.length === 0) {
    throw new Error("KAANA_CATALOGUE_REVIEWER_USER_ID is required");
  }
  const [reviewer] = await tx
    .select({
      id: users.id,
      isStaff: users.isStaff,
      staffCapabilities: users.staffCapabilities,
    })
    .from(users)
    .where(eq(users.id, reviewerUserId));
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

async function ensurePublisher(
  tx: Transaction,
  inserted: string[],
): Promise<void> {
  const created = await tx
    .insert(inferencePublishers)
    .values(KAANA_INITIAL_PUBLISHER)
    .onConflictDoNothing({ target: inferencePublishers.slug })
    .returning({ slug: inferencePublishers.slug });
  if (created.length > 0)
    inserted.push(`publisher:${KAANA_INITIAL_PUBLISHER.slug}`);

  const [row] = await tx
    .select()
    .from(inferencePublishers)
    .where(eq(inferencePublishers.slug, KAANA_INITIAL_PUBLISHER.slug));
  if (row === undefined)
    throw new Error("The reviewed publisher could not be read after insert");
  assertFields("publisher", row, KAANA_INITIAL_PUBLISHER);
}

async function ensureModel(
  tx: Transaction,
  inserted: string[],
): Promise<string> {
  let [row] = await tx
    .select()
    .from(inferenceModels)
    .where(
      and(
        eq(inferenceModels.publisherSlug, KAANA_INITIAL_MODEL.publisherSlug),
        eq(inferenceModels.slug, KAANA_INITIAL_MODEL.slug),
      ),
    );
  if (row === undefined) {
    [row] = await tx
      .insert(inferenceModels)
      .values({
        ...KAANA_INITIAL_MODEL,
        inputModalities: [...KAANA_INITIAL_MODEL.inputModalities],
        outputModalities: [...KAANA_INITIAL_MODEL.outputModalities],
      })
      .returning();
    inserted.push(
      `model:${KAANA_INITIAL_PUBLISHER.slug}/${KAANA_INITIAL_MODEL.slug}`,
    );
  }
  if (row === undefined)
    throw new Error("The reviewed model could not be created");
  assertFields("model", row, KAANA_INITIAL_MODEL);
  if (
    row.modelId !==
    `${KAANA_INITIAL_PUBLISHER.slug}/${KAANA_INITIAL_MODEL.slug}`
  ) {
    throw new Error(`The generated model identity is invalid: ${row.modelId}`);
  }
  return row.id;
}

async function ensureRevision(
  tx: Transaction,
  modelId: string,
  inserted: string[],
): Promise<string> {
  let [row] = await tx
    .select()
    .from(inferenceModelRevisions)
    .where(
      and(
        eq(inferenceModelRevisions.modelId, modelId),
        eq(inferenceModelRevisions.revision, KAANA_INITIAL_REVISION.revision),
      ),
    );
  if (row === undefined) {
    [row] = await tx
      .insert(inferenceModelRevisions)
      .values({
        modelId,
        ...KAANA_INITIAL_REVISION,
        releasedAt: new Date(KAANA_INITIAL_REVISION.releasedAt),
      })
      .returning();
    inserted.push(`revision:${KAANA_INITIAL_MODEL_REFERENCE}`);
  }
  if (row === undefined)
    throw new Error("The reviewed model revision could not be created");
  assertFields("revision", row, {
    modelId,
    ...KAANA_INITIAL_REVISION,
    releasedAt: new Date(KAANA_INITIAL_REVISION.releasedAt),
  });
  return row.id;
}

async function ensureProvider(
  tx: Transaction,
  provider: KaanaInitialProvider,
  inserted: string[],
): Promise<void> {
  const expected = {
    slug: provider.slug,
    displayName: provider.displayName,
    kind: "third_party" as const,
    websiteUrl: provider.websiteUrl,
    statusPageUrl: provider.statusPageUrl ?? null,
    regions: null,
    retainsPayloads: provider.retainsPayloads,
    retentionDays: provider.retentionDays,
    trainsOnCustomerData: provider.trainsOnCustomerData,
    zeroDataRetentionAvailable: provider.zeroDataRetentionAvailable,
    subprocessors: null,
    policyUrl: provider.policyUrl,
    byokTermsAcknowledgementRequired: false,
    byokTermsUrl: null,
  };
  const created = await tx
    .insert(inferenceProviders)
    .values(expected)
    .onConflictDoNothing({ target: inferenceProviders.slug })
    .returning({ slug: inferenceProviders.slug });
  if (created.length > 0) inserted.push(`provider:${provider.slug}`);

  const [row] = await tx
    .select()
    .from(inferenceProviders)
    .where(eq(inferenceProviders.slug, provider.slug));
  if (row === undefined)
    throw new Error(`Provider ${provider.slug} could not be read`);
  assertFields(`provider:${provider.slug}`, row, expected);
}

async function ensurePriceVersion(
  tx: Transaction,
  provider: KaanaInitialProvider,
  inserted: string[],
): Promise<string> {
  let [row] = await tx
    .select()
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.modelReference, KAANA_INITIAL_MODEL_REFERENCE),
        eq(priceVersions.provider, provider.slug),
        eq(priceVersions.status, "active"),
      ),
    );
  const expected = {
    status: "active" as const,
    modelReference: KAANA_INITIAL_MODEL_REFERENCE,
    provider: provider.slug,
    currency: "USD",
    effectiveFrom: new Date(KAANA_INITIAL_REVIEWED_AT),
    effectiveUntil: null,
    supersedesPriceVersionId: null,
  };
  if (row === undefined) {
    [row] = await tx.insert(priceVersions).values(expected).returning();
    if (row === undefined)
      throw new Error(`Price version for ${provider.slug} was not created`);
    await tx.insert(priceVersionUnitPrices).values(
      provider.unitPrices.map((price) => ({
        priceVersionId: row!.id,
        unit: price.unit,
        amount: price.amount,
        per: price.per,
      })),
    );
    inserted.push(`price:${KAANA_INITIAL_MODEL_REFERENCE}:${provider.slug}`);
  }
  assertFields(`price:${provider.slug}`, row, expected);

  const actualPrices = await tx
    .select({
      unit: priceVersionUnitPrices.unit,
      amount: priceVersionUnitPrices.amount,
      per: priceVersionUnitPrices.per,
    })
    .from(priceVersionUnitPrices)
    .where(eq(priceVersionUnitPrices.priceVersionId, row.id));
  const sortedActual = [...actualPrices].sort((a, b) =>
    a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0,
  );
  const sortedExpected = [...provider.unitPrices].sort((a, b) =>
    a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0,
  );
  if (
    JSON.stringify(normalize(sortedActual)) !==
    JSON.stringify(normalize(sortedExpected))
  ) {
    throw new Error(
      `price:${provider.slug}.unitPrices differs from the reviewed bootstrap`,
    );
  }
  return row.id;
}

async function ensureDeployment(
  tx: Transaction,
  provider: KaanaInitialProvider,
  revisionId: string,
  priceVersionId: string,
  inserted: string[],
): Promise<void> {
  const expected = {
    modelRevisionId: revisionId,
    providerSlug: provider.slug,
    regions: [] as string[],
    retainsPayloads: provider.retainsPayloads,
    retentionDays: provider.retentionDays,
    trainsOnCustomerData: provider.trainsOnCustomerData,
    zeroDataRetentionAvailable: provider.zeroDataRetentionAvailable,
    subprocessors: null,
    policyUrl: provider.policyUrl,
    availabilityScope: "internal_alia" as const,
    commercialPermission: "standard_application_use" as const,
    permissionState: "approved" as const,
    legalReviewStatus: "approved" as const,
    legalReviewEvidenceRef: provider.legalEvidenceRef,
    legalReviewedAt: new Date(KAANA_INITIAL_REVIEWED_AT),
    legalReviewedByUserId: reviewerUserId!,
    permissionStateChangedAt: new Date(KAANA_INITIAL_REVIEWED_AT),
    permissionStateChangedByUserId: reviewerUserId!,
    permissionStateNote:
      "Owner-approved initial internal Alia route; primary-source review 2026-09-02.",
    status: "active" as const,
    dedicatedCapacity: false,
    priceVersionId,
    internalRouteId: provider.deploymentId,
    upstreamWholesaleCostAmount: null,
    upstreamWholesaleCostCurrency: null,
    upstreamWholesaleCostUnit: null,
    upstreamWholesaleCostPer: null,
  };
  let [row] = await tx
    .select()
    .from(inferenceDeployments)
    .where(
      and(
        eq(inferenceDeployments.modelRevisionId, revisionId),
        eq(inferenceDeployments.providerSlug, provider.slug),
        eq(inferenceDeployments.availabilityScope, "internal_alia"),
      ),
    );
  if (row === undefined) {
    [row] = await tx.insert(inferenceDeployments).values(expected).returning();
    inserted.push(`deployment:${provider.deploymentId}`);
  }
  if (row === undefined)
    throw new Error(`Deployment ${provider.deploymentId} was not created`);
  assertFields(`deployment:${provider.deploymentId}`, row, expected);
}

async function ensureScorecard(
  tx: Transaction,
  provider: KaanaInitialProvider,
  priceVersionId: string,
  inserted: string[],
): Promise<void> {
  const reviewedAt = new Date(KAANA_INITIAL_REVIEWED_AT);
  const validUntil = new Date(KAANA_INITIAL_SCORE_VALID_UNTIL);
  if (validUntil < routingScoreValidityThreshold(new Date())) {
    throw new Error(
      `${provider.deploymentId} reviewed scorecard no longer covers the configured minimum validity horizon`,
    );
  }
  const expected = {
    deploymentId: provider.deploymentId,
    priceScore: provider.scores.price,
    priceSource: "reviewed_scorecard" as const,
    priceEvidenceRef: provider.priceEvidenceRef,
    priceVersionId,
    latencyScore: provider.scores.latency,
    latencySource: "reviewed_scorecard" as const,
    latencyEvidenceRef: "not-measured:exact-deployment-bootstrap-2026-09-02",
    latencyMeasurementWindowStart: reviewedAt,
    latencyMeasurementWindowEnd: reviewedAt,
    latencyValidUntil: validUntil,
    throughputScore: provider.scores.throughput,
    throughputSource: "reviewed_scorecard" as const,
    throughputEvidenceRef: provider.performanceEvidenceRef,
    throughputMeasurementWindowStart: reviewedAt,
    throughputMeasurementWindowEnd: reviewedAt,
    throughputValidUntil: validUntil,
    balancedScore: provider.scores.balanced,
    balancedSource: "reviewed_scorecard" as const,
    balancedEvidenceRef: `${provider.priceEvidenceRef};${provider.performanceEvidenceRef}`,
    balancedFormulaRef: KAANA_INITIAL_BALANCED_FORMULA_REF,
    balancedValidUntil: validUntil,
    reason: KAANA_INITIAL_SCORECARD_REASON,
    changedByUserId: reviewerUserId!,
    changedAt: reviewedAt,
  };
  let [row] = await tx
    .select()
    .from(inferenceDeploymentRoutingScores)
    .where(
      eq(inferenceDeploymentRoutingScores.deploymentId, provider.deploymentId),
    );
  if (row === undefined) {
    [row] = await tx
      .insert(inferenceDeploymentRoutingScores)
      .values(expected)
      .returning();
    await tx.insert(inferenceDeploymentRoutingScoreEvents).values({
      ...expected,
      createdAt: reviewedAt,
    });
    inserted.push(`scorecard:${provider.deploymentId}`);
  }
  if (row === undefined)
    throw new Error(`Scorecard ${provider.deploymentId} was not created`);
  assertFields(`scorecard:${provider.deploymentId}`, row, expected);

  // A current row without its immutable provenance event is not "close
  // enough". Refuse the rerun rather than silently repairing history after the
  // fact; the operator must investigate how an audited write was bypassed.
  const events = await tx
    .select()
    .from(inferenceDeploymentRoutingScoreEvents)
    .where(
      and(
        eq(
          inferenceDeploymentRoutingScoreEvents.deploymentId,
          provider.deploymentId,
        ),
        eq(inferenceDeploymentRoutingScoreEvents.createdAt, reviewedAt),
      ),
    );
  const event = requireSingleKaanaBootstrapScoreEvent(
    provider.deploymentId,
    events,
  );
  const { changedAt: _currentRowOnly, ...eventExpected } = expected;
  assertFields(`scorecard-event:${provider.deploymentId}`, event, {
    ...eventExpected,
    createdAt: reviewedAt,
  });
}

async function ensureProfiles(
  tx: Transaction,
  revisionId: string,
  inserted: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const profile of KAANA_INITIAL_ROUTING_PROFILES) {
    let [row] = await tx
      .select()
      .from(inferenceRoutingProfiles)
      .where(eq(inferenceRoutingProfiles.id, profile.id));
    const [slugOwner] = await tx
      .select({ id: inferenceRoutingProfiles.id })
      .from(inferenceRoutingProfiles)
      .where(eq(inferenceRoutingProfiles.slug, profile.slug));
    if (slugOwner !== undefined && slugOwner.id !== profile.id) {
      throw new Error(
        `Routing profile slug ${profile.slug} is already owned by unexpected id ${slugOwner.id}`,
      );
    }
    const expected = {
      ...profile,
      description: `Oxy-owned ${profile.displayName} routing policy over exact Kaana deployments.`,
      isProductPreset: true,
    };
    if (row === undefined) {
      [row] = await tx
        .insert(inferenceRoutingProfiles)
        .values(expected)
        .returning();
      inserted.push(`profile:${profile.slug}`);
    }
    if (row === undefined)
      throw new Error(`Routing profile ${profile.slug} was not created`);
    assertFields(`profile:${profile.slug}`, row, expected);

    let [candidate] = await tx
      .select()
      .from(inferenceRoutingProfileCandidates)
      .where(
        and(
          eq(inferenceRoutingProfileCandidates.routingProfileId, row.id),
          eq(inferenceRoutingProfileCandidates.modelRevisionId, revisionId),
        ),
      );
    const candidateExpected = {
      routingProfileId: row.id,
      modelId: null,
      modelRevisionId: revisionId,
      priority: 100,
    };
    if (candidate === undefined) {
      [candidate] = await tx
        .insert(inferenceRoutingProfileCandidates)
        .values(candidateExpected)
        .returning();
      inserted.push(
        `profile-candidate:${profile.slug}:${KAANA_INITIAL_MODEL_REFERENCE}`,
      );
    }
    if (candidate === undefined)
      throw new Error(`Candidate for ${profile.slug} was not created`);
    assertFields(
      `profile-candidate:${profile.slug}`,
      candidate,
      candidateExpected,
    );
    ids.push(profile.id);
  }
  return ids;
}

async function bootstrap(): Promise<BootstrapSummary> {
  const inventory = await requireLiveInventory();
  await connectPostgres();
  const inserted: string[] = [];
  let summary: BootstrapSummary | undefined;
  try {
    await getDb().transaction(async (tx) => {
      await requireReviewer(tx);
      await ensurePublisher(tx, inserted);
      const modelId = await ensureModel(tx, inserted);
      const revisionId = await ensureRevision(tx, modelId, inserted);

      for (const provider of KAANA_INITIAL_PROVIDERS) {
        await ensureProvider(tx, provider, inserted);
        const priceVersionId = await ensurePriceVersion(tx, provider, inserted);
        await ensureDeployment(
          tx,
          provider,
          revisionId,
          priceVersionId,
          inserted,
        );
        await ensureScorecard(tx, provider, priceVersionId, inserted);
      }
      const routingProfileIds = await ensureProfiles(tx, revisionId, inserted);
      summary = {
        inventorySnapshotId: inventory.snapshotId,
        inventoryIssuedAt: inventory.issuedAt,
        inventoryVersionId: inventory.versionId,
        publisher: KAANA_INITIAL_PUBLISHER.slug,
        model: `${KAANA_INITIAL_PUBLISHER.slug}/${KAANA_INITIAL_MODEL.slug}`,
        revision: KAANA_INITIAL_MODEL_REFERENCE,
        providers: KAANA_INITIAL_PROVIDERS.map((provider) => provider.slug),
        deployments: KAANA_INITIAL_PROVIDERS.map(
          (provider) => provider.deploymentId,
        ),
        routingProfileIds,
        inserted,
      };
      if (!APPLY) throw new DryRunRollback("dry-run rollback");
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  if (summary === undefined)
    throw new Error("Bootstrap transaction produced no summary");
  return summary;
}

bootstrap()
  .then(async (summary) => {
    logger.info(
      APPLY
        ? "Kaana catalogue bootstrap applied"
        : "Kaana catalogue bootstrap dry run",
      {
        ...summary,
        applied: APPLY,
      },
    );
    await closePostgres();
  })
  .catch(async (error: unknown) => {
    logger.error(
      "Kaana catalogue bootstrap failed",
      error instanceof Error ? error : new Error(String(error)),
    );
    await closePostgres().catch(() => undefined);
    process.exit(1);
  });
