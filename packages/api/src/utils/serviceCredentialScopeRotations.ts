/**
 * Closed registry of service credential lanes that `ROTATE_SCOPE_MISMATCH`
 * may reconcile by rotation. Each entry binds one exact application id, one
 * environment, one exact credential name and one exact scope set; both the
 * prepare (`create-service-credential.ts`) and finalize
 * (`finalize-service-credential.ts`) phases refuse anything else.
 *
 * Adding an entry is a reviewed authority change: it must match the lane the
 * exact-ID registry in `.github/workflows/provision-service-credential.yml`
 * configures for that application.
 */

export interface RegisteredScopeRotation {
  applicationId: string;
  environment: "production";
  credentialName: string;
  scopes: readonly string[];
}

export const REGISTERED_SCOPE_ROTATIONS: readonly RegisteredScopeRotation[] =
  Object.freeze([
    // Alia: the exact named lane predates capabilities:read, the
    // coordinator's capability-tickets:issue and its web search's
    // clarity:search.
    Object.freeze({
      applicationId: "6a2f851751b784a86fd0e934",
      environment: "production",
      credentialName: "Oxy service (production)",
      scopes: Object.freeze([
        "user:read",
        "inference:invoke",
        "capabilities:read",
        "capability-tickets:issue",
        "clarity:search",
      ]),
    }),
    // Homiio: the production service lane predates reputation:write +
    // inference:invoke and has no running consumer to roll.
    Object.freeze({
      applicationId: "6a2f851751b784a86fd0e922",
      environment: "production",
      credentialName: "Service (production)",
      scopes: Object.freeze(["reputation:write", "inference:invoke"]),
    }),
  ]);

export function hasExactRegisteredScopes(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const actualSet = new Set(actual);
  return (
    actual.length === expected.length &&
    actualSet.size === expected.length &&
    expected.every((scope) => actualSet.has(scope))
  );
}

/** The registered rotation lane for one exact application id, if any. */
export function findRegisteredScopeRotation(
  applicationId: string | undefined,
): RegisteredScopeRotation | undefined {
  return REGISTERED_SCOPE_ROTATIONS.find(
    (entry) => entry.applicationId === applicationId,
  );
}

/** True only when every field matches one registered rotation lane exactly. */
export function isRegisteredScopeRotation(lane: {
  applicationId: string | undefined;
  environment: string;
  credentialName: string;
  scopes: readonly string[];
}): boolean {
  const entry = findRegisteredScopeRotation(lane.applicationId);
  return (
    entry !== undefined &&
    lane.environment === entry.environment &&
    lane.credentialName === entry.credentialName &&
    hasExactRegisteredScopes(lane.scopes, entry.scopes)
  );
}
