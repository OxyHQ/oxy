/**
 * Minimum evidence lifetime required for a routing cutover or an authoring
 * change that affects a selectable route.
 *
 * There is deliberately no numeric fallback. Operations chooses a horizon that
 * covers its rollout and evidence-refresh SLO, writes it into the task
 * definition, and the readiness/authoring gates refuse activation when it is
 * absent or malformed. Runtime still checks the exact expiry on every request.
 */

export const INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE =
  'INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS';

export function routingScoreMinimumValidityMs(): number {
  const raw = process.env[INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(
      `${INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE} must be configured as a positive integer before routing scorecards can affect selectable traffic`
    );
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(
      `${INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE} must be configured as a positive integer before routing scorecards can affect selectable traffic`
    );
  }
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(
      `${INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE} is too large to represent safely`
    );
  }
  return milliseconds;
}

export function routingScoreValidityThreshold(now: Date): Date {
  const threshold = new Date(now.getTime() + routingScoreMinimumValidityMs());
  if (!Number.isFinite(threshold.getTime())) {
    throw new Error(
      `${INFERENCE_ROUTING_SCORE_MIN_VALIDITY_VARIABLE} produces an invalid validity threshold`
    );
  }
  return threshold;
}
