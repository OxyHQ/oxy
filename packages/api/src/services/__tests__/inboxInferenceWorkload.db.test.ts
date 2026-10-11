/**
 * Inbox point inference with NO key pair: the authority is the live binding of
 * the role this task runs as (ADR 0026), resolved in-process against real rows.
 *
 * Real Postgres, because every refusal below is decided by a join or a
 * predicate in `resolveLiveAgencyWorkloadByHandle` — which application a
 * binding names, whether it is expired, whether its attribution row exists —
 * and a mocked query would agree with whatever the test assumed. Only the two
 * things that leave the process are replaced: STS (what role this task is) and
 * the edge (what the authority is then used for).
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const mockOwnWorkloadIdentity = jest.fn();
const mockExecuteInferenceRequest = jest.fn();

jest.mock('../../config/inboxInference', () => {
  const actual = jest.requireActual('../../config/inboxInference');
  // A fresh application per file: the real Inbox id is one row in a database
  // other files share, and this file creates and deletes bindings against it.
  return {
    ...actual,
    INBOX_APPLICATION_ID: `inbox-test-${jest.requireActual('node:crypto').randomUUID()}`,
  };
});
jest.mock('../ownWorkloadIdentity.service', () => ({
  ownWorkloadIdentity: () => mockOwnWorkloadIdentity(),
}));
jest.mock('../httpKaanaClient', () => ({ createHttpKaanaClient: () => undefined }));
jest.mock('../inferenceEdge.service', () => ({
  allocateRequestId: () => 'req_inbox_workload_01',
  executeInferenceRequest: (...args: unknown[]) => mockExecuteInferenceRequest(...args),
  streamInferenceRequest: jest.fn(),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { INBOX_APPLICATION_ID } from '../../config/inboxInference';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import { workloadTokenEnvironment } from '../../utils/credentialEnvironment';
import { executeInboxPointInference } from '../inboxInference.service';
import { AttestationError, workloadAttestationHandle } from '../workloadAttestation.service';
import { ensureWorkloadAttributionIdentity } from '../workloadAttributionIdentity.service';

const ORIGINAL_ENV = { ...process.env };
let ownerAccountId: string;

beforeAll(async () => {
  await connectPostgres();
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  ownerAccountId = owner.id;
  await getDb()
    .insert(applications)
    .values({
      id: INBOX_APPLICATION_ID,
      name: `Oxy Inbox ${randomUUID()}`,
      ownerAccountId,
      status: 'active',
      type: 'first_party',
      scopes: ['capability-events:publish', 'catalogs:write', 'inference:invoke', 'user:read'],
      capabilities: [],
    });
});

afterAll(async () => {
  process.env = ORIGINAL_ENV;
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  // No pair, and a host that can attest: the workload path.
  process.env = { ...ORIGINAL_ENV, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task' };
  delete process.env.INBOX_APPLICATION_KEY;
  delete process.env.INBOX_APPLICATION_SECRET;
  mockExecuteInferenceRequest.mockResolvedValue({
    status: 'completed',
    completion: { requestId: 'req_inbox_workload_01', model: 'm', output: [] },
  });
});

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

/** A role, bound (or not) to `applicationId`, which this task then attests as. */
async function taskRunningAs(
  options: {
    applicationId?: string | null;
    scopes?: string[];
    expiresAt?: Date;
    attribute?: boolean;
  } = {},
) {
  const subject = `arn:aws:iam::237343248947:role/oxy-inbox-test-${randomUUID().slice(0, 8)}`;
  const applicationId =
    options.applicationId === undefined ? INBOX_APPLICATION_ID : options.applicationId;
  let bindingId: string | null = null;
  if (applicationId !== null) {
    const [binding] = await getDb()
      .insert(applicationWorkloadIdentities)
      .values({
        applicationId,
        provider: 'aws-iam',
        subject,
        description: 'Inbox workload test binding',
        scopes: options.scopes ?? [
          'capability-events:publish',
          'catalogs:write',
          'inference:invoke',
          'user:read',
        ],
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      })
      .returning({ id: applicationWorkloadIdentities.id });
    bindingId = binding.id;
    if (options.attribute !== false) {
      await ensureWorkloadAttributionIdentity({ bindingId, applicationId, subject });
    }
  }
  mockOwnWorkloadIdentity.mockResolvedValue({
    provider: 'aws-iam',
    subject,
    attestationId: workloadAttestationHandle(subject),
  });
  return { subject, bindingId, handle: workloadAttestationHandle(subject) };
}

async function otherApplication(): Promise<string> {
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Not Inbox ${randomUUID()}`,
      ownerAccountId,
      status: 'active',
      type: 'first_party',
      scopes: ['inference:invoke'],
      capabilities: [],
    })
    .returning({ id: applications.id });
  return application.id;
}

async function expectUnavailable(): Promise<void> {
  await expect(executeInboxPointInference(input())).rejects.toMatchObject({
    statusCode: 503,
    code: 'INBOX_INFERENCE_UNAVAILABLE',
  });
  expect(mockExecuteInferenceRequest).not.toHaveBeenCalled();
}

describe('Inbox point inference as the task role', () => {
  it('acts as Inbox through the binding of the role this task runs as', async () => {
    const task = await taskRunningAs();

    await executeInboxPointInference(input());

    const [context] = mockExecuteInferenceRequest.mock.calls[0] as [
      { principal: Record<string, unknown>; delegatedUserId: string },
    ];
    expect(context.principal).toEqual({
      lane: 'product_session',
      applicationId: INBOX_APPLICATION_ID,
      // The handle a token minted by this task carries, and the id of the
      // materialised row the usage ledger's foreign key names.
      credentialId: task.handle,
      ownerAccountId,
      environment: workloadTokenEnvironment(),
      scopes: ['capability-events:publish', 'catalogs:write', 'inference:invoke', 'user:read'],
      applicationType: 'first_party',
      applicationIsInternal: false,
    });
    expect(context.delegatedUserId).toBe('user_1');
  });

  it('refuses a role that is bound to no application', async () => {
    await taskRunningAs({ applicationId: null });
    await expectUnavailable();
  });

  it('refuses a role bound to a different application', async () => {
    await taskRunningAs({ applicationId: await otherApplication() });
    await expectUnavailable();
  });

  it('refuses a binding that does not name inference:invoke', async () => {
    await taskRunningAs({ scopes: ['capability-events:publish', 'catalogs:write', 'user:read'] });
    await expectUnavailable();
  });

  it('refuses an expired binding', async () => {
    await taskRunningAs({ expiresAt: new Date(Date.now() - 60_000) });
    await expectUnavailable();
  });

  it('refuses a binding with no attribution row for the ledger to name', async () => {
    await taskRunningAs({ attribute: false });
    await expectUnavailable();
  });

  it('stops on the next request once the binding is deleted', async () => {
    const task = await taskRunningAs();
    await executeInboxPointInference(input());
    expect(mockExecuteInferenceRequest).toHaveBeenCalledTimes(1);
    mockExecuteInferenceRequest.mockClear();

    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, task.bindingId as string));

    await expectUnavailable();
  });

  it('refuses when this task cannot prove what it is right now', async () => {
    mockOwnWorkloadIdentity.mockRejectedValue(
      new AttestationError('sts_unreachable', 'The attestation could not be verified right now.'),
    );
    await expectUnavailable();
  });

  it('refuses half a pair instead of falling back to the task role', async () => {
    await taskRunningAs();
    process.env.INBOX_APPLICATION_SECRET = 'leftover-secret';

    await expectUnavailable();
    expect(mockOwnWorkloadIdentity).not.toHaveBeenCalled();
  });
});
