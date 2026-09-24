#!/usr/bin/env bun
/**
 * Bootstrap the reviewed Oxy catalogue backed by exact Kaana deployments: the
 * gpt-oss text routes and Alia's xAI text-to-speech route.
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
 * Apply additionally requires the exact matching dry-run authorization:
 *   EXPECTED_PLAN_SHA256
 *   BOOTSTRAP_ACTOR
 *   BOOTSTRAP_REASON
 *
 * AWS authentication must come from the dedicated ECS task role in production,
 * or an operator's named AWS profile locally. Static AWS keys in env are refused.
 *   INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS
 *   KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE_TASK_DEFINITION_ARN
 *   KAANA_CATALOGUE_PLATFORM_SCOPE_BOOTSTRAP_TASK_DEFINITION_ARN
 *   KAANA_CATALOGUE_PLATFORM_SCOPE_IMAGE
 *   KAANA_CATALOGUE_PLATFORM_SCOPE_ATTESTED_AT
 *   KAANA_CATALOGUE_PLATFORM_SCOPE_CLUSTER
 *   KAANA_CATALOGUE_PLATFORM_SCOPE_SERVICE
 *     fresh output from the serialized production workflow after two complete
 *     ECS old-task-zero observations; APPLY binds the dedicated one-shot to its
 *     local metadata, independently repeats the live ECS proof before DB access,
 *     and repeats it inside the transaction immediately before commit
 *
 * Apply:
 *   APPLY=1 EXPECTED_PLAN_SHA256=... BOOTSTRAP_ACTOR=... \
 *     BOOTSTRAP_REASON=... bun run packages/api/scripts/bootstrap-kaana-catalogue.ts
 *
 * If no reviewer exists yet, first follow
 * docs/runbooks/bootstrap-catalogue-reviewer.md. This script never grants its
 * own reviewer authority.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq, sql } from "drizzle-orm";
import { routingScoreValidityThreshold } from "../src/config/inferenceRoutingScoreValidity";
import { assertPlatformScopeWriteRolloutComplete } from "../src/config/inferencePlatformScopeWriteGate";
import {
  KAANA_INITIAL_BALANCED_FORMULA_REF,
  KAANA_INITIAL_MODEL,
  KAANA_INITIAL_PROVIDERS,
  KAANA_INITIAL_PUBLISHER,
  KAANA_INITIAL_REVIEWED_AT,
  KAANA_INITIAL_REVISION,
  KAANA_INITIAL_ROUTING_PROFILES,
  KAANA_INITIAL_SCORECARD_REASON,
  KAANA_INITIAL_SCORE_POLICY,
  KAANA_INITIAL_SCORE_VALID_UNTIL,
  KAANA_REVIEWED_CANDIDATE_PRIORITY,
  KAANA_SPEECH_CATALOGUE,
  KAANA_SPEECH_MODEL,
  KAANA_SPEECH_PROVIDERS,
  KAANA_SPEECH_PUBLISHER,
  KAANA_SPEECH_REVISION,
  KAANA_SPEECH_ROUTING_PROFILES,
  KAANA_TEXT_CATALOGUE,
  type KaanaInitialProvider,
  type KaanaReviewedCatalogueProjection,
  type KaanaReviewedModelCatalogue,
  kaanaCurrentScorecardReview,
  kaanaReviewedCatalogueProjection,
  requireSingleKaanaBootstrapScoreEvent,
} from "../src/config/kaanaInitialCatalogue";
import {
  KAANA_INITIAL_INVENTORY_FETCH_TIMEOUT_MS,
  type KaanaInitialInventoryAttestation,
  assertKaanaInventoryCredentialSource,
  createKaanaInventoryAbortDeadline,
  readBoundedKaanaInventoryBody,
  validateKaanaInitialInventory,
} from "../src/config/kaanaInitialInventory";
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
import {
  createKaanaCatalogueBootstrapPlan,
  createKaanaCatalogueReviewedFactsSha256,
  kaanaBootstrapComparableDeployment,
  requireKaanaCatalogueBootstrapApplyAuthorization,
} from "../src/scripts/kaanaCatalogueBootstrapPlan";
import { kaanaReviewedScorecardFields } from "../src/scripts/kaanaScorecardRenewal";
import { logger } from "../src/utils/logger";

const APPLY = process.env.APPLY === "1";
const RESULT_PREFIX = "KAANA_CATALOGUE_BOOTSTRAP_RESULT=";
const BOOTSTRAP_LOCK_NAMESPACE = "oxy-kaana-catalogue-bootstrap-v1";
// These values are authorities and object identities, not display input. Use
// the exact configured bytes so whitespace or any other mismatch fails closed
// instead of silently selecting a different reviewer or inventory object.
const reviewerUserId = process.env.KAANA_CATALOGUE_REVIEWER_USER_ID ?? "";
const inventoryBucket = process.env.KAANA_INVENTORY_BUCKET;
const inventoryKey = process.env.KAANA_INVENTORY_KEY;
const inventoryRegion = process.env.AWS_REGION;
const expectedPlanSha256 = process.env.EXPECTED_PLAN_SHA256 ?? "";
const bootstrapActor = process.env.BOOTSTRAP_ACTOR ?? "";
const bootstrapReason = process.env.BOOTSTRAP_REASON ?? "";
const REVIEWED_CATALOGUE_FACTS = {
  publisher: KAANA_INITIAL_PUBLISHER,
  model: KAANA_INITIAL_MODEL,
  revision: KAANA_INITIAL_REVISION,
  providers: KAANA_INITIAL_PROVIDERS,
  routingProfiles: KAANA_INITIAL_ROUTING_PROFILES,
  reviewedAt: KAANA_INITIAL_REVIEWED_AT,
  scoreValidUntil: KAANA_INITIAL_SCORE_VALID_UNTIL,
  balancedFormulaRef: KAANA_INITIAL_BALANCED_FORMULA_REF,
  scorecardReason: KAANA_INITIAL_SCORECARD_REASON,
  // Reviewed 2026-09-24. Every policy below applies to it unchanged; its own
  // dates, price, evidence and scores live on its provider entry.
  speech: {
    publisher: KAANA_SPEECH_PUBLISHER,
    model: KAANA_SPEECH_MODEL,
    revision: KAANA_SPEECH_REVISION,
    providers: KAANA_SPEECH_PROVIDERS,
    routingProfiles: KAANA_SPEECH_ROUTING_PROFILES,
  },
  deploymentPolicy: {
    availabilityScope: "platform_internal",
    commercialPermission: "standard_application_use",
    permissionState: "approved",
    legalReviewStatus: "approved",
    status: "active",
    dedicatedCapacity: false,
    regions: [],
    // The exact approval note the first bootstrap wrote on the Cerebras and
    // Groq routes. It records that decision and is never rewritten, so it keeps
    // its original bytes; later routes carry their own note.
    permissionStateNote:
      "Owner-approved initial internal Alia route; primary-source review 2026-09-02.",
    upstreamWholesaleCostAmount: null,
    upstreamWholesaleCostCurrency: null,
    upstreamWholesaleCostUnit: null,
    upstreamWholesaleCostPer: null,
  },
  pricePolicy: {
    status: "active",
    currency: "USD",
    effectiveFrom: KAANA_INITIAL_REVIEWED_AT,
    effectiveUntil: null,
    supersedesPriceVersionId: null,
  },
  scorePolicy: KAANA_INITIAL_SCORE_POLICY,
  candidatePolicy: {
    modelId: null,
    priority: KAANA_REVIEWED_CANDIDATE_PRIORITY,
  },
  profilePolicy: {
    descriptionPrefix: "Oxy-owned ",
    descriptionSuffix: " routing policy over exact Kaana deployments.",
    isProductPreset: true,
  },
} as const;
const reviewedFactsSha256 = createKaanaCatalogueReviewedFactsSha256(
  REVIEWED_CATALOGUE_FACTS,
);

class DryRunRollback extends Error {}

/**
 * The text model keeps its original top-level projection; the speech model is
 * the same projection under `speech`.
 */
interface BootstrapSummary extends KaanaReviewedCatalogueProjection {
  inventorySnapshotId: string;
  inventoryIssuedAt: string;
  inventoryVersionId: string;
  reviewedFactsSha256: string;
  speech: KaanaReviewedCatalogueProjection;
  inserted: string[];
  planSha256: string;
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

function requireAtMostOne<T>(label: string, rows: readonly T[]): T | undefined {
  if (rows.length > 1) {
    throw new Error(`${label} resolves to more than one catalogue row`);
  }
  return rows.at(0);
}

function requireExactlyOne<T>(label: string, rows: readonly T[]): T {
  const row = requireAtMostOne(label, rows);
  if (row === undefined) {
    throw new Error(`${label} did not resolve to one catalogue row`);
  }
  return row;
}

export async function requireReviewer(tx: Transaction): Promise<void> {
  if (reviewerUserId.length === 0) {
    throw new Error("KAANA_CATALOGUE_REVIEWER_USER_ID is required");
  }
  const reviewerRows = await tx
    .select({
      id: users.id,
      isStaff: users.isStaff,
      staffCapabilities: users.staffCapabilities,
    })
    .from(users)
    .where(eq(users.id, reviewerUserId))
    .for("update");
  const reviewer = requireAtMostOne(
    `Reviewer primary key ${reviewerUserId}`,
    reviewerRows,
  );
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
  catalogue: KaanaReviewedModelCatalogue,
  inserted: string[],
): Promise<void> {
  const { publisher } = catalogue;
  const created = await tx
    .insert(inferencePublishers)
    .values(publisher)
    .onConflictDoNothing({ target: inferencePublishers.slug })
    .returning({ slug: inferencePublishers.slug });
  requireAtMostOne("Publisher insert", created);
  if (created.length === 1) inserted.push(`publisher:${publisher.slug}`);

  const rows = await tx
    .select()
    .from(inferencePublishers)
    .where(eq(inferencePublishers.slug, publisher.slug))
    .for("update");
  const row = requireExactlyOne(`Publisher identity ${publisher.slug}`, rows);
  assertFields(`publisher:${publisher.slug}`, row, publisher);
}

async function ensureModel(
  tx: Transaction,
  catalogue: KaanaReviewedModelCatalogue,
  inserted: string[],
): Promise<string> {
  const { model } = catalogue;
  const existingRows = await tx
    .select()
    .from(inferenceModels)
    .where(eq(inferenceModels.modelId, catalogue.modelId))
    .for("update");
  let row = requireAtMostOne(`Model ID ${catalogue.modelId}`, existingRows);
  if (row === undefined) {
    const createdRows = await tx
      .insert(inferenceModels)
      .values({
        ...model,
        inputModalities: [...model.inputModalities],
        outputModalities: [...model.outputModalities],
      })
      .returning();
    row = requireExactlyOne(`Model ID ${catalogue.modelId}`, createdRows);
    inserted.push(`model:${catalogue.publisher.slug}/${model.slug}`);
  }
  assertFields(`model:${catalogue.modelId}`, row, model);
  if (row.modelId !== catalogue.modelId) {
    throw new Error(`The generated model identity is invalid: ${row.modelId}`);
  }
  return row.id;
}

async function ensureRevision(
  tx: Transaction,
  catalogue: KaanaReviewedModelCatalogue,
  modelId: string,
  inserted: string[],
): Promise<string> {
  const { revision, modelReference } = catalogue;
  const existingRows = await tx
    .select()
    .from(inferenceModelRevisions)
    .where(
      and(
        eq(inferenceModelRevisions.modelId, modelId),
        eq(inferenceModelRevisions.revision, revision.revision),
      ),
    )
    .for("update");
  let row = requireAtMostOne(`Model revision ${modelReference}`, existingRows);
  if (row === undefined) {
    const createdRows = await tx
      .insert(inferenceModelRevisions)
      .values({
        modelId,
        ...revision,
        releasedAt: new Date(revision.releasedAt),
      })
      .returning();
    row = requireExactlyOne(`Model revision ${modelReference}`, createdRows);
    inserted.push(`revision:${modelReference}`);
  }
  assertFields(`revision:${modelReference}`, row, {
    modelId,
    ...revision,
    releasedAt: new Date(revision.releasedAt),
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
  requireAtMostOne(`Provider ${provider.slug} insert`, created);
  if (created.length === 1) inserted.push(`provider:${provider.slug}`);

  const rows = await tx
    .select()
    .from(inferenceProviders)
    .where(eq(inferenceProviders.slug, provider.slug))
    .for("update");
  const row = requireExactlyOne(`Provider identity ${provider.slug}`, rows);
  assertFields(`provider:${provider.slug}`, row, expected);
}

async function ensurePriceVersion(
  tx: Transaction,
  modelReference: string,
  provider: KaanaInitialProvider,
  inserted: string[],
): Promise<string> {
  const existingRows = await tx
    .select()
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.modelReference, modelReference),
        eq(priceVersions.provider, provider.slug),
        eq(priceVersions.status, "active"),
      ),
    )
    .for("update");
  let row = requireAtMostOne(
    `Active price ${modelReference}:${provider.slug}`,
    existingRows,
  );
  const expected = {
    status: REVIEWED_CATALOGUE_FACTS.pricePolicy.status,
    modelReference,
    provider: provider.slug,
    currency: REVIEWED_CATALOGUE_FACTS.pricePolicy.currency,
    effectiveFrom: new Date(
      provider.priceEffectiveFrom ??
        REVIEWED_CATALOGUE_FACTS.pricePolicy.effectiveFrom,
    ),
    effectiveUntil: REVIEWED_CATALOGUE_FACTS.pricePolicy.effectiveUntil,
    supersedesPriceVersionId:
      REVIEWED_CATALOGUE_FACTS.pricePolicy.supersedesPriceVersionId,
  };
  if (row === undefined) {
    const createdRows = await tx
      .insert(priceVersions)
      .values(expected)
      .returning();
    const createdRow = requireExactlyOne(
      `Active price ${modelReference}:${provider.slug}`,
      createdRows,
    );
    row = createdRow;
    await tx.insert(priceVersionUnitPrices).values(
      provider.unitPrices.map((price) => ({
        priceVersionId: createdRow.id,
        unit: price.unit,
        amount: price.amount,
        per: price.per,
      })),
    );
    inserted.push(`price:${modelReference}:${provider.slug}`);
  }
  assertFields(`price:${modelReference}:${provider.slug}`, row, expected);

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
    regions: [...REVIEWED_CATALOGUE_FACTS.deploymentPolicy.regions],
    retainsPayloads: provider.retainsPayloads,
    retentionDays: provider.retentionDays,
    trainsOnCustomerData: provider.trainsOnCustomerData,
    zeroDataRetentionAvailable: provider.zeroDataRetentionAvailable,
    subprocessors: null,
    policyUrl: provider.policyUrl,
    availabilityScope:
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.availabilityScope,
    commercialPermission:
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.commercialPermission,
    permissionState: REVIEWED_CATALOGUE_FACTS.deploymentPolicy.permissionState,
    legalReviewStatus:
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.legalReviewStatus,
    legalReviewEvidenceRef: provider.legalEvidenceRef,
    legalReviewedAt: new Date(provider.reviewedAt ?? KAANA_INITIAL_REVIEWED_AT),
    legalReviewedByUserId: reviewerUserId,
    permissionStateChangedAt: new Date(
      provider.reviewedAt ?? KAANA_INITIAL_REVIEWED_AT,
    ),
    permissionStateChangedByUserId: reviewerUserId,
    permissionStateNote:
      provider.permissionStateNote ??
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.permissionStateNote,
    status: REVIEWED_CATALOGUE_FACTS.deploymentPolicy.status,
    dedicatedCapacity:
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.dedicatedCapacity,
    priceVersionId,
    internalRouteId: provider.deploymentId,
    upstreamWholesaleCostAmount:
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.upstreamWholesaleCostAmount,
    upstreamWholesaleCostCurrency:
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.upstreamWholesaleCostCurrency,
    upstreamWholesaleCostUnit:
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.upstreamWholesaleCostUnit,
    upstreamWholesaleCostPer:
      REVIEWED_CATALOGUE_FACTS.deploymentPolicy.upstreamWholesaleCostPer,
  };
  const deploymentRows = await tx
    .select()
    .from(inferenceDeployments)
    .where(eq(inferenceDeployments.internalRouteId, provider.deploymentId))
    .for("update");
  let row = requireAtMostOne(
    `Exact deployment ID ${provider.deploymentId}`,
    deploymentRows,
  );
  if (row === undefined) {
    const createdRows = await tx
      .insert(inferenceDeployments)
      .values(expected)
      .returning();
    row = requireExactlyOne(
      `Exact deployment ID ${provider.deploymentId}`,
      createdRows,
    );
    inserted.push(`deployment:${provider.deploymentId}`);
  }
  // New rows are written as `platform_internal`; an existing row may still
  // hold the legacy `internal_alia` spelling of that scope and is compared, never
  // rewritten, as the scope it means.
  assertFields(
    `deployment:${provider.deploymentId}`,
    kaanaBootstrapComparableDeployment(row),
    expected,
  );
}

async function ensureScorecard(
  tx: Transaction,
  provider: KaanaInitialProvider,
  priceVersionId: string,
  inserted: string[],
): Promise<void> {
  // The scorecard's CURRENT review: after a same-value validity renewal this is
  // the renewal's changedAt/reason/validUntil, never the original review. The
  // bootstrap still never renews an existing row itself; a row left at the
  // superseded state is drift here and is renewed only by
  // scripts/renew-kaana-routing-scores.ts.
  const review = kaanaCurrentScorecardReview(provider);
  const validUntil = new Date(review.validUntil);
  if (validUntil < routingScoreValidityThreshold(new Date())) {
    throw new Error(
      `${provider.deploymentId} reviewed scorecard no longer covers the configured minimum validity horizon`,
    );
  }
  const existingRows = await tx
    .select()
    .from(inferenceDeploymentRoutingScores)
    .where(
      eq(inferenceDeploymentRoutingScores.deploymentId, provider.deploymentId),
    )
    .for("update");
  let row = requireAtMostOne(
    `Scorecard deployment ID ${provider.deploymentId}`,
    existingRows,
  );
  const expected = kaanaReviewedScorecardFields(provider, review, {
    priceVersionId,
    reviewerUserId,
    existingFundingEvidenceRef: row?.fundingEvidenceRef,
  });
  if (row === undefined) {
    const createdRows = await tx
      .insert(inferenceDeploymentRoutingScores)
      .values({
        ...expected,
        // Stated, not only spread: the reviewed economics travel with every
        // routing-score insert (routingScoreEconomicsCallsites.test.ts).
        fundingClass: expected.fundingClass,
        fundingState: expected.fundingState,
        fundingEvidenceRef: expected.fundingEvidenceRef,
      })
      .returning();
    row = requireExactlyOne(
      `Scorecard deployment ID ${provider.deploymentId}`,
      createdRows,
    );
    const { changedAt, ...eventValues } = expected;
    await tx.insert(inferenceDeploymentRoutingScoreEvents).values({
      ...eventValues,
      fundingClass: expected.fundingClass,
      fundingState: expected.fundingState,
      fundingEvidenceRef: expected.fundingEvidenceRef,
      createdAt: changedAt,
    });
    inserted.push(`scorecard:${provider.deploymentId}`);
  }
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
        eq(inferenceDeploymentRoutingScoreEvents.createdAt, expected.changedAt),
      ),
    )
    .for("update");
  const event = requireSingleKaanaBootstrapScoreEvent(
    provider.deploymentId,
    events,
  );
  const { changedAt: _currentRowOnly, ...eventExpected } = expected;
  assertFields(`scorecard-event:${provider.deploymentId}`, event, {
    ...eventExpected,
    createdAt: expected.changedAt,
  });
}

async function ensureProfiles(
  tx: Transaction,
  catalogue: KaanaReviewedModelCatalogue,
  revisionId: string,
  inserted: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const profile of catalogue.routingProfiles) {
    const profileRows = await tx
      .select()
      .from(inferenceRoutingProfiles)
      .where(eq(inferenceRoutingProfiles.id, profile.id))
      .for("update");
    let row = requireAtMostOne(
      `Routing-profile primary key ${profile.id}`,
      profileRows,
    );
    const slugOwnerRows = await tx
      .select({ id: inferenceRoutingProfiles.id })
      .from(inferenceRoutingProfiles)
      .where(eq(inferenceRoutingProfiles.slug, profile.slug))
      .for("update");
    const slugOwner = requireAtMostOne(
      `Routing-profile slug ${profile.slug}`,
      slugOwnerRows,
    );
    if (slugOwner !== undefined && slugOwner.id !== profile.id) {
      throw new Error(
        `Routing profile slug ${profile.slug} is already owned by unexpected id ${slugOwner.id}`,
      );
    }
    const expected = {
      ...profile,
      description: `${REVIEWED_CATALOGUE_FACTS.profilePolicy.descriptionPrefix}${profile.displayName}${REVIEWED_CATALOGUE_FACTS.profilePolicy.descriptionSuffix}`,
      isProductPreset: REVIEWED_CATALOGUE_FACTS.profilePolicy.isProductPreset,
    };
    if (row === undefined) {
      const createdRows = await tx
        .insert(inferenceRoutingProfiles)
        .values(expected)
        .returning();
      row = requireExactlyOne(
        `Routing-profile primary key ${profile.id}`,
        createdRows,
      );
      inserted.push(`profile:${profile.slug}`);
    }
    assertFields(`profile:${profile.slug}`, row, expected);

    let candidateRows = await tx
      .select()
      .from(inferenceRoutingProfileCandidates)
      .where(eq(inferenceRoutingProfileCandidates.routingProfileId, profile.id))
      .for("update");
    const candidateExpected = {
      routingProfileId: row.id,
      modelId: REVIEWED_CATALOGUE_FACTS.candidatePolicy.modelId,
      modelRevisionId: revisionId,
      priority: REVIEWED_CATALOGUE_FACTS.candidatePolicy.priority,
    };
    if (candidateRows.length === 0) {
      const createdCandidates = await tx
        .insert(inferenceRoutingProfileCandidates)
        .values(candidateExpected)
        .returning();
      requireExactlyOne(
        `Routing-profile primary key ${profile.id} candidate`,
        createdCandidates,
      );
      candidateRows = createdCandidates;
      inserted.push(
        `profile-candidate:${profile.slug}:${catalogue.modelReference}`,
      );
    }
    const candidate = requireExactlyOne(
      `Routing-profile primary key ${profile.id} reviewed candidate`,
      candidateRows,
    );
    assertFields(
      `profile-candidate:${profile.slug}`,
      candidate,
      candidateExpected,
    );
    ids.push(profile.id);
  }
  return ids;
}

/**
 * Ensure one reviewed model end to end: publisher, model, revision, every exact
 * route with its price, deployment and scorecard, then its profiles. Returns
 * the projection only after every row was proven equal to the reviewed facts.
 */
export async function ensureCatalogue(
  tx: Transaction,
  catalogue: KaanaReviewedModelCatalogue,
  inserted: string[],
): Promise<KaanaReviewedCatalogueProjection> {
  await ensurePublisher(tx, catalogue, inserted);
  const modelId = await ensureModel(tx, catalogue, inserted);
  const revisionId = await ensureRevision(tx, catalogue, modelId, inserted);
  for (const provider of catalogue.providers) {
    await ensureProvider(tx, provider, inserted);
    const priceVersionId = await ensurePriceVersion(
      tx,
      catalogue.modelReference,
      provider,
      inserted,
    );
    await ensureDeployment(tx, provider, revisionId, priceVersionId, inserted);
    await ensureScorecard(tx, provider, priceVersionId, inserted);
  }
  const routingProfileIds = await ensureProfiles(
    tx,
    catalogue,
    revisionId,
    inserted,
  );
  const projection = kaanaReviewedCatalogueProjection(catalogue);
  if (
    JSON.stringify(routingProfileIds) !==
    JSON.stringify(projection.routingProfileIds)
  ) {
    throw new Error(
      `Routing profiles for ${catalogue.modelReference} differ from the reviewed projection`,
    );
  }
  return projection;
}

async function bootstrap(): Promise<BootstrapSummary> {
  const rolloutGuard = await assertPlatformScopeWriteRolloutComplete(
    APPLY,
    process.env,
  );
  const inventory = await requireLiveInventory();
  await connectPostgres();
  const inserted: string[] = [];
  let summary: BootstrapSummary | undefined;
  try {
    await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${BOOTSTRAP_LOCK_NAMESPACE}, 0))`,
      );
      await requireReviewer(tx);
      const text = await ensureCatalogue(tx, KAANA_TEXT_CATALOGUE, inserted);
      const speech = await ensureCatalogue(
        tx,
        KAANA_SPEECH_CATALOGUE,
        inserted,
      );
      const summaryWithoutPlan = {
        inventorySnapshotId: inventory.snapshotId,
        inventoryIssuedAt: inventory.issuedAt,
        inventoryVersionId: inventory.versionId,
        reviewedFactsSha256,
        ...text,
        speech,
        inserted,
      };
      const { planSha256 } = createKaanaCatalogueBootstrapPlan({
        reviewerUserId,
        inventorySnapshotId: summaryWithoutPlan.inventorySnapshotId,
        reviewedFactsSha256: summaryWithoutPlan.reviewedFactsSha256,
        publisher: summaryWithoutPlan.publisher,
        model: summaryWithoutPlan.model,
        revision: summaryWithoutPlan.revision,
        candidate: summaryWithoutPlan.candidate,
        providers: summaryWithoutPlan.providers,
        deployments: summaryWithoutPlan.deployments,
        routingProfileIds: summaryWithoutPlan.routingProfileIds,
        speech: summaryWithoutPlan.speech,
        wouldInsert: summaryWithoutPlan.inserted,
      });
      requireKaanaCatalogueBootstrapApplyAuthorization({
        apply: APPLY,
        actualPlanSha256: planSha256,
        expectedPlanSha256,
        actor: bootstrapActor,
        reason: bootstrapReason,
      });
      summary = { ...summaryWithoutPlan, planSha256 };
      await rolloutGuard.assertStillComplete();
      if (!APPLY) throw new DryRunRollback("dry-run rollback");
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  } finally {
    rolloutGuard.close();
  }
  if (summary === undefined)
    throw new Error("Bootstrap transaction produced no summary");
  return summary;
}

/** The one-shot entrypoint; the tests import the writer without running it. */
if (require.main === module) {
  bootstrap()
    .then(async (summary) => {
      const result = {
        schemaVersion: 1,
        database: { engine: "postgresql" },
        ...summary,
        applied: APPLY,
      } as const;
      logger.info(
        APPLY
          ? "Kaana catalogue bootstrap applied"
          : "Kaana catalogue bootstrap dry run",
        {
          ...result,
        },
      );
      process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
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
}
