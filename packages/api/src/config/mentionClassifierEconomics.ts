/** An independently reviewed product relationship; never an application trust flag. */
export const MENTION_CLASSIFIER_IDENTITY = {
  applicationId: '6a2f851751b784a86fd0e916',
  ownerAccountId: '69b2d3df5d12f58c9800d651',
  credentialId: 'wl_d61be5cd068abb658ed4d193',
  bindingId: '01a0b40a-9739-7703-a154-428dd51d15bb',
  subject: 'arn:aws:iam::237343248947:role/oxy-mention-task',
} as const;

export interface MentionClassifierApproval {
  /** Bump on every relationship or bound-route change; retained in metered history. */
  readonly economicPolicyVersion: string;
  readonly evidenceRef: string;
  readonly expiresAt: string;
  readonly deploymentId: string;
  readonly modelReference: string;
  readonly provider: 'openrouter';
  readonly priceVersionId: string;
  readonly routingPolicyId: string;
  readonly routingPolicyVersion: number;
}

/** No env override. Exact price, privacy and resolver evidence is not approved yet. */
export function mentionClassifierApproval(): MentionClassifierApproval | undefined {
  return undefined;
}
