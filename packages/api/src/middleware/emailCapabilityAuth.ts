import { createHash, randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import type { CapabilityTicketClaims, PolicyDecision } from '@oxyhq/contracts';
import {
  CapabilityTicketError,
  inputSatisfiesCapabilityLimits,
  readCapabilityAuthorization,
  verifyCapabilityTicket,
} from '@oxyhq/core/server';
import { INBOX_CAPABILITY_CATALOG } from '../capabilities/inbox.catalog';
import { authMiddleware, type AuthRequest } from './auth';
import { CapabilityAuditEvent } from '../models/CapabilityAuditEvent';
import { CapabilityIdempotencyKey } from '../models/CapabilityIdempotencyKey';
import Mailbox from '../models/Mailbox';
import Message from '../models/Message';
import {
  capabilityTicketSecret,
  reauthorizeCapabilityTicket,
} from '../services/capabilityAuthority.service';
import { logger } from '../utils/logger';

export interface EmailCapabilityRequest extends Request {
  user?: { id: string };
  capabilityTicket?: CapabilityTicketClaims;
}

function expectedTool(request: Request): string | null {
  const path = request.path;
  if (request.method === 'GET' && path === '/search') return 'searchEmails';
  if (request.method === 'GET' && path === '/messages') return 'getUnreadEmails';
  if (request.method === 'GET' && /^\/messages\/[^/]+$/.test(path)) return 'readEmail';
  if (request.method === 'GET' && /^\/messages\/[^/]+\/thread$/.test(path)) return 'getEmailThread';
  if (request.method === 'POST' && path === '/messages') return 'sendEmail';
  if (request.method === 'GET' && path === '/mailboxes') return 'listMailboxes';
  if (request.method === 'GET' && path === '/labels') return 'listLabels';
  if (request.method === 'POST' && /^\/messages\/[^/]+\/move$/.test(path)) return 'moveEmail';
  if (request.method === 'PUT' && /^\/messages\/[^/]+\/flags$/.test(path)) return 'updateEmailFlags';
  if (request.method === 'GET' && path === '/quota') return 'getEmailQuota';
  if (request.method === 'GET' && path === '/ai-context') return 'getEmailContext';
  return null;
}

function messageIdFromPath(path: string): string | null {
  const match = path.match(/^\/messages\/([^/]+)(?:\/(?:thread|move|flags))?$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function inputOf(request: Request): Record<string, unknown> {
  return request.method === 'GET'
    ? { ...request.query }
    : typeof request.body === 'object' && request.body !== null ? request.body as Record<string, unknown> : {};
}

async function auditResult(
  claims: CapabilityTicketClaims,
  decision: PolicyDecision,
  statusCode: number,
  idempotencyKey?: string,
): Promise<void> {
  const tool = INBOX_CAPABILITY_CATALOG.tools.find((entry) => entry.name === claims.tool);
  const event = {
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    requesterAccountId: claims.requesterAccountId,
    coordinator: { type: 'alia' as const, ownerAccountId: claims.ownerAccountId },
    executor: claims.actor,
    effectiveAccountId: claims.resource.effectiveAccountId,
    resource: claims.resource,
    appId: claims.resource.appId,
    tool: claims.tool,
    capabilities: claims.capabilities,
    policyDecision: decision,
    result: {
      status: statusCode >= 200 && statusCode < 400 ? 'succeeded' as const : 'failed' as const,
      code: String(statusCode),
    },
    rollback: { supported: tool?.rollback === 'supported', attempted: false },
    correlation: {
      runId: claims.runId,
      ...(claims.stepId ? { stepId: claims.stepId } : {}),
      ...(claims.automationId ? { automationId: claims.automationId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      capabilityTicketId: claims.jti,
    },
  };
  await CapabilityAuditEvent.findOneAndUpdate(
    { eventId: event.eventId },
    { $setOnInsert: { eventId: event.eventId, event } },
    { upsert: true },
  );
}

async function reserveIdempotency(
  claims: CapabilityTicketClaims,
  rawKey: string,
): Promise<{ allowed: boolean; keyHash: string }> {
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const selector = {
    effectiveAccountId: claims.resource.effectiveAccountId,
    appId: claims.resource.appId,
    tool: claims.tool,
    keyHash,
  };
  try {
    await CapabilityIdempotencyKey.create({ ...selector, ticketId: claims.jti, status: 'started' });
    return { allowed: true, keyHash };
  } catch (error) {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
    const reclaimed = await CapabilityIdempotencyKey.findOneAndUpdate(
      { ...selector, status: 'failed' },
      { $set: { status: 'started', ticketId: claims.jti }, $unset: { responseStatus: 1 } },
      { new: true },
    );
    return { allowed: Boolean(reclaimed), keyHash };
  }
}

async function resourceMatches(request: EmailCapabilityRequest, claims: CapabilityTicketClaims): Promise<boolean> {
  if (claims.resource.appId !== 'inbox') return false;
  const accountId = claims.resource.effectiveAccountId;
  if (!mongoose.isValidObjectId(accountId)) return false;
  if (claims.resource.resourceType === 'email_account') return claims.resource.resourceId === accountId;
  if (claims.resource.resourceType !== 'mailbox' || !mongoose.isValidObjectId(claims.resource.resourceId)) return false;
  const mailbox = await Mailbox.exists({ _id: claims.resource.resourceId, userId: accountId });
  if (!mailbox) return false;
  if (request.path === '/search' || request.path === '/messages' || request.path === '/ai-context') {
    request.query.mailbox = claims.resource.resourceId;
    if (request.path === '/messages') request.query.unseen = 'true';
  }
  const messageId = messageIdFromPath(request.path);
  if (messageId) {
    if (!mongoose.isValidObjectId(messageId)) return false;
    const message = await Message.exists({
      _id: messageId,
      userId: accountId,
      mailboxId: claims.resource.resourceId,
    });
    if (!message) return false;
  }
  return true;
}

export async function emailCapabilityAuth(
  request: EmailCapabilityRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token = readCapabilityAuthorization(request.header('authorization'));
  if (!token) {
    authMiddleware(request as AuthRequest, response, next);
    return;
  }
  let claims: CapabilityTicketClaims;
  try {
    claims = verifyCapabilityTicket(token, {
      audience: INBOX_CAPABILITY_CATALOG.audience,
      issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
      secret: capabilityTicketSecret(),
    });
  } catch (error) {
    const code = error instanceof CapabilityTicketError ? error.code : 'invalid_claims';
    response.status(401).json({ error: 'invalid_capability_ticket', code });
    return;
  }
  const expected = expectedTool(request);
  if (!expected || expected !== claims.tool) {
    response.status(403).json({ error: 'capability_tool_mismatch' });
    return;
  }
  const decision = await reauthorizeCapabilityTicket(claims);
  if (!decision.allowed) {
    await auditResult(claims, decision, 403);
    response.status(403).json({ error: 'capability_revoked_or_denied', reason: decision.reason });
    return;
  }
  if (!await resourceMatches(request, claims)) {
    const resourceDecision = { allowed: false, reason: 'capability_resource_mismatch' } as const;
    await auditResult(claims, resourceDecision, 403);
    response.status(403).json({ error: 'capability_resource_mismatch' });
    return;
  }
  if (!inputSatisfiesCapabilityLimits(inputOf(request), claims.limits)) {
    const limitDecision = { allowed: false, reason: 'capability_limit_exceeded' } as const;
    await auditResult(claims, limitDecision, 403);
    response.status(403).json({ error: 'capability_limit_exceeded' });
    return;
  }
  const tool = INBOX_CAPABILITY_CATALOG.tools.find((entry) => entry.name === claims.tool);
  let keyHash: string | undefined;
  if (tool?.idempotency === 'required') {
    const rawKey = request.header('idempotency-key');
    if (!rawKey) {
      await auditResult(claims, { allowed: false, reason: 'idempotency_key_required' }, 400);
      response.status(400).json({ error: 'idempotency_key_required' });
      return;
    }
    const reservation = await reserveIdempotency(claims, rawKey);
    keyHash = reservation.keyHash;
    if (!reservation.allowed) {
      await auditResult(
        claims,
        { allowed: false, reason: 'duplicate_effect_prevented' },
        409,
        keyHash,
      );
      response.status(409).json({ error: 'duplicate_effect_prevented' });
      return;
    }
  }
  request.user = { id: claims.resource.effectiveAccountId };
  request.capabilityTicket = claims;
  response.once('finish', () => {
    if (keyHash) {
      void CapabilityIdempotencyKey.updateOne(
        { effectiveAccountId: claims.resource.effectiveAccountId, appId: claims.resource.appId, tool: claims.tool, keyHash },
        { $set: { status: response.statusCode < 400 ? 'succeeded' : 'failed', responseStatus: response.statusCode } },
      ).catch((error: unknown) => logger.error('Failed to finalize capability idempotency key', error));
    }
    void auditResult(claims, decision, response.statusCode, keyHash)
      .catch((error: unknown) => logger.error('Failed to persist capability audit event', error));
  });
  next();
}
