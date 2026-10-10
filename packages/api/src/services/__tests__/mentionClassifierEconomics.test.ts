import {
  MENTION_CLASSIFIER_IDENTITY,
  mentionClassifierApproval,
  cloneMentionClassifierApproval,
  type MentionClassifierApproval,
} from '../../config/mentionClassifierEconomics';
import rootApproval from '../../../../../docs/audits/2026-10-05-mention-native-third-source/economics.json';
import { resolveEconomicTreatment } from '../../config/inferenceEconomicPolicy';
import {
  isMentionClassifierRequest,
  mentionClassifierEconomicDecision,
} from '../mentionClassifierEconomics.service';
import type { EdgePrincipal } from '../inferenceEdge.service';
import type { NormalizedEdgeRequest } from '../../schemas/inferenceEdge.schemas';

const principal: EdgePrincipal = {
  ...MENTION_CLASSIFIER_IDENTITY,
  lane: 'service_token',
  environment: 'production',
  scopes: ['inference:invoke', 'inference:usage:read'],
  applicationType: 'first_party',
  applicationIsInternal: false,
};
const approval: MentionClassifierApproval = {
  economicPolicyVersion: 'mention-classifier/synthetic-v1',
  evidenceRef: 'synthetic test only',
  expiresAt: '2099-01-01T00:00:00.000Z',
  deploymentId: 'synthetic-jev',
  modelReference: 'typesafe/jev@synthetic',
  provider: 'openrouter',
  priceVersionId: 'synthetic-price',
  routingPolicyId: 'synthetic-policy',
  routingPolicyVersion: 1,
};
const request: NormalizedEdgeRequest = {
  operation: { kind: 'decisions' },
  target: { kind: 'model', modelReference: approval.modelReference },
  input: {
    format: 'decisions',
    decisions: {
      state: 'Synthetic red square',
      questions: [{ id: 'red', kind: 'noul', question: 'Is it red?' }],
    },
  },
  stream: false,
  tools: [],
  sampling: {},
};
const input = () => ({
  principal,
  request,
  approval,
  routes: [
    {
      deploymentId: approval.deploymentId,
      modelReference: approval.modelReference,
      provider: approval.provider,
      priceVersionId: approval.priceVersionId,
    },
  ],
  policy: { routingPolicyId: approval.routingPolicyId, policyVersion: 1 },
  quote: { amount: '0.01', currency: 'USD' },
  authorityActive: true,
  now: Date.parse('2026-10-04T00:00:00.000Z'),
});

it('activates only the frozen own-Mention relationship and preserves global commercial treatment', () => {
  const expiry = Date.parse(rootApproval.expiresAt);
  jest.useFakeTimers().setSystemTime(expiry - 1);
  try {
    expect(mentionClassifierApproval()).toEqual(rootApproval);
    const changed = mentionClassifierApproval()!;
    Object.assign(changed, { deploymentId: 'foreign' });
    if (changed.qualificationBudget === undefined) throw new Error('reviewed .3 budget missing');
    Object.assign(changed.qualificationBudget, { maxTotalRequests: 99, utcDay: 'foreign' });
    expect(mentionClassifierApproval()).toEqual(rootApproval);
    jest.setSystemTime(expiry);
    expect(mentionClassifierApproval()).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
  expect(resolveEconomicTreatment(principal).treatment).toBe('commercial');
});
it('uses the independent exact relationship without changing internal trust', () => {
  const decision = mentionClassifierEconomicDecision(input());
  expect(decision).toMatchObject({
    treatment: 'internal_metered',
    policyVersion: approval.economicPolicyVersion,
    relationship: {
      relationshipId: 'mention-jev-kaana',
      consumerApplicationId: principal.applicationId,
      capacity: { maxConcurrentRequests: 1, maxRequestsPerUtcDay: 1, scope: 'relationship' },
    },
  });
  expect(principal.applicationIsInternal).toBe(false);
});
it.each(['applicationId', 'credentialId', 'ownerAccountId'] as const)(
  'does not match another %s',
  (field) => {
    const other = { ...principal, [field]: 'foreign' };
    expect(isMentionClassifierRequest(other, request, approval)).toBe(false);
    expect(mentionClassifierEconomicDecision({ ...input(), principal: other })).toBeUndefined();
  },
);
it.each(['machine_credential', 'product_session'] as const)('does not subsidize %s', (lane) => {
  expect(
    mentionClassifierEconomicDecision({ ...input(), principal: { ...principal, lane } }),
  ).toBeUndefined();
});
it('does not move translations or other models out of the commercial lane', () => {
  const translation: NormalizedEdgeRequest = {
    operation: { kind: 'completion' },
    input: { format: 'text', text: 'Translate this' },
    stream: false,
    tools: [],
    sampling: {},
    target: { kind: 'model', modelReference: 'other/model@revision' },
  };
  expect(isMentionClassifierRequest(principal, translation, approval)).toBe(false);
  expect(
    isMentionClassifierRequest(principal, { ...request, target: translation.target }, approval),
  ).toBe(false);
  expect(resolveEconomicTreatment(principal).treatment).toBe('commercial');
});
it.each(['deploymentId', 'modelReference', 'provider', 'priceVersionId'] as const)(
  'rejects a resolved foreign %s',
  (field) => {
    const i = input();
    i.routes[0] = { ...i.routes[0], [field]: 'foreign' };
    expect(mentionClassifierEconomicDecision(i)).toBeUndefined();
  },
);
it('rejects alternate routes, delegated users, expired approval and revoked authority', () => {
  const i = input();
  expect(
    mentionClassifierEconomicDecision({ ...i, routes: [...i.routes, ...i.routes] }),
  ).toBeUndefined();
  expect(mentionClassifierEconomicDecision({ ...i, delegatedUserId: 'someone' })).toBeUndefined();
  expect(mentionClassifierEconomicDecision({ ...i, authorityActive: false })).toBeUndefined();
  expect(
    mentionClassifierEconomicDecision({ ...i, now: Date.parse(approval.expiresAt) }),
  ).toBeUndefined();
  expect(
    mentionClassifierEconomicDecision({ ...i, approval: { ...approval, expiresAt: 'invalid' } }),
  ).toBeUndefined();
  expect(
    mentionClassifierEconomicDecision({
      ...i,
      principal: { ...principal, environment: 'staging' },
    }),
  ).toBeUndefined();
});
it('rejects policy drift, missing evidence and a quote above the exact USD ceiling', () => {
  const i = input();
  expect(
    mentionClassifierEconomicDecision({ ...i, policy: { ...i.policy, policyVersion: 2 } }),
  ).toBeUndefined();
  expect(
    mentionClassifierEconomicDecision({
      ...i,
      policy: { ...i.policy, routingPolicyId: 'foreign' },
    }),
  ).toBeUndefined();
  expect(
    mentionClassifierEconomicDecision({ ...i, approval: { ...approval, evidenceRef: '' } }),
  ).toBeUndefined();
  expect(
    mentionClassifierEconomicDecision({
      ...i,
      quote: { amount: '0.010000000001', currency: 'USD' },
    }),
  ).toBeUndefined();
  expect(
    mentionClassifierEconomicDecision({ ...i, quote: { amount: '0.001', currency: 'EUR' } }),
  ).toBeUndefined();
});
it('counts all UTF-8 controlled input and rejects streaming', () => {
  const i = input();
  expect(
    mentionClassifierEconomicDecision({ ...i, request: { ...request, stream: true } }),
  ).toBeUndefined();
  if (request.input.format !== 'decisions') throw new Error('fixture');
  const oversized = {
    ...request,
    input: {
      ...request.input,
      decisions: { ...request.input.decisions, state: '字'.repeat(3000) },
    },
  };
  expect(mentionClassifierEconomicDecision({ ...i, request: oversized })).toBeUndefined();
});

const qualificationApproval = (): MentionClassifierApproval => ({
  ...approval,
  economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
  evidenceRef: `oxy1519/1572/mention-native-source-review/sha256:${'a'.repeat(64)}`,
  expiresAt: '2026-10-05T06:00:00Z',
  qualificationBudget: {
    utcDay: '2026-10-05',
    maxTotalRequests: 2,
    previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
  },
});
it('prepares cumulative two-request capacity only for the explicit reviewed day/version', () => {
  const result = mentionClassifierEconomicDecision({
    ...input(),
    approval: qualificationApproval(),
    now: Date.parse('2026-10-05T05:00:00Z'),
  });
  expect(result).toMatchObject({
    policyVersion: 'oxy-mention-jev-native/2026-10-05.2',
    relationship: {
      relationshipId: 'mention-jev-kaana',
      capacity: {
        maxConcurrentRequests: 1,
        maxRequestsPerUtcDay: 2,
        scope: 'relationship',
        qualificationBudget: {
          utcDay: '2026-10-05',
          expiresAt: '2026-10-05T06:00:00Z',
        },
      },
    },
  });
});
it.each([
  ['other day', { now: Date.parse('2026-10-04T23:59:59Z') }],
  ['following day', { now: Date.parse('2026-10-06T00:00:00Z') }],
  ['non-finite clock', { now: Number.NaN }],
  ['unreviewed evidence', { approval: { ...qualificationApproval(), evidenceRef: 'unreviewed' } }],
  [
    'version without budget',
    { approval: { ...qualificationApproval(), qualificationBudget: undefined } },
  ],
  [
    'old version with new budget',
    {
      approval: {
        ...qualificationApproval(),
        economicPolicyVersion: approval.economicPolicyVersion,
      },
    },
  ],
  [
    'expiry spills into next day',
    { approval: { ...qualificationApproval(), expiresAt: '2026-10-06T00:00:01Z' } },
  ],
  [
    'third-request budget',
    {
      approval: {
        ...qualificationApproval(),
        qualificationBudget: {
          ...qualificationApproval().qualificationBudget,
          maxTotalRequests: 3,
        },
      },
    },
  ],
  [
    'counter reset version',
    {
      approval: {
        ...qualificationApproval(),
        qualificationBudget: {
          ...qualificationApproval().qualificationBudget,
          previousEconomicPolicyVersion: 'foreign',
        },
      },
    },
  ],
])('refuses qualification budget drift: %s', (_name, changes) => {
  expect(
    mentionClassifierEconomicDecision({
      ...input(),
      approval: qualificationApproval(),
      now: Date.parse('2026-10-05T05:00:00Z'),
      ...changes,
    } as Parameters<typeof mentionClassifierEconomicDecision>[0]),
  ).toBeUndefined();
});

it('isolates the nested future qualification budget without approving it', () => {
  const reviewed = qualificationApproval();
  const returned = cloneMentionClassifierApproval(reviewed);
  if (returned.qualificationBudget === undefined) throw new Error('fixture budget missing');
  Object.assign(returned.qualificationBudget, { maxTotalRequests: 99, utcDay: 'foreign' });
  expect(cloneMentionClassifierApproval(reviewed).qualificationBudget).toEqual({
    utcDay: '2026-10-05',
    maxTotalRequests: 2,
    previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
  });
});

it('derives the reviewed cumulative capacity from the exact third frozen source, without reopening the original review', () => {
  const active: MentionClassifierApproval = rootApproval as MentionClassifierApproval;
  const result = mentionClassifierEconomicDecision({
    ...input(),
    approval: active,
    request: { ...request, target: { kind: 'model', modelReference: active.modelReference } },
    routes: [
      {
        deploymentId: active.deploymentId,
        modelReference: active.modelReference,
        provider: active.provider,
        priceVersionId: active.priceVersionId,
      },
    ],
    policy: { routingPolicyId: active.routingPolicyId, policyVersion: active.routingPolicyVersion },
    now: Date.parse(active.expiresAt) - 1,
  });
  expect(result).toMatchObject({
    policyVersion: active.economicPolicyVersion,
    relationship: {
      relationshipId: 'mention-jev-kaana',
      capacity: {
        maxConcurrentRequests: 1,
        maxRequestsPerUtcDay: 3,
        qualificationBudget: { utcDay: '2026-10-05', expiresAt: active.expiresAt },
      },
    },
  });
});

const thirdQualificationApproval = (): MentionClassifierApproval => ({
  ...qualificationApproval(),
  economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.3',
  qualificationBudget: {
    utcDay: '2026-10-05',
    maxTotalRequests: 3,
    previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
  },
});
it('supports a separately reviewed synthetic third qualification independently of the frozen getter', () => {
  const result = mentionClassifierEconomicDecision({
    ...input(),
    approval: thirdQualificationApproval(),
    now: Date.parse('2026-10-05T05:00:00Z'),
  });
  expect(result).toMatchObject({
    policyVersion: 'oxy-mention-jev-native/2026-10-05.3',
    relationship: {
      relationshipId: 'mention-jev-kaana',
      capacity: {
        maxConcurrentRequests: 1,
        maxRequestsPerUtcDay: 3,
        scope: 'relationship',
        qualificationBudget: {
          utcDay: '2026-10-05',
          expiresAt: '2026-10-05T06:00:00Z',
        },
      },
    },
  });
  jest.useFakeTimers().setSystemTime(Date.parse(rootApproval.expiresAt) - 1);
  try {
    expect(mentionClassifierApproval()).toEqual(rootApproval);
  } finally {
    jest.useRealTimers();
  }
});
it.each([
  ['no budget', { qualificationBudget: undefined }],
  [
    'cap four',
    {
      qualificationBudget: {
        ...thirdQualificationApproval().qualificationBudget,
        maxTotalRequests: 4,
      },
    },
  ],
  [
    'cap two with third version',
    { qualificationBudget: qualificationApproval().qualificationBudget },
  ],
  [
    'wrong previous version',
    {
      qualificationBudget: {
        ...thirdQualificationApproval().qualificationBudget,
        previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.1',
      },
    },
  ],
  ['unknown version', { economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.4' }],
  [
    'second version with cap three',
    { economicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2' },
  ],
  [
    'next UTC day',
    {
      qualificationBudget: {
        ...thirdQualificationApproval().qualificationBudget,
        utcDay: '2026-10-06',
      },
    },
  ],
  ['expiry beyond fixed day', { expiresAt: '2026-10-06T00:00:01Z' }],
  ['unreviewed source', { evidenceRef: 'foreign' }],
])('refuses unsupported third qualification: %s', (_name, changes) => {
  expect(
    mentionClassifierEconomicDecision({
      ...input(),
      approval: { ...thirdQualificationApproval(), ...changes },
      now: Date.parse('2026-10-05T05:00:00Z'),
    } as Parameters<typeof mentionClassifierEconomicDecision>[0]),
  ).toBeUndefined();
});
it.each(['2026-10-04T23:59:59Z', '2026-10-06T00:00:00Z', '2026-10-05T06:00:00Z'])(
  'refuses the third qualification outside its day or expiry: %s',
  (now) => {
    expect(
      mentionClassifierEconomicDecision({
        ...input(),
        approval: thirdQualificationApproval(),
        now: Date.parse(now),
      }),
    ).toBeUndefined();
  },
);
it('isolates an inactive third approval nested budget from mutation', () => {
  const candidate = thirdQualificationApproval();
  const returned = cloneMentionClassifierApproval(candidate);
  if (returned.qualificationBudget === undefined) throw new Error('fixture budget missing');
  Object.assign(returned.qualificationBudget, { maxTotalRequests: 99 });
  expect(cloneMentionClassifierApproval(candidate).qualificationBudget).toEqual({
    utcDay: '2026-10-05',
    maxTotalRequests: 3,
    previousEconomicPolicyVersion: 'oxy-mention-jev-native/2026-10-05.2',
  });
});
