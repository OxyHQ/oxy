// Keep reusable helpers outside __tests__ so Jest does not collect them as a suite.
import { getDb } from '../../config/postgres';
import { inferenceDeploymentRoutingScores } from '../../db/schema';
import {
  createRoutingPolicy,
  type RoutingPolicyControls,
} from '../../services/inferenceRoutingPolicy.service';

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
