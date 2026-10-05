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
  /** Closed qualification lineage; support does not activate a new source approval. */
  readonly qualificationBudget?: {
    readonly utcDay: '2026-10-05';
  } & ({
    readonly maxTotalRequests: 2;
    readonly previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1';
  } | {
    readonly maxTotalRequests: 3;
    readonly previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2';
  });
}

/** Exact root-reviewed own-Mention relationship; no environment override or mutable setter. */
const REVIEWED_MENTION_APPROVAL: MentionClassifierApproval = {
  "economicPolicyVersion": "oxy-mention-jev-native/2026-10-05.3",
  "evidenceRef": "oxy1519/1572/mention-native-source-review/sha256:ea34cfaf7bc7e3b7743dcc6509d15f421b741de4e496269f913009b41b89b998",
  "expiresAt": "2026-10-05T07:09:12Z",
  "deploymentId": "dep_openrouter_typesafe_jev_1_13_mention_native_third_2026_10_05",
  "modelReference": "typesafe/jev-1.13@2026-09-17",
  "provider": "openrouter",
  "priceVersionId": "jev_scoped_price_20261004_01",
  "routingPolicyId": "platform-internal-default",
  "routingPolicyVersion": 1,
  "qualificationBudget": {
    "utcDay": "2026-10-05",
    "maxTotalRequests": 3,
    "previousEconomicPolicyVersion": "oxy-mention-jev-native/2026-10-05.2"
  }
};

/** Value isolation only; this function neither approves nor activates its input. */
export function cloneMentionClassifierApproval(approval: MentionClassifierApproval): MentionClassifierApproval {
  return structuredClone(approval);
}

export function mentionClassifierApproval(): MentionClassifierApproval | undefined {
  const now = Date.now();
  return Number.isFinite(now) && Date.parse(REVIEWED_MENTION_APPROVAL.expiresAt) > now
    ? cloneMentionClassifierApproval(REVIEWED_MENTION_APPROVAL) : undefined;
}
