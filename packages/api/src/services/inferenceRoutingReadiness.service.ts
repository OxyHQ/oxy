import { and, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import {
  inferenceDeploymentRoutingScores,
  inferenceDeployments,
  inferenceModelRevisions,
  priceVersionUnitPrices,
} from '../db/schema';

export interface InferenceRoutingReadinessRow {
  readonly deploymentId: string | null;
  readonly currentPriceVersionId: string | null;
  readonly requestUnitPriceVersionId: string | null;
  readonly scorePriceVersionId: string | null;
  readonly price: number | null;
  readonly latency: number | null;
  readonly latencyMeasurementWindowEnd: Date | null;
  readonly latencyValidUntil: Date | null;
  readonly throughput: number | null;
  readonly throughputMeasurementWindowEnd: Date | null;
  readonly throughputValidUntil: Date | null;
  readonly balanced: number | null;
  readonly balancedValidUntil: Date | null;
}

export type InferenceRoutingReadinessAssessment =
  | { readonly status: 'empty' }
  | { readonly status: 'collision'; readonly collisions: readonly [string, number][] }
  | {
      readonly status: 'incomplete';
      readonly routes: readonly InferenceRoutingReadinessRow[];
    }
  | { readonly status: 'ready' };

/** The exact selectable census the deploy gate evaluates. */
export async function readInferenceRoutingReadinessRows(): Promise<
  readonly InferenceRoutingReadinessRow[]
> {
  return getDb()
    .select({
      deploymentId: inferenceDeployments.internalRouteId,
      currentPriceVersionId: inferenceDeployments.priceVersionId,
      requestUnitPriceVersionId: priceVersionUnitPrices.priceVersionId,
      scorePriceVersionId: inferenceDeploymentRoutingScores.priceVersionId,
      price: inferenceDeploymentRoutingScores.priceScore,
      latency: inferenceDeploymentRoutingScores.latencyScore,
      latencyMeasurementWindowEnd: inferenceDeploymentRoutingScores.latencyMeasurementWindowEnd,
      latencyValidUntil: inferenceDeploymentRoutingScores.latencyValidUntil,
      throughput: inferenceDeploymentRoutingScores.throughputScore,
      throughputMeasurementWindowEnd:
        inferenceDeploymentRoutingScores.throughputMeasurementWindowEnd,
      throughputValidUntil: inferenceDeploymentRoutingScores.throughputValidUntil,
      balanced: inferenceDeploymentRoutingScores.balancedScore,
      balancedValidUntil: inferenceDeploymentRoutingScores.balancedValidUntil,
    })
    .from(inferenceDeployments)
    .innerJoin(
      inferenceModelRevisions,
      eq(inferenceDeployments.modelRevisionId, inferenceModelRevisions.id)
    )
    .leftJoin(
      inferenceDeploymentRoutingScores,
      eq(inferenceDeployments.internalRouteId, inferenceDeploymentRoutingScores.deploymentId)
    )
    .leftJoin(
      priceVersionUnitPrices,
      and(
        eq(inferenceDeployments.priceVersionId, priceVersionUnitPrices.priceVersionId),
        eq(priceVersionUnitPrices.unit, 'requests')
      )
    )
    .where(
      and(
        inArray(inferenceDeployments.status, ['active', 'degraded']),
        eq(inferenceDeployments.permissionState, 'approved'),
        inArray(inferenceDeployments.availabilityScope, [
          'public_payg',
          'oxy_hosted',
          'internal_alia',
        ]),
        isNull(inferenceModelRevisions.retiredAt)
      )
    );
}

/** Pure decision used by both the operator command and its non-vacuous tests. */
export function assessInferenceRoutingReadiness(
  rows: readonly InferenceRoutingReadinessRow[],
  now: Date,
  minimumValidUntil: Date
): InferenceRoutingReadinessAssessment {
  if (rows.length === 0) return { status: 'empty' };

  const identityCounts = new Map<string, number>();
  for (const route of rows) {
    if (route.deploymentId !== null) {
      identityCounts.set(route.deploymentId, (identityCounts.get(route.deploymentId) ?? 0) + 1);
    }
  }
  const collisions = [...identityCounts.entries()].filter(([, count]) => count > 1);
  if (collisions.length > 0) return { status: 'collision', collisions };

  const incomplete = rows.filter(
    (route) =>
      route.deploymentId === null ||
      route.price === null ||
      route.currentPriceVersionId === null ||
      route.requestUnitPriceVersionId !== route.currentPriceVersionId ||
      route.scorePriceVersionId !== route.currentPriceVersionId ||
      route.latency === null ||
      route.latencyMeasurementWindowEnd === null ||
      route.latencyMeasurementWindowEnd > now ||
      route.latencyValidUntil === null ||
      route.latencyValidUntil < minimumValidUntil ||
      route.throughput === null ||
      route.throughputMeasurementWindowEnd === null ||
      route.throughputMeasurementWindowEnd > now ||
      route.throughputValidUntil === null ||
      route.throughputValidUntil < minimumValidUntil ||
      route.balanced === null ||
      route.balancedValidUntil === null ||
      route.balancedValidUntil < minimumValidUntil
  );
  return incomplete.length === 0
    ? { status: 'ready' }
    : { status: 'incomplete', routes: incomplete };
}
