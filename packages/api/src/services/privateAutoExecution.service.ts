import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { inferenceMeteredUsage } from '../db/schema';
import { createHash } from 'node:crypto';
import {
  canonicalScopedExecutionJson, privateAutoInputSchema, privateAutoOperationId,
  PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION, PRIVATE_AUTO_LIMITS,
  privateAutoExecutionSchema, type PrivateAutoSourceApproval, type PrivateAutoExecution,
  type RoutingPolicyReference,
} from '@oxy.so/contracts';
import { reviewedPrivateAutoApproval, privateAutoClassifierSourceApproval } from '../config/privateAutoClassification';
import type { EdgePrincipal } from './inferenceEdge.service';

export interface PrivateAutoParentAdmission {
  readonly id: string;
  readonly requestId: string;
  readonly parentRequestId: string | null;
  readonly accountId: string;
  readonly applicationId: string;
  readonly applicationCredentialId: string;
  readonly delegatedUserId: string | null;
  readonly environment: string;
  readonly economicTreatment: string;
  readonly economicPolicyVersion: string;
  readonly economicRelationshipId: string | null;
  readonly status: string;
  readonly expiresAt: Date;
  readonly finalAuthorizedDeploymentId: string | null;
}

export interface PrivateAutoChildBinding {
  readonly parentMeteredUsageId: string;
  readonly parentRequestId: string;
  readonly requestId: string;
  readonly principal: EdgePrincipal;
  readonly policy: RoutingPolicyReference;
  readonly input: unknown;
  /** Set when the original classifier starts; never refreshed during admission. */
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
  readonly delegatedUserId?: string;
}

/** Identity/authority facts shared by admission and read-only recovery. */
export function privateAutoParentOwned(parent: PrivateAutoParentAdmission | undefined, binding: PrivateAutoChildBinding): boolean {
  return parent !== undefined && parent.id === binding.parentMeteredUsageId &&
    parent.requestId === binding.parentRequestId && parent.parentRequestId === null &&
    parent.accountId === binding.principal.ownerAccountId &&
    parent.applicationId === binding.principal.applicationId &&
    parent.applicationCredentialId === binding.principal.credentialId &&
    parent.delegatedUserId === null && binding.delegatedUserId === undefined &&
    parent.environment === binding.principal.environment && parent.economicTreatment === 'internal_metered' &&
    binding.principal.lane === 'service_token';
}

/** No private input hash is persisted or logged; these hashes bind transient signed bytes. */
export function privateAutoHash(value: unknown): string {
  return createHash('sha256').update(canonicalScopedExecutionJson(value), 'utf8').digest('hex');
}

/** Construct only after the actual parent row was read; claim rechecks under its SQL lock. */
export function bindPrivateAutoExecution(
  source: unknown,
  parent: PrivateAutoParentAdmission | undefined,
  binding: PrivateAutoChildBinding,
  attestation: { readonly contractVersion: string; readonly snapshotId: string;
    readonly approval: unknown; readonly catalogueEvidenceHash: string },
  now = Date.now(),
): PrivateAutoExecution | undefined {
  const approval = reviewedPrivateAutoApproval(source, now);
  const input = privateAutoInputSchema.safeParse(binding.input);
  if (approval === undefined || !input.success || binding.signal.aborted ||
    !privateAutoParentOwned(parent, binding) || parent === undefined ||
    parent.status !== 'admitted' || !Number.isFinite(parent.expiresAt.getTime()) || parent.expiresAt.getTime() <= now ||
    !Number.isFinite(binding.deadlineAt) || binding.deadlineAt <= now || binding.deadlineAt > now + PRIVATE_AUTO_LIMITS.timeoutMs ||
    parent.finalAuthorizedDeploymentId !== null ||
    parent.economicPolicyVersion !== approval.economicPolicyVersion ||
    parent.economicRelationshipId !== approval.economicRelationshipId ||
    approval.principal.accountId !== binding.principal.ownerAccountId ||
    approval.principal.applicationId !== binding.principal.applicationId ||
    approval.principal.credentialId !== binding.principal.credentialId ||
    approval.principal.environment !== binding.principal.environment ||
    !binding.principal.scopes.includes('inference:invoke') ||
    binding.policy.routingPolicyId !== approval.policy.routingPolicyId ||
    binding.policy.policyVersion !== approval.policy.policyVersion ||
    attestation.contractVersion !== PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION) return undefined;
  // Count the entire controlled child envelope, not just state. No truncation.
  const controlledBytes = Buffer.byteLength(JSON.stringify({ input: input.data, tools: [] }), 'utf8') + 256;
  if (controlledBytes > PRIVATE_AUTO_LIMITS.maxControlledInputBytes) return undefined;
  try {
    if (privateAutoHash(attestation.approval) !== privateAutoHash(approval)) return undefined;
    const operationId = privateAutoOperationId(parent.id);
    if (binding.requestId !== operationId) return undefined;
    const { review: _review, limits: _limits, ...wire } = approval;
    const parsed = privateAutoExecutionSchema.safeParse({ ...wire,
      contractVersion: PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION,
      approvalSha256: privateAutoHash(approval),
      parentMeteredUsageId: parent.id, parentRequestId: parent.requestId,
      operationId, requestId: operationId, inputSha256: privateAutoHash(input.data),
      runtimeExpiresAt: new Date(Math.min(binding.deadlineAt, parent.expiresAt.getTime(), Date.parse(approval.expiresAt))).toISOString(),
      snapshotId: attestation.snapshotId, catalogueEvidenceHash: attestation.catalogueEvidenceHash });
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Recovery reads known lineage even when the parent settled or source approval expired. */
export function privateAutoRecoveryIdentity(
  parent: PrivateAutoParentAdmission | undefined,
  binding: PrivateAutoChildBinding,
): { readonly requestId: string; readonly parentRequestId: string } | undefined {
  if (!privateAutoParentOwned(parent, binding) || parent === undefined ||
    !binding.principal.scopes.includes('inference:usage:read')) return undefined;
  try {
    const requestId = privateAutoOperationId(parent.id);
    return binding.requestId === requestId ? { requestId, parentRequestId: parent.requestId } : undefined;
  } catch { return undefined; }
}

/** Pin all private source identities before another admission/dispatch stage. */
export function samePrivateAutoApproval(left: PrivateAutoSourceApproval, right: PrivateAutoSourceApproval): boolean {
  return privateAutoHash(left) === privateAutoHash(right);
}

/** Source-only selection context; authenticated identity is mandatory, never inferred from an owner. */
export interface PrivateAutoCatalogueContext {
  readonly approval: PrivateAutoSourceApproval;
  readonly principal: PrivateAutoSourceApproval['principal'];
}
export function privateAutoCatalogueApproval(context: PrivateAutoCatalogueContext | undefined, now = Date.now()): PrivateAutoSourceApproval | undefined {
  const source = reviewedPrivateAutoApproval(privateAutoClassifierSourceApproval(), now);
  if (source === undefined || context === undefined || !samePrivateAutoApproval(source, context.approval) ||
    privateAutoHash(source.principal) !== privateAutoHash(context.principal)) return undefined;
  return source;
}
/** Independent from commissioning/public approval. Actual model rights remain unchanged. */
export interface PrivateAutoCatalogueRouteEvidence {
  readonly admission: 'private_auto_classifier';
  readonly permissionState: 'pending_review';
  readonly deploymentStatus: 'disabled';
  readonly sourceApprovalSha256: string;
  readonly modelRevisionId: string;
  readonly deploymentId: string;
  readonly priceVersionId: string;
  readonly commercialPermission: string;
  readonly legalReviewStatus: 'approved';
  readonly legalReviewEvidenceRef: string;
  readonly eligibility: import('./scopedExecution.service').ScopedCatalogueRouteEvidence['eligibility'];
}

/** Minimal authority projection, never a payload or a derived user principal. */
export async function readPrivateAutoParent(id: string): Promise<PrivateAutoParentAdmission | undefined> {
  const [row] = await getDb().select({ id: inferenceMeteredUsage.id, requestId: inferenceMeteredUsage.requestId,
    parentRequestId: inferenceMeteredUsage.parentRequestId, accountId: inferenceMeteredUsage.accountId,
    applicationId: inferenceMeteredUsage.applicationId, applicationCredentialId: inferenceMeteredUsage.applicationCredentialId,
    delegatedUserId: inferenceMeteredUsage.delegatedUserId, environment: inferenceMeteredUsage.environment,
    economicTreatment: inferenceMeteredUsage.economicTreatment, economicPolicyVersion: inferenceMeteredUsage.economicPolicyVersion,
    economicRelationshipId: inferenceMeteredUsage.economicRelationshipId, status: inferenceMeteredUsage.status,
    expiresAt: inferenceMeteredUsage.expiresAt, finalAuthorizedDeploymentId: inferenceMeteredUsage.finalAuthorizedDeploymentId,
  }).from(inferenceMeteredUsage).where(eq(inferenceMeteredUsage.id, id));
  return row;
}

/** Known-child recovery after settlement/expiry is SELECT-only and never reopens admission. */
export async function readPrivateAutoChildRecovery(binding: PrivateAutoChildBinding) {
  const parent = await readPrivateAutoParent(binding.parentMeteredUsageId);
  const identity = privateAutoRecoveryIdentity(parent, binding);
  if (identity === undefined || parent === undefined) return undefined;
  const [child] = await getDb().select({ id: inferenceMeteredUsage.id, requestId: inferenceMeteredUsage.requestId,
    parentRequestId: inferenceMeteredUsage.parentRequestId, accountId: inferenceMeteredUsage.accountId,
    applicationId: inferenceMeteredUsage.applicationId, credentialId: inferenceMeteredUsage.applicationCredentialId,
    delegatedUserId: inferenceMeteredUsage.delegatedUserId, environment: inferenceMeteredUsage.environment,
    treatment: inferenceMeteredUsage.economicTreatment, policy: inferenceMeteredUsage.economicPolicyVersion,
    relationship: inferenceMeteredUsage.economicRelationshipId, endpoint: inferenceMeteredUsage.endpoint,
    status: inferenceMeteredUsage.status, outcome: inferenceMeteredUsage.outcome,
  }).from(inferenceMeteredUsage).where(eq(inferenceMeteredUsage.requestId, identity.requestId));
  if (!child || child.parentRequestId !== identity.parentRequestId || child.accountId !== parent.accountId ||
    child.applicationId !== parent.applicationId || child.credentialId !== parent.applicationCredentialId ||
    child.delegatedUserId !== null || child.environment !== parent.environment || child.treatment !== parent.economicTreatment ||
    child.policy !== parent.economicPolicyVersion || child.relationship !== parent.economicRelationshipId ||
    child.endpoint !== '/internal/auto-classification') return undefined;
  // Generation payloads are never retained; this is a lineage/outcome recovery, not an answer cache.
  return { kind: 'private-auto-child-recovery-v1' as const, meteredUsageId: child.id, requestId: child.requestId,
    parentRequestId: child.parentRequestId, status: child.status, outcome: child.outcome, newAdmissionAuthorized: false };
}
