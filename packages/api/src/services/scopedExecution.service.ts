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
const preapprovedManifest: ScopedExecutionAudience | undefined = scopedExecutionAudienceSchema.parse({
  "permitId": "jev-mention-native-en-onepost-20261005-01",
  "idempotencyKey": "mention_jev_native_en_8d04b9d17510fe89d7ae084039ee4231",
  "fixtureSha256": "a962e5ed49a962db7934684c62834dd25b04aba94162ad9d07140c9a2abeb3b2",
  "expiresAt": "2026-10-05T01:28:26Z",
  "principal": {
    "accountId": "69b2d3df5d12f58c9800d651",
    "applicationId": "6a2f851751b784a86fd0e916",
    "credentialId": "wl_d61be5cd068abb658ed4d193",
    "environment": "production"
  },
  "policy": {
    "routingPolicyId": "platform-internal-default",
    "policyVersion": 1
  },
  "deploymentId": "dep_openrouter_typesafe_jev_1_13_mention_native_2026_10_05",
  "provider": "openrouter",
  "keyId": "b8090dce-82f2-4077-9fc1-fd831a53ca27",
  "modelReference": "typesafe/jev-1.13@2026-09-17",
  "upstreamModelId": "typesafe/jev-1.13-20260917",
  "priceVersionId": "jev_scoped_price_20261004_01",
  "providerRateCardVersionId": "rc_openrouter_jev_mention_native_20261005_01",
  "providerSourceVersion": "openrouter-api/2026-10-04/typesafe/jev-1.13-20260917/556fab0c5da201c07d4eeafd32b48250fb3fa297b69ed0f9e62a7225ca8511ba",
  "maxCostUsd": "0.01"
});

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

/** Actual legal, privacy, policy and capability facts of the selected candidate. */
interface ScopedCatalogueEvidenceBase {
  readonly modelRevisionId: string;
  readonly deploymentId: string;
  readonly priceVersionId: string;
  readonly commercialPermission: string;
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

/** Commissioning is a private measurement, never a public permission approval. */
export type ScopedCatalogueEvidence = ScopedCatalogueEvidenceBase & (
  | { readonly permissionState: 'approved'; readonly admission?: 'approved_catalogue' }
  | { readonly permissionState: 'pending_review'; readonly admission: 'private_commissioning';
      readonly deploymentStatus: 'disabled' }
);

type WithoutPolicy<T> = T extends ScopedCatalogueEvidence ? Omit<T, 'policy'> : never;
export type ScopedCatalogueRouteEvidence = WithoutPolicy<ScopedCatalogueEvidence>;

/** Wire-supplied audience data cannot authorize a private catalogue row. */
export function privateCommissioningAudience(
  audience: ScopedExecutionAudience | undefined,
  now = Date.now(),
): ScopedExecutionAudience | undefined {
  const reviewed = sourceReviewedScopedAudience(now);
  return audience !== undefined && reviewed !== undefined &&
    canonicalScopedExecutionJson(audience) === canonicalScopedExecutionJson(reviewed)
    ? reviewed : undefined;
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
    !((evidence.permissionState === 'approved' && (evidence.admission === undefined || evidence.admission === 'approved_catalogue')) ||
      (evidence.permissionState === 'pending_review' && evidence.admission === 'private_commissioning' &&
        evidence.deploymentStatus === 'disabled' && evidence.eligibility.availabilityScope === 'platform_internal')) ||
    !Number.isFinite(Date.parse(permit.expiresAt)) || Date.parse(permit.expiresAt) <= Date.now() || evidence.legalReviewStatus !== 'approved' ||
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
