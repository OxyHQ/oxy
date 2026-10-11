/**
 * Inbox point inference targets the `instant` power level by its fixed primary
 * key, never a deploy-configured profile, and surfaces the concrete model the
 * edge reports.
 */

const mockResolveCredentialAttribution = jest.fn();
const mockExecuteInferenceRequest = jest.fn();
const mockOwnWorkloadIdentity = jest.fn();
const mockResolveLiveAgencyWorkloadByHandle = jest.fn();
const mockWhere = jest.fn();

jest.mock('../../config/postgres', () => ({
  getDb: () => ({
    select: () => ({
      from: (table: { readonly name: string }) => ({
        where: (condition: unknown) => {
          mockWhere(table.name, condition);
          return {
            limit: async () =>
              table.name === 'applications'
                ? [{ type: 'first_party', isInternal: false }]
                : [{ id: 'power-instant' }],
          };
        },
      }),
    }),
  }),
}));
jest.mock('../../db/schema/applications', () => ({
  applications: {
    name: 'applications',
    id: 'applications.id',
    type: 'type',
    isInternal: 'isInternal',
  },
}));
jest.mock('../../db/schema/inferenceRoutingProfiles', () => ({
  inferenceRoutingProfiles: {
    name: 'inference_routing_profiles',
    id: 'inference_routing_profiles.id',
  },
}));
jest.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));
jest.mock('../attribution.service', () => ({
  resolveCredentialAttribution: (...args: unknown[]) => mockResolveCredentialAttribution(...args),
}));
jest.mock('../ownWorkloadIdentity.service', () => ({
  ownWorkloadIdentity: () => mockOwnWorkloadIdentity(),
}));
jest.mock('../agencyServicePrincipal.service', () => ({
  resolveLiveAgencyWorkloadByHandle: (...args: unknown[]) =>
    mockResolveLiveAgencyWorkloadByHandle(...args),
}));
jest.mock('../../utils/credentialEnvironment', () => ({
  workloadTokenEnvironment: () => 'production',
}));
jest.mock('../httpKaanaClient', () => ({ createHttpKaanaClient: () => undefined }));
jest.mock('../inferenceEdge.service', () => ({
  allocateRequestId: () => 'req_inbox_instant_01',
  executeInferenceRequest: (...args: unknown[]) => mockExecuteInferenceRequest(...args),
  streamInferenceRequest: jest.fn(),
}));

import { INBOX_APPLICATION_ID, INBOX_ROUTING_PROFILE_ID } from '../../config/inboxInference';
import { executeInboxPointInference } from '../inboxInference.service';

const ORIGINAL_ENV = { ...process.env };

function input() {
  return {
    userId: 'user_1',
    feature: 'thread_summary' as const,
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Summarise.' }] }],
    maxOutputTokens: 600,
    temperature: 0.4,
    signal: new AbortController().signal,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    INBOX_APPLICATION_KEY: 'oxy_pk_inbox',
    INBOX_APPLICATION_SECRET: 'oxy_sk_inbox',
  };
  delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
  delete process.env.INBOX_INFERENCE_ROUTING_PROFILE_ID;
  mockResolveCredentialAttribution.mockResolvedValue({
    status: 'resolved',
    attribution: {
      credentialId: 'cred_1',
      credentialType: 'service',
      credentialEnvironment: 'live',
      credentialScopes: ['inference:invoke'],
      applicationScopes: ['inference:invoke'],
      application: {
        applicationId: INBOX_APPLICATION_ID,
        applicationStatus: 'active',
        ownerAccountId: 'account_1',
      },
    },
  });
  mockExecuteInferenceRequest.mockResolvedValue({
    status: 'completed',
    completion: {
      requestId: 'req_inbox_instant_01',
      model: 'openai/gpt-oss-120b@observed-2026-09-01',
      output: [],
    },
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('Inbox point inference routing', () => {
  it('is the instant power level, by its fixed primary key', () => {
    expect(INBOX_ROUTING_PROFILE_ID).toBe('power-instant');
  });

  it('targets power-instant without any deploy-configured profile and keeps the concrete model', async () => {
    const completion = await executeInboxPointInference(input());

    expect(mockWhere).toHaveBeenCalledWith('inference_routing_profiles', {
      column: 'inference_routing_profiles.id',
      value: 'power-instant',
    });
    const [context] = mockExecuteInferenceRequest.mock.calls[0] as [
      { request: { target: unknown; labels: unknown } },
    ];
    expect(context.request.target).toEqual({
      kind: 'routing_profile_id',
      routingProfileId: 'power-instant',
    });
    expect(context.request.labels).toEqual({ product: 'inbox', feature: 'thread_summary' });
    expect(completion.model).toBe('openai/gpt-oss-120b@observed-2026-09-01');
  });

  it('ignores a leftover INBOX_INFERENCE_ROUTING_PROFILE_ID', async () => {
    process.env.INBOX_INFERENCE_ROUTING_PROFILE_ID = '01a06477-94f5-74f0-bc25-4c5c13b93ccd';

    await executeInboxPointInference(input());

    const [context] = mockExecuteInferenceRequest.mock.calls[0] as [
      { request: { target: unknown } },
    ];
    expect(context.request.target).toEqual({
      kind: 'routing_profile_id',
      routingProfileId: 'power-instant',
    });
  });

  it('still fails closed with no pair and no workload identity to prove', async () => {
    delete process.env.INBOX_APPLICATION_KEY;
    delete process.env.INBOX_APPLICATION_SECRET;

    await expect(executeInboxPointInference(input())).rejects.toMatchObject({
      code: 'INBOX_INFERENCE_UNAVAILABLE',
    });
    expect(mockOwnWorkloadIdentity).not.toHaveBeenCalled();
    expect(mockExecuteInferenceRequest).not.toHaveBeenCalled();
  });
});

describe('Inbox point inference identity', () => {
  it('keeps the key pair when one is configured, even on a host that can attest', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';

    await executeInboxPointInference(input());

    expect(mockResolveCredentialAttribution).toHaveBeenCalledWith('oxy_pk_inbox');
    expect(mockOwnWorkloadIdentity).not.toHaveBeenCalled();
    expect(mockResolveLiveAgencyWorkloadByHandle).not.toHaveBeenCalled();
    const [context] = mockExecuteInferenceRequest.mock.calls[0] as [
      { principal: { credentialId: string } },
    ];
    expect(context.principal.credentialId).toBe('cred_1');
  });

  it('refuses half a pair rather than attesting instead', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';
    delete process.env.INBOX_APPLICATION_SECRET;

    await expect(executeInboxPointInference(input())).rejects.toMatchObject({
      code: 'INBOX_INFERENCE_UNAVAILABLE',
    });
    expect(mockResolveCredentialAttribution).not.toHaveBeenCalled();
    expect(mockOwnWorkloadIdentity).not.toHaveBeenCalled();
    expect(mockExecuteInferenceRequest).not.toHaveBeenCalled();
  });

  it('asks for the binding of the pinned Inbox application and no other', async () => {
    delete process.env.INBOX_APPLICATION_KEY;
    delete process.env.INBOX_APPLICATION_SECRET;
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';
    const subject = 'arn:aws:iam::237343248947:role/oxy-oxy-api-task';
    mockOwnWorkloadIdentity.mockResolvedValue({
      provider: 'aws-iam',
      subject,
      attestationId: 'wl_000000000000000000000001',
    });
    mockResolveLiveAgencyWorkloadByHandle.mockResolvedValue({
      applicationId: INBOX_APPLICATION_ID,
      provider: 'aws-iam',
      subject,
      handle: 'wl_000000000000000000000001',
      ownerAccountId: 'account_1',
      scopes: ['inference:invoke'],
      capabilities: [],
    });

    await executeInboxPointInference(input());

    expect(mockResolveLiveAgencyWorkloadByHandle).toHaveBeenCalledWith(
      INBOX_APPLICATION_ID,
      'wl_000000000000000000000001',
    );
    expect(mockResolveCredentialAttribution).not.toHaveBeenCalled();
  });

  it('refuses a binding whose subject is not the role this task attested', async () => {
    delete process.env.INBOX_APPLICATION_KEY;
    delete process.env.INBOX_APPLICATION_SECRET;
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';
    mockOwnWorkloadIdentity.mockResolvedValue({
      provider: 'aws-iam',
      subject: 'arn:aws:iam::237343248947:role/oxy-oxy-api-task',
      attestationId: 'wl_000000000000000000000001',
    });
    mockResolveLiveAgencyWorkloadByHandle.mockResolvedValue({
      applicationId: INBOX_APPLICATION_ID,
      provider: 'aws-iam',
      subject: 'arn:aws:iam::237343248947:role/some-other-task',
      handle: 'wl_000000000000000000000001',
      ownerAccountId: 'account_1',
      scopes: ['inference:invoke'],
      capabilities: [],
    });

    await expect(executeInboxPointInference(input())).rejects.toMatchObject({
      code: 'INBOX_INFERENCE_UNAVAILABLE',
    });
    expect(mockExecuteInferenceRequest).not.toHaveBeenCalled();
  });
});
