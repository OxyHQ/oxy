// Keep reusable helpers outside __tests__ so Jest does not collect them as a suite.
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import {
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  inferenceModels,
} from '../../db/schema';
import {
  createRoutingPolicy,
  type RoutingPolicyControls,
} from '../../services/inferenceRoutingPolicy.service';
import type { KaanaDeploymentAttestation } from '../../services/kaanaClient';

/**
 * Test-only live inventory projection from the same rows a fixture inserted.
 * Individual attestation-failure cases override this with hostile wire shapes;
 * ordinary edge cases use it so adding the production preflight does not make
 * every unrelated billing/routing fixture duplicate route identity by hand.
 */
export async function attestFixtureDeployments(
  deploymentIds: readonly string[]
): Promise<KaanaDeploymentAttestation> {
  const rows = await getDb()
    .select({
      deploymentId: inferenceDeployments.internalRouteId,
      modelId: inferenceModels.modelId,
      revision: inferenceModelRevisions.revision,
      provider: inferenceDeployments.providerSlug,
      regions: inferenceDeployments.regions,
    })
    .from(inferenceDeployments)
    .innerJoin(
      inferenceModelRevisions,
      eq(inferenceModelRevisions.id, inferenceDeployments.modelRevisionId)
    )
    .innerJoin(inferenceModels, eq(inferenceModels.id, inferenceModelRevisions.modelId))
    .where(inArray(inferenceDeployments.internalRouteId, [...deploymentIds]));

  return {
    snapshotId: 'fixture-serving-snapshot',
    deployments: rows.flatMap((row) =>
      row.deploymentId === null
        ? []
        : [
            {
              deploymentId: row.deploymentId,
              modelReference: `${row.modelId}@${row.revision}`,
              provider: row.provider,
              regions: row.regions,
            },
          ]
    ),
  };
}

export function neutralRoutingPolicy(
  overrides: Partial<RoutingPolicyControls> = {}
): RoutingPolicyControls {
  return {
    providerAllowlist: [],
    providerDenylist: [],
    allowedRegions: [],
    deniedRegions: [],
    requireZeroDataRetention: false,
    prohibitTrainingOnCustomerData: false,
    maxPricePerUnit: [],
    optimiseFor: 'balanced',
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: false,
    fallback: { disabled: false, sameModelDeployment: true, authorizedCrossModel: [] },
    byokPreference: 'disabled',
    dedicatedCapacity: 'disabled',
    ...overrides,
  };
}

export async function insertValidRoutingScorecard(input: {
  readonly deploymentId: string;
  readonly priceVersionId: string;
  readonly changedByUserId: string;
  readonly score?: number;
}): Promise<void> {
  const now = Date.now();
  const score = input.score ?? 100;
  await getDb().insert(inferenceDeploymentRoutingScores).values({
    deploymentId: input.deploymentId,
    priceScore: score,
    priceSource: 'reviewed_scorecard',
    priceEvidenceRef: `test-price/${input.deploymentId}`,
    priceVersionId: input.priceVersionId,
    latencyScore: score,
    latencySource: 'reviewed_scorecard',
    latencyEvidenceRef: `test-latency/${input.deploymentId}`,
    latencyMeasurementWindowStart: new Date(now - 120_000),
    latencyMeasurementWindowEnd: new Date(now - 60_000),
    latencyValidUntil: new Date(now + 3_600_000),
    throughputScore: score,
    throughputSource: 'reviewed_scorecard',
    throughputEvidenceRef: `test-throughput/${input.deploymentId}`,
    throughputMeasurementWindowStart: new Date(now - 120_000),
    throughputMeasurementWindowEnd: new Date(now - 60_000),
    throughputValidUntil: new Date(now + 3_600_000),
    balancedScore: score,
    balancedSource: 'reviewed_scorecard',
    balancedEvidenceRef: `test-balanced/${input.deploymentId}`,
    balancedFormulaRef: 'edge-test/v1',
    balancedValidUntil: new Date(now + 3_600_000),
    reason: 'edge runtime test fixture',
    changedByUserId: input.changedByUserId,
    changedAt: new Date(now),
  });
}

export async function createNeutralRoutingPolicy(input: {
  readonly accountId: string;
  readonly applicationId: string;
  readonly overrides?: Partial<RoutingPolicyControls>;
}): Promise<void> {
  const result = await createRoutingPolicy({
    target: {
      kind: 'application',
      accountId: input.accountId,
      applicationId: input.applicationId,
    },
    controls: neutralRoutingPolicy(input.overrides),
    createdByUserId: input.accountId,
  });
  if (result.status !== 'written') {
    throw new Error(`test routing policy was refused: ${result.status}`);
  }
}
