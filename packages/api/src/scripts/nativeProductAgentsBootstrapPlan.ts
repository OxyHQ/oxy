import { createHash } from 'node:crypto';

export interface NativeProductBootstrapPlan {
  manifestVersion: number;
  direction: 'bootstrap' | 'rollback';
  /** Full reviewed target, including trust, owners, redirects and scopes. */
  desired: unknown;
  /** Exact non-secret database facts observed under the advisory lock. */
  before: unknown;
  /** Full non-secret state expected after the transaction. */
  after: unknown;
  /** Exact application/account bindings handed to Alia. */
  aliaManifest: unknown;
  operations: readonly string[];
}

export const NATIVE_PRODUCT_AGENT_ROLLBACK_OPERATION_KINDS = [
  'archive-private-bot',
  'suspend-created-clarity-app',
  'revoke-created-clarity-credential',
  'deactivate-alia-agent',
] as const;

export function nativeProductAgentRollbackOperations(input: {
  homiioBotId: string;
  homiioSindiCredentialId: string;
  clarityBotId: string;
  clarityApplicationId: string;
  clarityCredentialId: string;
  clarityBackendApplicationId: string;
  clarityBackendCredentialId: string;
  homiioAgentId: string;
  clarityAgentId: string;
}): string[] {
  return [
    `archive-private account ${input.homiioBotId}`,
    `revoke credential ${input.homiioSindiCredentialId}`,
    `archive-private account ${input.clarityBotId}`,
    `suspend application ${input.clarityApplicationId}`,
    `revoke credential ${input.clarityCredentialId}`,
    `suspend application ${input.clarityBackendApplicationId}`,
    `revoke credential ${input.clarityBackendCredentialId}`,
    `deactivate-in-alia agent ${input.homiioAgentId}`,
    `deactivate-in-alia agent ${input.clarityAgentId}`,
  ];
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function nativeProductBootstrapPlanSha256(plan: NativeProductBootstrapPlan): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(plan)))
    .digest('hex');
}

export function requireNativeProductBootstrapApproval(
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

/**
 * Whether a native product agent's backend can stand on its workload alone.
 *
 * `live: false` covers every reason `resolveLiveAgencyWorkload` answers null —
 * no binding for this exact role and application, an expired one, an inactive
 * or untrusted application, a suspended or fenced owner. `scopes` is what that
 * resolver decided with `workloadBindingScopes`, i.e. what a token minted from
 * the binding right now would carry.
 */
export type NativeProductAgentWorkloadReadiness =
  | { readonly live: false }
  | { readonly live: true; readonly scopes: readonly string[] };

export type RetiredServiceCredentialDecision =
  /** No row with the reserved id: nothing to retire, and nothing is created. */
  | { readonly disposition: 'absent' }
  /** Already revoked: asserted, never touched again. */
  | { readonly disposition: 'already_revoked' }
  /** Still able to authenticate (or to become able to): revoke it now. */
  | { readonly disposition: 'revoke' }
  /** Revoking it now would cut the product off. Nothing is written. */
  | { readonly refusal: 'workload_not_live' | 'workload_missing_scope' };

/**
 * What the bootstrap does with a retired native-agent service credential (ADR
 * 0026: the product backend proves what it IS by attesting its task role).
 *
 * The credential is never created and its secret is never read: there is no
 * key pair left to hold. A row that still exists is revoked — but only once the
 * workload that replaces it is bound live AND reaches every scope the credential
 * carried, because revoking first is exactly how a product loses a privileged
 * scope in production (ADR 0026: bind with scopes, verify, THEN remove the
 * pair). A row that is already revoked or absent needs no replacement to be
 * left alone, so a fresh environment — where the backend application, and so
 * its binding, may not exist yet — still bootstraps.
 */
export function retiredServiceCredentialDecision(input: {
  /** `null` when no row has the reserved id. */
  readonly credentialStatus: string | null;
  readonly workload: NativeProductAgentWorkloadReadiness;
  readonly requiredScopes: readonly string[];
}): RetiredServiceCredentialDecision {
  if (input.credentialStatus === null) return { disposition: 'absent' };
  if (input.credentialStatus === 'revoked') return { disposition: 'already_revoked' };
  if (!input.workload.live) return { refusal: 'workload_not_live' };
  const granted = new Set(input.workload.scopes);
  if (input.requiredScopes.some((scope) => !granted.has(scope))) {
    return { refusal: 'workload_missing_scope' };
  }
  return { disposition: 'revoke' };
}
