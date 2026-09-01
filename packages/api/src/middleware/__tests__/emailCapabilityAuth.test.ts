jest.mock('mongoose', () => jest.requireActual('mongoose'));

import type { NextFunction, Response } from 'express';
import mongoose from 'mongoose';
import type { CapabilityTicketClaims, PolicyDecision } from '@oxyhq/contracts';
import { issueCapabilityTicket } from '@oxyhq/core/server';

const mockReauthorize = jest.fn<Promise<PolicyDecision>, [CapabilityTicketClaims]>();
const mockMailboxExists = jest.fn();
const mockMessageExists = jest.fn();
const mockAuditWrite = jest.fn();
const mockIdempotencyCreate = jest.fn();
const mockIdempotencyFindOneAndUpdate = jest.fn();

jest.mock('../../services/capabilityAuthority.service', () => ({
  capabilityTicketSecret: () => Buffer.from('capability-test-secret-that-is-long-enough'),
  reauthorizeCapabilityTicket: (...args: [CapabilityTicketClaims]) => mockReauthorize(...args),
}));
jest.mock('../../models/Mailbox', () => ({
  __esModule: true,
  default: { exists: (...args: unknown[]) => mockMailboxExists(...args) },
}));
jest.mock('../../models/Message', () => ({
  __esModule: true,
  default: { exists: (...args: unknown[]) => mockMessageExists(...args) },
}));
jest.mock('../../models/CapabilityAuditEvent', () => ({
  CapabilityAuditEvent: { findOneAndUpdate: (...args: unknown[]) => mockAuditWrite(...args) },
}));
jest.mock('../../models/CapabilityIdempotencyKey', () => ({
  CapabilityIdempotencyKey: {
    create: (...args: unknown[]) => mockIdempotencyCreate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockIdempotencyFindOneAndUpdate(...args),
    updateOne: jest.fn(),
  },
}));
jest.mock('../auth', () => ({ authMiddleware: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  emailCapabilityAuth,
  type EmailCapabilityRequest,
} from '../emailCapabilityAuth';

const SECRET = Buffer.from('capability-test-secret-that-is-long-enough');
const ACCOUNT_ID = new mongoose.Types.ObjectId().toHexString();
const OWNER_ID = new mongoose.Types.ObjectId().toHexString();
const AGENT_ID = new mongoose.Types.ObjectId().toHexString();
const MAILBOX_ID = new mongoose.Types.ObjectId().toHexString();
const MESSAGE_ID = new mongoose.Types.ObjectId().toHexString();

function ticket(
  tool: string,
  resourceType: 'mailbox' | 'email_account' = 'mailbox',
): string {
  const claims: Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'> = {
    aud: 'oxy-inbox-api',
    sub: AGENT_ID,
    runId: 'run-1',
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
    secret: SECRET,
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
  mockMailboxExists.mockReset().mockResolvedValue({ _id: MAILBOX_ID });
  mockMessageExists.mockReset().mockResolvedValue({ _id: MESSAGE_ID });
  mockAuditWrite.mockReset().mockResolvedValue({});
  mockIdempotencyCreate.mockReset().mockResolvedValue({});
  mockIdempotencyFindOneAndUpdate.mockReset().mockResolvedValue(null);
});

describe('emailCapabilityAuth', () => {
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
    mockMessageExists.mockResolvedValueOnce(null);
    const result = await run(request({
      method: 'GET',
      path: `/messages/${MESSAGE_ID}`,
      token: ticket('readEmail'),
    }));

    expect(mockMessageExists).toHaveBeenCalledWith({
      _id: MESSAGE_ID,
      userId: ACCOUNT_ID,
      mailboxId: MAILBOX_ID,
    });
    expect(result.res.statusCode).toBe(403);
    expect(result.res.body).toEqual({ error: 'capability_resource_mismatch' });
    expect(result.next).not.toHaveBeenCalled();
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
  });

  it('prevents and audits a duplicate external effect under the same idempotency key', async () => {
    const duplicate = new mongoose.mongo.MongoServerError({
      message: 'duplicate key',
      code: 11000,
    });
    mockIdempotencyCreate.mockRejectedValueOnce(duplicate);
    const result = await run(request({
      method: 'POST',
      path: `/messages/${MESSAGE_ID}/move`,
      token: ticket('moveEmail'),
      body: { mailboxId: new mongoose.Types.ObjectId().toHexString() },
      idempotencyKey: 'run-1:move-email',
    }));

    expect(result.res.statusCode).toBe(409);
    expect(result.res.body).toEqual({ error: 'duplicate_effect_prevented' });
    expect(result.next).not.toHaveBeenCalled();
    expect(mockIdempotencyFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
      expect.any(Object),
      { new: true },
    );
    expect(mockAuditWrite).toHaveBeenCalledTimes(1);
    expect(mockAuditWrite.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      $setOnInsert: expect.objectContaining({
        event: expect.objectContaining({
          policyDecision: { allowed: false, reason: 'duplicate_effect_prevented' },
          result: expect.objectContaining({ code: '409' }),
        }),
      }),
    }));
  });
});
