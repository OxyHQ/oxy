import { and, eq, sql } from 'drizzle-orm';
import type { RoutingPolicyReference } from '@oxy.so/contracts';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applicationWorkloadIdentities } from '../db/schema/applicationWorkloadIdentities';
import { MENTION_CLASSIFIER_IDENTITY, type MentionClassifierApproval } from '../config/mentionClassifierEconomics';
import type { EconomicTreatmentDecision } from '../config/inferenceEconomicPolicy';
import type { NormalizedEdgeRequest } from '../schemas/inferenceEdge.schemas';
import type { EdgePrincipal } from './inferenceEdge.service';
import { resolveLiveAgencyWorkloadByHandle } from './agencyServicePrincipal.service';
import { exceedsAmount } from './inferenceCatalogue.service';

/** Only this typed operation may be considered; unrelated Mention traffic stays commercial. */
export function isMentionClassifierRequest(
  principal: EdgePrincipal, request: NormalizedEdgeRequest, approval: MentionClassifierApproval,
): boolean {
  return principal.lane === 'service_token'
    && principal.applicationId === MENTION_CLASSIFIER_IDENTITY.applicationId
    && principal.credentialId === MENTION_CLASSIFIER_IDENTITY.credentialId
    && principal.ownerAccountId === MENTION_CLASSIFIER_IDENTITY.ownerAccountId
    && principal.environment === 'production'
    && request.operation.kind === 'decisions' && request.input.format === 'decisions'
    && request.target?.kind === 'model' && request.target.modelReference === approval.modelReference;
}

/** The canonical resolver checks active app/owner, closure, expiry, trust and current scopes. */
export async function mentionClassifierAuthorityActive(principal: EdgePrincipal): Promise<boolean> {
  const identity = MENTION_CLASSIFIER_IDENTITY;
  if (principal.lane !== 'service_token' || principal.applicationId !== identity.applicationId
    || principal.credentialId !== identity.credentialId || principal.ownerAccountId !== identity.ownerAccountId
    || principal.environment !== 'production'
    || !['inference:invoke', 'inference:usage:read'].every((scope) => principal.scopes.some((value) => value === scope))) return false;
  const live = await resolveLiveAgencyWorkloadByHandle(identity.applicationId, identity.credentialId);
  if (live === null || live.ownerAccountId !== identity.ownerAccountId || live.provider !== 'aws-iam'
    || live.subject !== identity.subject || !['inference:invoke', 'inference:usage:read'].every((scope) => live.scopes.some((value) => value === scope))) return false;
  // The handle derives from the subject, so also require the exact reviewed binding row.
  const rows = await getDb().select({ id: applicationWorkloadIdentities.id }).from(applicationWorkloadIdentities)
    .innerJoin(applicationCredentials, eq(applicationCredentials.workloadIdentityId, applicationWorkloadIdentities.id))
    .where(and(eq(applicationWorkloadIdentities.id, identity.bindingId),
      eq(applicationWorkloadIdentities.applicationId, identity.applicationId),
      eq(applicationWorkloadIdentities.provider, live.provider), eq(applicationWorkloadIdentities.subject, live.subject),
      eq(applicationCredentials.id, identity.credentialId), eq(applicationCredentials.applicationId, identity.applicationId),
      eq(applicationCredentials.type, 'workload'), eq(applicationCredentials.status, 'active'),
      eq(applicationCredentials.environment, 'production'),
      sql`(${applicationCredentials.expiresAt} is null or ${applicationCredentials.expiresAt} > now())`)).limit(1);
  return rows.length === 1;
}

export function mentionClassifierEconomicDecision(input: {
  principal: EdgePrincipal;
  request: NormalizedEdgeRequest;
  approval: MentionClassifierApproval;
  routes: readonly { deploymentId: string; modelReference: string; provider: string; priceVersionId: string }[];
  policy: RoutingPolicyReference;
  quote: { amount: string; currency: string };
  authorityActive: boolean;
  delegatedUserId?: string;
  now: number;
}): Extract<EconomicTreatmentDecision, { treatment: 'internal_metered' }> | undefined {
  const { approval, request } = input;
  const expiry = Date.parse(approval.expiresAt);
  const route = input.routes[0];
  const budget = approval.qualificationBudget;
  const reviewedSecondVersion = 'oxy-mention-jev-native/2026-10-05.2';
  const reviewedThirdVersion = 'oxy-mention-jev-native/2026-10-05.3';
  // The live .2 getter remains unchanged. A .3 approval requires a separate
  // source review; its stable counter must include both prior failed requests.
  if (budget !== undefined) {
    if (typeof budget !== 'object' || budget === null || Object.keys(budget).sort().join(',') !== 'maxTotalRequests,previousEconomicPolicyVersion,utcDay'
      || !((approval.economicPolicyVersion === reviewedSecondVersion
        && budget.maxTotalRequests === 2 && budget.previousEconomicPolicyVersion === 'oxy-mention-jev-native/2026-10-05.1')
        || (approval.economicPolicyVersion === reviewedThirdVersion
          && budget.maxTotalRequests === 3 && budget.previousEconomicPolicyVersion === reviewedSecondVersion))
      || budget.utcDay !== '2026-10-05'
      || !/^oxy1519\/1572\/mention-native-source-review\/sha256:[a-f0-9]{64}$/.test(approval.evidenceRef)
      || !Number.isFinite(input.now) || (input.now < Date.parse('2026-10-05T00:00:00Z') || input.now >= Date.parse('2026-10-06T00:00:00Z'))
      || !Number.isFinite(expiry) || expiry > Date.parse('2026-10-06T00:00:00Z')) return undefined;
  } else if (approval.economicPolicyVersion === reviewedSecondVersion || approval.economicPolicyVersion === reviewedThirdVersion) return undefined;
  if (!input.authorityActive || !isMentionClassifierRequest(input.principal, request, approval)
    || input.delegatedUserId !== undefined || !Number.isFinite(expiry) || expiry <= input.now
    || !approval.economicPolicyVersion.trim() || !approval.evidenceRef.trim()
    || request.stream || request.audioOutput !== undefined || request.tools.length !== 0
    || Buffer.byteLength(JSON.stringify({ input: request.input, tools: request.tools,
      toolChoice: request.toolChoice, responseFormat: request.responseFormat }), 'utf8') + 256 > 8192
    || input.routes.length !== 1 || route === undefined
    || route.deploymentId !== approval.deploymentId || route.modelReference !== approval.modelReference
    || route.provider !== approval.provider || route.priceVersionId !== approval.priceVersionId
    || input.policy.routingPolicyId !== approval.routingPolicyId || input.policy.policyVersion !== approval.routingPolicyVersion
    || input.quote.currency !== 'USD' || exceedsAmount(input.quote.amount, '0.01')) return undefined;
  return { treatment: 'internal_metered', policyVersion: approval.economicPolicyVersion,
    relationship: { relationshipId: 'mention-jev-kaana', consumerApplicationId: MENTION_CLASSIFIER_IDENTITY.applicationId,
      consumerProduct: 'mention', providerProduct: 'kaana', environments: ['production'], lane: 'service_token',
      capacity: { maxConcurrentRequests: 1, maxRequestsPerUtcDay: budget === undefined ? 1 : budget.maxTotalRequests, scope: 'relationship',
        ...(budget === undefined ? {} : { qualificationBudget: { utcDay: budget.utcDay, expiresAt: approval.expiresAt } }) } } };
}
