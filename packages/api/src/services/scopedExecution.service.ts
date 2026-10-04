import { createHash } from 'node:crypto';
import {
  canonicalScopedExecutionJson,
  scopedExecutionAudienceSchema,
  scopedExecutionSchema,
  type ScopedExecutionAudience,
  type ScopedExecution,
  type RoutingPolicyReference,
} from '@oxy.so/contracts';
import type { EdgeExecutionContext } from './inferenceEdge.service';
import type { KaanaDeploymentAttestation } from './kaanaClient';
import type { ReserveInput } from './inferenceLedger.service';
export const scopedFundingRestriction: NonNullable<ReserveInput['fundingRestriction']> = 'promotional-only';

/** Source-reviewed authorization only. No environment switch or public setter. */
const preapprovedManifest: ScopedExecutionAudience | undefined = undefined;

/** Used by catalogue import; signed provider metadata cannot authorize itself. */
export function sourceReviewedScopedAudience(now = Date.now()): ScopedExecutionAudience | undefined {
  const parsed = scopedExecutionAudienceSchema.safeParse(preapprovedManifest);
  return parsed.success && Number.isFinite(now) && Date.parse(parsed.data.expiresAt) > now
    ? parsed.data : undefined;
}

export function scopedPermitForContext(context: EdgeExecutionContext): ScopedExecutionAudience | undefined {
  return bindScopedPermit(preapprovedManifest, context);
}

/** Pure admission helper: fixtures may inject synthetic source authorization. */
export function bindScopedPermit(
  manifest: ScopedExecutionAudience | undefined,
  context: Pick<EdgeExecutionContext, 'principal' | 'request' | 'idempotencyKey'>,
  now = Date.now(),
): ScopedExecutionAudience | undefined {
  if (manifest === undefined) return undefined;
  const parsed = scopedExecutionAudienceSchema.safeParse(manifest);
  if (!parsed.success) return undefined;
  const permit = parsed.data;
  const { principal, request } = context;
  if (Date.parse(permit.expiresAt) <= now || !Number.isFinite(now) ||
    principal.ownerAccountId !== permit.principal.accountId ||
    principal.applicationId !== permit.principal.applicationId ||
    principal.credentialId !== permit.principal.credentialId ||
    principal.environment !== permit.principal.environment ||
    !principal.scopes.includes('inference:invoke') ||
    context.idempotencyKey !== permit.idempotencyKey || request.stream ||
    request.operation.kind !== 'decisions' || request.input.format !== 'decisions' ||
    request.target?.kind !== 'model' || request.target.modelReference !== permit.modelReference) return undefined;
  try {
    if (hashScopedInput(JSON.parse(JSON.stringify(request.input))) !== permit.fixtureSha256) return undefined;
  } catch { return undefined; }
  return permit;
}

export function hashScopedInput(input: unknown): string {
  return createHash('sha256').update(canonicalScopedExecutionJson(input), 'utf8').digest('hex');
}

/** Must be constructed from the selected normal candidate, after all normal gates. */
export interface ScopedCatalogueEvidence {
  readonly modelRevisionId: string;
  readonly deploymentId: string;
  readonly priceVersionId: string;
  readonly commercialPermission: string;
  readonly permissionState: 'approved';
  readonly legalReviewStatus: 'approved';
  readonly legalReviewEvidenceRef: string;
  readonly eligibility: {
    readonly availabilityScope: string;
    readonly licenseId: string;
    readonly commercialUseAllowed: boolean;
    readonly retainsPayloads: boolean;
    readonly retentionDays: number;
    readonly trainsOnCustomerData: boolean;
    readonly zeroDataRetentionAvailable: boolean;
    readonly policyAdmitted: true;
    readonly capabilityAdmitted: true;
    readonly privacyAdmitted: true;
  };
  readonly policy: RoutingPolicyReference;
}

/** No snapshot id can substitute for the exact negotiated audience/card proof. */
export function attestScopedPermit(
  permit: ScopedExecutionAudience,
  attestation: KaanaDeploymentAttestation,
  requestId: string,
  evidence: ScopedCatalogueEvidence,
): ScopedExecution | undefined {
  if (attestation.scopedExecutionContractVersion !== '3.6.0' || !attestation.snapshotId ||
    attestation.deployments.length !== 1 || !requestId || !evidence.modelRevisionId ||
    !evidence.legalReviewEvidenceRef.trim() || !evidence.commercialPermission ||
    evidence.permissionState !== 'approved' || evidence.legalReviewStatus !== 'approved' ||
    evidence.deploymentId !== permit.deploymentId || evidence.priceVersionId !== permit.priceVersionId ||
    canonicalScopedExecutionJson(evidence.policy) !== canonicalScopedExecutionJson(permit.policy) ||
    evidence.eligibility.policyAdmitted !== true || evidence.eligibility.capabilityAdmitted !== true ||
    evidence.eligibility.privacyAdmitted !== true) return undefined;
  const descriptor = attestation.deployments[0];
  if (descriptor.scopedExecution === undefined ||
    canonicalScopedExecutionJson(descriptor.scopedExecution) !== canonicalScopedExecutionJson(permit) ||
    descriptor.deploymentId !== permit.deploymentId || descriptor.provider !== permit.provider ||
    descriptor.modelReference !== permit.modelReference || descriptor.keyId !== permit.keyId ||
    descriptor.upstreamModelId !== permit.upstreamModelId ||
    descriptor.providerRateCardVersionId !== permit.providerRateCardVersionId ||
    descriptor.providerSourceVersion !== permit.providerSourceVersion) return undefined;
  const parsed = scopedExecutionSchema.safeParse({ ...permit, requestId, snapshotId: attestation.snapshotId,
    catalogueEvidenceHash: hashScopedInput(evidence) });
  return parsed.success ? parsed.data : undefined;
}

/** Typed ordinary ledger support landed; source authorization remains absent. */
export function scopedFundingIntegrationAvailable(): boolean { return scopedFundingRestriction === 'promotional-only'; }
