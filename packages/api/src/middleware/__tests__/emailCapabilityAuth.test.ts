import type { NextFunction, Response } from 'express';
import { generateKeyPairSync } from 'node:crypto';
import type { CapabilityTicketClaims, PolicyDecision } from '@oxyhq/contracts';
import { issueCapabilityTicket } from '@oxyhq/core/server';

const mockReauthorize = jest.fn<Promise<PolicyDecision>, [CapabilityTicketClaims]>();
const mockMailboxExists = jest.fn();
const mockMessageExists = jest.fn();
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
  messageBelongsToMailbox: (...args: unknown[]) => mockMessageExists(...args),
  messageBelongsToAccount: (...args: unknown[]) => mockMessageExists(...args),
  persistCapabilityAuditEvent: (...args: unknown[]) => mockAuditWrite(...args),
  reserveCapabilityEffect: (...args: unknown[]) => mockIdempotencyReserve(...args),
  finalizeCapabilityEffect: (...args: unknown[]) => mockIdempotencyFinalize(...args),
}));
jest.mock('../auth', () => ({ authMiddleware: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  emailCapabilityAuth,
  type EmailCapabilityRequest,
} from '../emailCapabilityAuth';

const ACCOUNT_ID = 'account_test_1';
const OWNER_ID = 'owner_test_1';
const AGENT_ID = 'agent_test_1';
const MAILBOX_ID = 'mailbox_test_1';
const MESSAGE_ID = 'message_test_1';

function ticket(
  tool: string,
  resourceType: 'mailbox' | 'email_account' = 'mailbox',
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
    limits: [],
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
  idempotencyKey?: string;
}): EmailCapabilityRequest {
  const headers: Record<string, string> = {
    authorization: `Capability ${input.token}`,
    ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
  };
  return {
    method: input.method,
    path: input.path,
    query: {},
    body: input.body ?? {},
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as EmailCapabilityRequest;
}

async function run(req: EmailCapabilityRequest) {
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
  mockMessageExists.mockReset().mockResolvedValue(true);
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
      body: { mailboxId: 'mailbox_test_2' },
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
    expect(result.res.body).toEqual({ error: 'capability_input_schema_mismatch' });
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

  it('rejects a message outside the exact delegated mailbox', async () => {
    mockMessageExists.mockResolvedValueOnce(false);
    const result = await run(request({
      method: 'GET',
      path: `/messages/${MESSAGE_ID}`,
      token: ticket('readEmail'),
    }));

    expect(mockMessageExists).toHaveBeenCalledWith(MESSAGE_ID, ACCOUNT_ID, MAILBOX_ID);
    expect(result.res.statusCode).toBe(403);
    expect(result.res.body).toEqual({ error: 'capability_resource_mismatch' });
    expect(result.next).not.toHaveBeenCalled();
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
  });

  it('prevents and audits a duplicate external effect under the same idempotency key', async () => {
    mockIdempotencyReserve.mockResolvedValueOnce(false);
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}/move`,
      token: ticket('moveEmail'),
      body: { mailboxId: 'mailbox_test_2' },
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
