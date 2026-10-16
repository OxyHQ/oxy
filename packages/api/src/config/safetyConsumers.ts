/** Exact deployed workload identities, reviewed from the 2026-10-15 read-only inventory. */
// Oxy's root account is an organization (observed in production 2026-10-16), never a person.
const root = '69b2d3df5d12f58c9800d651';
export const SAFETY_CONSUMERS = {
  clarity: {
    applicationId: '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
    ownerAccountId: '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
    // Clarity's applications belong to its project account, not a person.
    ownerKind: 'project',
    type: 'internal',
    roles: ['oxy-clarity-task'],
    // Experience only: privacy plus unrated-content refusal; no inference or general Clarity content support.
    candidateActions: ['profile', 'content'],
  },
  mention: {
    applicationId: '6a2f851751b784a86fd0e916',
    ownerAccountId: root,
    ownerKind: 'organization',
    type: 'first_party',
    roles: ['oxy-mention-task', 'oxy-mention-mcp-task'],
    candidateActions: ['profile', 'content', 'content-publication'],
  },
  allo: {
    applicationId: '6a2f851751b784a86fd0e92b',
    ownerAccountId: root,
    ownerKind: 'organization',
    type: 'first_party',
    roles: ['oxy-allo-task'],
    candidateActions: ['profile', 'messaging', 'messaging-delivery'],
  },
  mercaria: {
    applicationId: '6a37d0cc5d4b5f15482a9340',
    ownerAccountId: root,
    ownerKind: 'organization',
    type: 'first_party',
    roles: ['oxy-mercaria-task'],
    candidateActions: ['content', 'purchases'],
  },
} as const;
export type SafetyConsumer = keyof typeof SAFETY_CONSUMERS;
export const SAFETY_SCOPE = 'safety:decide';
export const safetyWorkloadSubject = (role: string) => `arn:aws:iam::237343248947:role/${role}`;
