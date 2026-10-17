/**
 * The approval an operator script's APPLY=1 requires: who is applying it, why,
 * and the exact hash of the plan they reviewed in the dry run.
 *
 * A dry run prints the plan and its hash; an apply that names any other hash,
 * or omits the actor or reason, is refused before a single write. Shared by the
 * staff-run provisioning scripts whose writes are reviewed this way
 * (`scripts/provision-safety-consumer.ts`).
 */
export function requireReviewedPlanApproval(
  planSha256: string,
  env: NodeJS.ProcessEnv,
): { actor: string; reason: string } {
  const actor = env.BOOTSTRAP_ACTOR;
  const reason = env.BOOTSTRAP_REASON;
  const expected = env.EXPECTED_PLAN_SHA256;
  if (
    actor === undefined ||
    reason === undefined ||
    actor.length === 0 ||
    reason.length === 0 ||
    actor.trim() !== actor ||
    reason.trim() !== reason ||
    actor.length > 200 ||
    reason.length > 500
  ) {
    throw new Error('APPLY=1 requires exact non-empty BOOTSTRAP_ACTOR and BOOTSTRAP_REASON');
  }
  if (expected !== planSha256) {
    throw new Error(`EXPECTED_PLAN_SHA256 must exactly equal the observed plan hash ${planSha256}`);
  }
  return { actor, reason };
}
