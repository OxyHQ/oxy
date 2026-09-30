/**
 * Test support, not a suite: give an existing approved deployment the complete
 * routing evidence the edge admits on — an active, effective price version for
 * its exact revision-pinned model and provider, and a reviewed price scorecard
 * naming the same exact deployment id and price version.
 *
 * A `servable` catalogue read and a power-level routing profile both list or
 * choose only deployments with this evidence, so a fixture that wants to be
 * LISTED must carry it — exactly as production requires.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import {
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  priceVersions,
  priceVersionUnitPrices,
} from './schema';

export interface ServableEvidenceOptions {
  /** `<publisher>/<model>@<revision>` — what the price version must name. */
  readonly modelReference: string;
  readonly providerSlug: string;
  readonly internalRouteId: string;
  /** Higher is preferred under `optimiseFor: 'price'`. */
  readonly priceScore?: number;
  readonly fundingClass?: 'free_entitlement' | 'discounted_payg' | 'promotional_credit' | 'standard_payg';
  readonly fundingState?: 'available' | 'exhausted' | 'rate_limited' | 'unknown';
  readonly inputPerMillion?: string;
  readonly outputPerMillion?: string;
}

export async function attachServableEvidence(options: ServableEvidenceOptions): Promise<string> {
  const db = getDb();
  const now = Date.now();
  const [priceVersion] = await db
    .insert(priceVersions)
    .values({
      modelReference: options.modelReference,
      provider: options.providerSlug,
      status: 'active',
      currency: 'USD',
      effectiveFrom: new Date(now - 60_000),
    })
    .returning({ id: priceVersions.id });
  await db.insert(priceVersionUnitPrices).values([
    { priceVersionId: priceVersion.id, unit: 'requests', amount: '0', per: 1 },
    {
      priceVersionId: priceVersion.id,
      unit: 'input_tokens',
      amount: options.inputPerMillion ?? '1',
      per: 1_000_000,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'cached_input_tokens',
      amount: options.inputPerMillion ?? '1',
      per: 1_000_000,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'output_tokens',
      amount: options.outputPerMillion ?? '2',
      per: 1_000_000,
    },
    {
      priceVersionId: priceVersion.id,
      unit: 'reasoning_tokens',
      amount: options.outputPerMillion ?? '2',
      per: 1_000_000,
    },
  ]);
  await db
    .update(inferenceDeployments)
    .set({ priceVersionId: priceVersion.id })
    .where(eq(inferenceDeployments.internalRouteId, options.internalRouteId));

  const fundingClass = options.fundingClass ?? 'standard_payg';
  const windowed = fundingClass === 'free_entitlement' || fundingClass === 'promotional_credit';
  await db.insert(inferenceDeploymentRoutingScores).values({
    deploymentId: options.internalRouteId,
    priceScore: options.priceScore ?? 100,
    priceSource: 'reviewed_scorecard',
    priceEvidenceRef: `price-score/${options.internalRouteId}`,
    priceVersionId: priceVersion.id,
    // Only the price dimension is scored — the Kaana sync's own shape.
    latencyScore: null,
    latencySource: 'reviewed_scorecard',
    latencyEvidenceRef: 'not-measured:test',
    latencyMeasurementWindowStart: new Date(now),
    latencyMeasurementWindowEnd: new Date(now),
    latencyValidUntil: new Date(now),
    throughputScore: null,
    throughputSource: 'reviewed_scorecard',
    throughputEvidenceRef: 'not-measured:test',
    throughputMeasurementWindowStart: new Date(now),
    throughputMeasurementWindowEnd: new Date(now),
    throughputValidUntil: new Date(now),
    balancedScore: null,
    balancedSource: 'cost_model',
    balancedEvidenceRef: 'not-computed:test',
    balancedFormulaRef: 'none:test',
    balancedValidUntil: new Date(now),
    fundingClass,
    fundingState: options.fundingState ?? 'available',
    fundingEvidenceRef: `funding/${options.internalRouteId}`,
    ...(windowed
      ? { fundingObservedAt: new Date(now - 60_000), fundingValidUntil: new Date(now + 3_600_000) }
      : {}),
    reason: 'servable evidence test fixture',
    changedByUserId: 'test-suite',
    changedAt: new Date(now),
  });
  return priceVersion.id;
}

export interface CatalogueRouteFixture {
  readonly modelRowId: string;
  /** `<publisher>/<model>` */
  readonly modelId: string;
  readonly revision: string;
  readonly providerSlug: string;
  readonly internalRouteId: string;
}

/**
 * One approved `platform_internal` text route: publisher → model → current
 * revision → provider → deployment, with complete servable evidence unless
 * `evidence: false`. Every identifier is unique per call.
 */
export async function insertCatalogueRoute(
  options: {
    readonly tag?: string;
    readonly evidence?: false | Omit<ServableEvidenceOptions, 'modelReference' | 'providerSlug' | 'internalRouteId'>;
    readonly supportsTools?: boolean;
    readonly reasoningEfforts?: ('low' | 'medium' | 'high')[];
    readonly inputModalities?: ('text' | 'image' | 'audio')[];
    readonly maxContextTokens?: number;
    /** Reuse an existing model line (a second deployment of the same model). */
    readonly sameModelAs?: CatalogueRouteFixture;
  } = {}
): Promise<CatalogueRouteFixture> {
  const db = getDb();
  const tag = `${options.tag ?? 'fx'}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const providerSlug = `prv${tag}`;
  const internalRouteId = `kaana-route-${tag}`;

  let modelRowId: string;
  let modelId: string;
  let revision: string;
  let revisionRowId: string;
  if (options.sameModelAs !== undefined) {
    ({ modelRowId, modelId, revision } = options.sameModelAs);
    const [row] = await db
      .select({ id: inferenceModelRevisions.id })
      .from(inferenceModelRevisions)
      .where(eq(inferenceModelRevisions.modelId, modelRowId));
    revisionRowId = row.id;
  } else {
    const publisherSlug = `pub${tag}`;
    await db.insert(inferencePublishers).values({ slug: publisherSlug, displayName: `Pub ${tag}` });
    const [model] = await db
      .insert(inferenceModels)
      .values({
        publisherSlug,
        slug: `mdl${tag}`,
        displayName: `Model ${tag}`,
        inputModalities: options.inputModalities ?? ['text'],
        outputModalities: ['text'],
        supportsTools: options.supportsTools ?? true,
        supportsParallelToolCalls: false,
        supportsStructuredOutput: true,
        supportsJsonMode: true,
        supportsReasoning: (options.reasoningEfforts ?? []).length > 0,
        reasoningEfforts: options.reasoningEfforts ?? [],
        supportsStreaming: true,
        supportsPromptCaching: false,
        maxContextTokens: options.maxContextTokens ?? 128_000,
        maxOutputTokens: 4096,
        licenseId: 'apache-2.0',
        licenseDisplayName: 'Apache 2.0',
        commercialUseAllowed: true,
        requiresAttribution: false,
        releaseKind: 'open_weight',
      })
      .returning({ id: inferenceModels.id, modelId: inferenceModels.modelId });
    if (model.modelId === null) throw new Error('the generated model id did not compose');
    modelRowId = model.id;
    modelId = model.modelId;
    revision = '2026-01-01';
    const [revisionRow] = await db
      .insert(inferenceModelRevisions)
      .values({ modelId: model.id, revision, releasedAt: new Date(), isCurrent: true })
      .returning({ id: inferenceModelRevisions.id });
    revisionRowId = revisionRow.id;
  }

  await db.insert(inferenceProviders).values({
    slug: providerSlug,
    displayName: `Provider ${tag}`,
    kind: 'third_party',
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  });
  await db.insert(inferenceDeployments).values({
    modelRevisionId: revisionRowId,
    providerSlug,
    regions: [],
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
    availabilityScope: 'platform_internal',
    commercialPermission: 'standard_application_use',
    status: 'active',
    legalReviewStatus: 'approved',
    legalReviewedAt: new Date(),
    legalReviewEvidenceRef: `contract-register/${tag}`,
    permissionState: 'approved',
    internalRouteId,
  });
  if (options.evidence !== false) {
    await attachServableEvidence({
      ...(options.evidence ?? {}),
      modelReference: `${modelId}@${revision}`,
      providerSlug,
      internalRouteId,
    });
  }
  return { modelRowId, modelId, revision, providerSlug, internalRouteId };
}
