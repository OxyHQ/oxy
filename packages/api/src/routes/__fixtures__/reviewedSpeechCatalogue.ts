// Keep reusable helpers outside __tests__ so Jest does not collect them as a suite.
import { eq } from 'drizzle-orm';
import {
  KAANA_REVIEWED_CANDIDATE_PRIORITY,
  KAANA_SPEECH_MODEL,
  KAANA_SPEECH_MODEL_ID,
  KAANA_SPEECH_MODEL_REFERENCE,
  KAANA_SPEECH_PROVIDERS,
  KAANA_SPEECH_PUBLISHER,
  KAANA_SPEECH_REVISION,
  KAANA_SPEECH_ROUTING_PROFILES,
  kaanaCurrentScorecardReview,
} from '../../config/kaanaInitialCatalogue';
import { getDb } from '../../config/postgres';
import {
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
  inferenceProviders,
  inferencePublishers,
  inferenceRoutingProfileCandidates,
  inferenceRoutingProfiles,
} from '../../db/schema';
import { priceVersions, priceVersionUnitPrices } from '../../db/schema/priceVersions';
import { kaanaReviewedScorecardFields } from '../../scripts/kaanaScorecardRenewal';

/**
 * The reviewed speech catalogue, as `bootstrap-kaana-catalogue.ts` writes it:
 * the exact xAI model, revision, price, deployment, scorecard and the pinned
 * `kaana-v1-speech` profile. Every reviewed field is kept, except that score
 * validity moves relative to NOW so a proof does not expire with the reviewed
 * horizon.
 *
 * Idempotent: suites on one Jest worker share its database, and the reviewed
 * identities are exact (they cannot be suffixed per suite), so a second call
 * finds the deployment and writes nothing.
 */
export async function seedReviewedSpeechCatalogue(reviewerUserId: string): Promise<void> {
  const [provider] = KAANA_SPEECH_PROVIDERS;
  if (provider === undefined) throw new Error('The reviewed speech catalogue has no provider');
  const db = getDb();
  const [existing] = await db
    .select({ id: inferenceDeployments.id })
    .from(inferenceDeployments)
    .where(eq(inferenceDeployments.internalRouteId, provider.deploymentId));
  if (existing !== undefined) return;

  await db.insert(inferencePublishers).values(KAANA_SPEECH_PUBLISHER).onConflictDoNothing();
  const [model] = await db
    .insert(inferenceModels)
    .values({
      ...KAANA_SPEECH_MODEL,
      inputModalities: [...KAANA_SPEECH_MODEL.inputModalities],
      outputModalities: [...KAANA_SPEECH_MODEL.outputModalities],
    })
    .returning({ id: inferenceModels.id, modelId: inferenceModels.modelId });
  if (model.modelId !== KAANA_SPEECH_MODEL_ID) {
    throw new Error(`Seeded ${model.modelId}, expected ${KAANA_SPEECH_MODEL_ID}`);
  }
  const [revision] = await db
    .insert(inferenceModelRevisions)
    .values({
      modelId: model.id,
      ...KAANA_SPEECH_REVISION,
      releasedAt: new Date(KAANA_SPEECH_REVISION.releasedAt),
    })
    .returning({ id: inferenceModelRevisions.id });
  await db
    .insert(inferenceProviders)
    .values({
      slug: provider.slug,
      displayName: provider.displayName,
      kind: 'third_party',
      websiteUrl: provider.websiteUrl,
      retainsPayloads: provider.retainsPayloads,
      retentionDays: provider.retentionDays,
      trainsOnCustomerData: provider.trainsOnCustomerData,
      zeroDataRetentionAvailable: provider.zeroDataRetentionAvailable,
      policyUrl: provider.policyUrl,
    })
    .onConflictDoNothing();
  const [price] = await db
    .insert(priceVersions)
    .values({
      modelReference: KAANA_SPEECH_MODEL_REFERENCE,
      provider: provider.slug,
      status: 'active',
      currency: 'USD',
      effectiveFrom: new Date(provider.priceEffectiveFrom!),
    })
    .returning({ id: priceVersions.id });
  await db
    .insert(priceVersionUnitPrices)
    .values(provider.unitPrices.map((unitPrice) => ({ priceVersionId: price.id, ...unitPrice })));
  await db.insert(inferenceDeployments).values({
    modelRevisionId: revision.id,
    providerSlug: provider.slug,
    regions: [],
    retainsPayloads: provider.retainsPayloads,
    retentionDays: provider.retentionDays,
    trainsOnCustomerData: provider.trainsOnCustomerData,
    zeroDataRetentionAvailable: provider.zeroDataRetentionAvailable,
    policyUrl: provider.policyUrl,
    availabilityScope: 'platform_internal',
    commercialPermission: 'standard_application_use',
    permissionState: 'approved',
    legalReviewStatus: 'approved',
    legalReviewEvidenceRef: provider.legalEvidenceRef,
    legalReviewedAt: new Date(provider.reviewedAt!),
    legalReviewedByUserId: reviewerUserId,
    permissionStateChangedAt: new Date(provider.reviewedAt!),
    permissionStateChangedByUserId: reviewerUserId,
    permissionStateNote: provider.permissionStateNote!,
    status: 'active',
    dedicatedCapacity: false,
    priceVersionId: price.id,
    internalRouteId: provider.deploymentId,
  });
  const reviewed = kaanaReviewedScorecardFields(provider, kaanaCurrentScorecardReview(provider), {
    priceVersionId: price.id,
    reviewerUserId,
  });
  const validUntil = new Date(Date.now() + 3_600_000);
  await db.insert(inferenceDeploymentRoutingScores).values({
    ...reviewed,
    fundingClass: reviewed.fundingClass,
    fundingState: reviewed.fundingState,
    fundingEvidenceRef: reviewed.fundingEvidenceRef,
    latencyValidUntil: validUntil,
    throughputValidUntil: validUntil,
    balancedValidUntil: validUntil,
  });
  for (const profile of KAANA_SPEECH_ROUTING_PROFILES) {
    await db.insert(inferenceRoutingProfiles).values({
      ...profile,
      description: `Oxy-owned ${profile.displayName} routing policy over exact Kaana deployments.`,
      isProductPreset: true,
    });
    await db.insert(inferenceRoutingProfileCandidates).values({
      routingProfileId: profile.id,
      modelId: null,
      modelRevisionId: revision.id,
      priority: KAANA_REVIEWED_CANDIDATE_PRIORITY,
    });
  }
}
