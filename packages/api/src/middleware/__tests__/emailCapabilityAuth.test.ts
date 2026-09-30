import type { NextFunction, Response } from 'express';
import { generateKeyPairSync } from 'node:crypto';
import type { CapabilityTicketClaims, PolicyDecision } from '@oxy.so/contracts';
import { issueCapabilityTicket } from '@oxy.so/core/server';

const mockReauthorize = jest.fn<Promise<PolicyDecision>, [CapabilityTicketClaims]>();
const mockMailboxExists = jest.fn();
const mockToolRun = jest.fn();
const mockAuditWrite = jest.fn();
const mockIdempotencyReserve = jest.fn();
const mockIdempotencyFinalize = jest.fn();
const mockKeyPair = generateKeyPairSync('ed25519');

jest.mock('../../services/capabilityAuthority.service', () => ({
  reauthorizeCapabilityTicket: (...args: [CapabilityTicketClaims]) => mockReauthorize(...args),
}));
jest.mock('../../config/capabilityTicketSigning', () => ({
  capabilityTicketSigningConfig: () => ({
    keyId: 'test-key',
    privateKey: mockKeyPair.privateKey,
    publicKey: mockKeyPair.publicKey,
  }),
}));
jest.mock('../../services/capabilityRuntimeStore.service', () => ({
  mailboxBelongsToAccount: (...args: unknown[]) => mockMailboxExists(...args),
  persistCapabilityAuditEvent: (...args: unknown[]) => mockAuditWrite(...args),
  reserveCapabilityEffect: (...args: unknown[]) => mockIdempotencyReserve(...args),
  finalizeCapabilityEffect: (...args: unknown[]) => mockIdempotencyFinalize(...args),
}));
jest.mock('../auth', () => ({ authMiddleware: jest.fn() }));
// The middleware's job ends at dispatch: every tool resolves to this one spy,
// so a test can see WHICH tool ran with WHAT input and scope. What the tools
// do is `inbox.tools.test.ts`; both together, through HTTP, is
// `capabilities/__tests__/inbox.contract.test.ts`.
jest.mock('../../capabilities/inbox.tools', () => {
  const { INBOX_CAPABILITY_CATALOG } = jest.requireActual('../../capabilities/inbox.catalog');
  return {
    INBOX_TOOLS: Object.fromEntries(INBOX_CAPABILITY_CATALOG.tools.map((tool: { name: string }) => [
      tool.name,
      (input: unknown, context: unknown) => mockToolRun(tool.name, input, context),
    ])),
  };
});
jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import type { Request } from 'express';
import type { GrantLimit } from '@oxy.so/contracts';
import { emailCapabilityAuth } from '../emailCapabilityAuth';

const ACCOUNT_ID = 'account_test_1';
const OWNER_ID = 'owner_test_1';
const AGENT_ID = 'agent_test_1';
const MAILBOX_ID = 'mailbox_test_1';
const MESSAGE_ID = 'message_test_1';

function ticket(
  tool: string,
  resourceType: 'mailbox' | 'email_account' = 'mailbox',
  limits: GrantLimit[] = [],
): string {
  const claims: Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'> = {
    aud: 'oxy-inbox-api',
    sub: AGENT_ID,
    runId: 'run-1',
    executionAuthorization: { kind: 'direct_request', id: 'authorization-1' },
    coordinator: { applicationId: 'alia-app', credentialId: 'alia-credential' },
    requesterAccountId: OWNER_ID,
    ownerAccountId: OWNER_ID,
    actor: { type: 'agent', accountId: AGENT_ID },
    resource: {
      appId: 'inbox',
      effectiveAccountId: ACCOUNT_ID,
      resourceType,
      resourceId: resourceType === 'mailbox' ? MAILBOX_ID : ACCOUNT_ID,
    },
    tool,
    capabilities: tool === 'readEmail' ? ['email.read'] : ['email.organize'],
    limits,
    autonomy: 'execute_on_request',
  };
  return issueCapabilityTicket(claims, {
    issuer: 'https://api.oxy.so',
    privateKey: mockKeyPair.privateKey,
    keyId: 'test-key',
    ttlSeconds: 60,
  });
}

interface TestResponse extends Response {
  body?: unknown;
  finish?: () => void;
}

function response(): TestResponse {
  const result = {
    statusCode: 200,
    body: undefined as unknown,
    finish: undefined as (() => void) | undefined,
    status(code: number) {
      result.statusCode = code;
      return result;
    },
    json(body: unknown) {
      result.body = body;
      return result;
    },
    once(event: string, listener: () => void) {
      if (event === 'finish') result.finish = listener;
      return result;
    },
  };
  return result as unknown as TestResponse;
}

function request(input: {
  method: string;
  path: string;
  token: string;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  idempotencyKey?: string;
}): Request {
  const headers: Record<string, string> = {
    authorization: `Capability ${input.token}`,
    ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
  };
  return {
    method: input.method,
    // Mounted at /email, as in server.ts: the catalog names the full path.
    baseUrl: '/email',
    path: input.path,
    query: input.query ?? {},
    body: input.body ?? {},
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

async function run(req: Request) {
  const res = response();
  const next = jest.fn() as NextFunction;
  await emailCapabilityAuth(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  mockReauthorize.mockReset().mockResolvedValue({
    allowed: true,
    reason: 'allowed_by_current_authority',
    effectiveAutonomy: 'execute_on_request',
    grantId: 'grant-1',
  });
  mockMailboxExists.mockReset().mockResolvedValue(true);
  mockToolRun.mockReset().mockResolvedValue({ data: { ok: true } });
  mockAuditWrite.mockReset().mockResolvedValue(undefined);
  mockIdempotencyReserve.mockReset().mockResolvedValue(true);
  mockIdempotencyFinalize.mockReset().mockResolvedValue(undefined);
});

describe('emailCapabilityAuth', () => {
  it('requires an idempotency header before validating an effectful body', async () => {
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}/move`,
      token: ticket('moveEmail'),
      body: { mailbox: 'archive' },
    }));

    expect(result.res.statusCode).toBe(400);
    expect(result.res.body).toEqual({ error: 'idempotency_key_required' });
    expect(result.next).not.toHaveBeenCalled();
    expect(mockReauthorize).not.toHaveBeenCalled();
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
  });

  it('validates the catalog input before authority and effect reservation', async () => {
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}/move`,
      token: ticket('moveEmail'),
      body: {},
      idempotencyKey: 'run-1:invalid-move',
    }));

    expect(result.res.statusCode).toBe(400);
    expect(result.res.body).toEqual({
      error: 'capability_input_schema_mismatch',
      details: [{ path: '/', message: "must have required property 'mailbox'" }],
    });
    expect(result.next).not.toHaveBeenCalled();
    expect(mockReauthorize).not.toHaveBeenCalled();
    expect(mockIdempotencyReserve).not.toHaveBeenCalled();
  });

  it('requires the catalog method and path to identify the signed tool', async () => {
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}`,
      token: ticket('readEmail'),
    }));

    expect(result.res.statusCode).toBe(403);
    expect(result.res.body).toEqual({ error: 'capability_tool_mismatch' });
    expect(result.next).not.toHaveBeenCalled();
    expect(mockReauthorize).not.toHaveBeenCalled();
  });

  it('blocks a ticket revoked after planning and before the handler runs', async () => {
    mockReauthorize.mockResolvedValueOnce({ allowed: false, reason: 'grant_revoked' });
    const result = await run(request({
      method: 'GET',
      path: `/messages/${MESSAGE_ID}`,
      token: ticket('readEmail'),
    }));

    expect(result.res.statusCode).toBe(403);
    expect(result.res.body).toEqual({
      error: 'capability_revoked_or_denied',
      reason: 'grant_revoked',
    });
    expect(result.next).not.toHaveBeenCalled();
    expect(mockMailboxExists).not.toHaveBeenCalled();
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
  });

  it('executes the ticket tool with its canonical input and mailbox scope, and answers with its result', async () => {
    mockToolRun.mockResolvedValueOnce({ data: { id: MESSAGE_ID } });
    const result = await run(request({
      method: 'GET',
      path: `/messages/${MESSAGE_ID}`,
      token: ticket('readEmail'),
    }));

    expect(mockMailboxExists).toHaveBeenCalledWith(MAILBOX_ID, ACCOUNT_ID);
    expect(mockToolRun).toHaveBeenCalledWith(
      'readEmail',
      { emailId: MESSAGE_ID },
      { accountId: ACCOUNT_ID, mailboxId: MAILBOX_ID },
    );
    expect(result.res.statusCode).toBe(200);
    expect(result.res.body).toEqual({ data: { id: MESSAGE_ID } });
    // Ticket requests never fall through to the REST controllers.
    expect(result.next).not.toHaveBeenCalled();
    result.res.finish?.();
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
  });

  it('scopes an account ticket to the whole account', async () => {
    await run(request({
      method: 'GET',
      path: '/unread',
      token: ticket('getUnreadEmails', 'email_account'),
    }));

    expect(mockMailboxExists).not.toHaveBeenCalled();
    expect(mockToolRun).toHaveBeenCalledWith('getUnreadEmails', { limit: 20 }, { accountId: ACCOUNT_ID });
  });

  it('refuses a mailbox that is not the account\'s and a resource type the tool does not take', async () => {
    mockMailboxExists.mockResolvedValueOnce(false);
    const foreign = await run(request({
      method: 'GET',
      path: `/messages/${MESSAGE_ID}`,
      token: ticket('readEmail'),
    }));
    expect(foreign.res.statusCode).toBe(403);
    expect(foreign.res.body).toEqual({ error: 'capability_resource_mismatch' });

    const accountOnly = await run(request({
      method: 'GET',
      path: '/mailboxes',
      token: ticket('listMailboxes', 'mailbox'),
    }));
    expect(accountOnly.res.statusCode).toBe(403);
    expect(accountOnly.res.body).toEqual({ error: 'capability_resource_mismatch' });
    expect(mockToolRun).not.toHaveBeenCalled();
    expect(mockAuditWrite).toHaveBeenCalledTimes(2);
  });

  it('passes the idempotency header to an effect as context, never as tool input', async () => {
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}/move`,
      token: ticket('moveEmail'),
      body: { mailbox: 'archive' },
      idempotencyKey: 'run-1:move-email',
    }));

    expect(result.res.statusCode).toBe(200);
    expect(mockToolRun).toHaveBeenCalledWith(
      'moveEmail',
      { emailId: MESSAGE_ID, mailbox: 'archive' },
      { accountId: ACCOUNT_ID, mailboxId: MAILBOX_ID, idempotencyKey: 'run-1:move-email' },
    );
    result.res.finish?.();
    expect(mockIdempotencyFinalize).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'moveEmail' }),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      200,
    );
  });

  it('refuses a model-supplied idempotencyKey argument: the key is transport metadata', async () => {
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}/move`,
      token: ticket('moveEmail'),
      body: { mailbox: 'archive', idempotencyKey: 'invented-by-the-model' },
      idempotencyKey: 'run-1:move-email',
    }));

    expect(result.res.statusCode).toBe(400);
    expect(result.res.body).toMatchObject({
      error: 'capability_input_schema_mismatch',
      details: [{ path: '/', message: 'unknown property idempotencyKey' }],
    });
    expect(mockToolRun).not.toHaveBeenCalled();
  });

  it('bounds an omitted page size by the signed limit and still refuses an explicit excess', async () => {
    const capped = [{ tool: 'getUnreadEmails', key: 'limit', value: 5 }];
    const omitted = await run(request({
      method: 'GET',
      path: '/unread',
      token: ticket('getUnreadEmails', 'email_account', capped),
    }));
    expect(omitted.res.statusCode).toBe(200);
    expect(mockToolRun).toHaveBeenCalledWith('getUnreadEmails', { limit: 5 }, { accountId: ACCOUNT_ID });

    const explicit = await run(request({
      method: 'GET',
      path: '/unread',
      query: { limit: '50' },
      token: ticket('getUnreadEmails', 'email_account', capped),
    }));
    expect(explicit.res.statusCode).toBe(403);
    expect(explicit.res.body).toEqual({ error: 'capability_limit_exceeded' });
    expect(mockToolRun).toHaveBeenCalledTimes(1);
  });

  it('hands a tool failure to the error handler and settles the effect with its status', async () => {
    const failure = Object.assign(new Error('Email not found'), { statusCode: 404 });
    mockToolRun.mockRejectedValueOnce(failure);
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}/trash`,
      token: ticket('trashEmail'),
      idempotencyKey: 'run-1:trash',
    }));

    expect(result.next).toHaveBeenCalledWith(failure);
    expect(mockIdempotencyReserve).toHaveBeenCalledTimes(1);
  });

  it('prevents and audits a duplicate external effect under the same idempotency key', async () => {
    mockIdempotencyReserve.mockResolvedValueOnce(false);
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}/move`,
      token: ticket('moveEmail'),
      body: { mailbox: 'archive' },
      idempotencyKey: 'run-1:move-email',
    }));

    expect(result.res.statusCode).toBe(409);
    expect(result.res.body).toEqual({ error: 'duplicate_effect_prevented' });
    expect(result.next).not.toHaveBeenCalled();
    expect(mockIdempotencyReserve).toHaveBeenCalledTimes(1);
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    expect(mockAuditWrite.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      policyDecision: { allowed: false, reason: 'duplicate_effect_prevented' },
      result: expect.objectContaining({ code: '409' }),
    }));
  });
});
