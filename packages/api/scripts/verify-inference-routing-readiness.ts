/**
 * Fail the Kaana cutover unless every selectable Oxy route can be ordered.
 *
 * Runtime and this gate both require current evidence even for a single route;
 * missing data is never implicit authorization. The cutover gate is stronger:
 * every selectable route must also retain enough validity to cover the
 * operator-configured rollout and evidence-refresh horizon.
 */

import { closePostgres, connectPostgres } from '../src/config/postgres';
import { routingScoreValidityThreshold } from '../src/config/inferenceRoutingScoreValidity';
import {
  assessInferenceRoutingReadiness,
  readInferenceRoutingReadinessRows,
} from '../src/services/inferenceRoutingReadiness.service';

async function main(): Promise<void> {
  await connectPostgres();

  try {
    const selectable = await readInferenceRoutingReadinessRows();
    const now = new Date();
    const minimumValidUntil = routingScoreValidityThreshold(now);
    const assessment = assessInferenceRoutingReadiness(selectable, now, minimumValidUntil);

    if (assessment.status === 'empty') {
      process.stderr.write(
        'Kaana routing readiness FAILED: the selectable route census is empty, so score coverage cannot be proven.\n'
      );
      process.exitCode = 1;
    } else if (assessment.status === 'collision') {
      const identities = assessment.collisions
        .slice(0, 20)
        .map(([deploymentId, count]) => `${deploymentId} (${count})`)
        .join(', ');
      process.stderr.write(
        `Kaana routing readiness FAILED: ${assessment.collisions.length} deployment identity collision(s) are simultaneously visible to the internal-viewer scope superset. Runtime refuses every duplicate exact deploymentId, even when metadata matches, until a viewer-aware cross-scope commercial contract exists. First identities: ${identities}\n`
      );
      process.exitCode = 1;
    } else if (assessment.status === 'incomplete') {
      const identities = assessment.routes
        .slice(0, 20)
        .map((route) => route.deploymentId ?? '<unmapped>')
        .join(', ');
      process.stderr.write(
        `Kaana routing readiness FAILED: ${assessment.routes.length} selectable route(s) lack an exact deploymentId, an explicit requests unit price, a complete score, the current priceVersionId, or live non-future evidence. First identities: ${identities}\n`
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        'Kaana routing readiness passed: every selectable route has an exact deploymentId, an explicit requests unit price, all four explicit scores, the current priceVersionId and evidence covering INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS. Run this command periodically and alert on any failure before evidence expiry.\n'
      );
    }
  } finally {
    await closePostgres();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Kaana routing readiness FAILED before completion: ${message}\n`);
  process.exitCode = 1;
});
