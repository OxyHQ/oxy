import {
  PRIVATE_AUTO_INSTRUCTIONS,
  PRIVATE_AUTO_QUESTION,
} from '../inference/privateAutoExecution';

/** Synthetic private authority only; this is not a provider/rights approval. */
export const privateAutoApprovalFixture = {
  purpose: 'private_auto_classifier',
  classifierVersion: 'jev-auto-v1',
  approvalId: 'synthetic-private-auto-review',
  approvalVersion: 1,
  expiresAt: '2030-01-01T00:00:00Z',
  principal: {
    accountId: 'synthetic-owner',
    applicationId: 'synthetic-alia',
    credentialId: 'synthetic-workload',
    environment: 'production',
    lane: 'service_token',
  },
  policy: { routingPolicyId: 'platform-internal-default', policyVersion: 1 },
  economicPolicyVersion: 'synthetic-economics-v1',
  economicRelationshipId: 'synthetic-private-relationship',
  deploymentId: 'synthetic-jev-deployment',
  provider: 'openrouter',
  keyId: 'synthetic-key',
  modelReference: 'synthetic/jev@reviewed-v1',
  upstreamModelId: 'synthetic/jev-v1',
  regions: [],
  priceVersionId: 'synthetic-price',
  providerRateCardVersionId: 'synthetic-rate-card',
  providerSourceVersion: 'synthetic-provider-observation',
  maxCostUsd: '0.001000000000',
  review: {
    internalUseAllowed: true,
    internalUseEvidenceRef: 'synthetic:internal-rights',
    legalReviewEvidenceRef: 'synthetic:legal-review',
    privacyEvidenceRef: 'synthetic:privacy-review',
    zdrEvidenceRef: 'synthetic:zdr-review',
    evidenceExpiresAt: '2030-01-01T00:00:00Z',
    commercialUseAllowed: false,
    retainsPayloads: false,
    retentionDays: 0,
    trainsOnCustomerData: false,
    zeroDataRetentionAvailable: true,
  },
  limits: { timeoutMs: 1000, maxStateBytes: 8192, maxControlledInputBytes: 8192 },
};

export function privateAutoInputFixture(state = 'synthetic variable text') {
  return {
    format: 'decisions',
    decisions: {
      state,
      instructions: PRIVATE_AUTO_INSTRUCTIONS,
      questions: [{ ...PRIVATE_AUTO_QUESTION, options: [...PRIVATE_AUTO_QUESTION.options] }],
    },
  };
}
