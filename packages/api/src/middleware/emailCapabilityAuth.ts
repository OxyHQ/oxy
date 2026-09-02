import { createHash, randomUUID } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { NextFunction, Request, Response } from 'express';
import type { CapabilityTicketClaims, CatalogTool, PolicyDecision } from '@oxyhq/contracts';
import {
  CapabilityTicketError,
  inputSatisfiesCapabilityLimits,
  readCapabilityAuthorization,
  verifyCapabilityTicket,
} from '@oxyhq/core/server';
import { INBOX_CAPABILITY_CATALOG } from '../capabilities/inbox.catalog';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { reauthorizeCapabilityTicket } from '../services/capabilityAuthority.service';
import {
  finalizeCapabilityEffect,
  mailboxBelongsToAccount,
  messageBelongsToAccount,
  messageBelongsToMailbox,
  persistCapabilityAuditEvent,
  reserveCapabilityEffect,
} from '../services/capabilityRuntimeStore.service';
import { logger } from '../utils/logger';
import { authMiddleware, type AuthRequest } from './auth';

export interface EmailCapabilityRequest extends Request {
  user?: { id: string };
  capabilityTicket?: CapabilityTicketClaims;
}

interface CatalogInvocationMatch {
  readonly tool: CatalogTool;
  readonly params: Record<string, string>;
}

const schemaValidator = addFormats(new Ajv({ allErrors: true, coerceTypes: true, strict: true }));
const inputValidators = new Map<string, ValidateFunction>(
  INBOX_CAPABILITY_CATALOG.tools.map((tool) => [tool.name, schemaValidator.compile(tool.inputSchema)]),
);

function matchCatalogInvocation(request: Request): CatalogInvocationMatch | null {
  for (const tool of INBOX_CAPABILITY_CATALOG.tools) {
    if (tool.invocation.method !== request.method) continue;
    const catalogSegments = tool.invocation.path.replace(/^\/email/, '').split('/').filter(Boolean);
    const requestSegments = request.path.split('/').filter(Boolean);
    if (catalogSegments.length !== requestSegments.length) continue;
    const params: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < catalogSegments.length; index += 1) {
      const catalogSegment = catalogSegments[index];
      const requestSegment = requestSegments[index];
      if (!catalogSegment || !requestSegment) {
        matches = false;
        break;
      }
      const parameter = catalogSegment.match(/^\{([A-Za-z][A-Za-z0-9_]*)\}$/)?.[1];
      if (parameter) {
        try {
          params[parameter] = decodeURIComponent(requestSegment);
        } catch {
          matches = false;
          break;
        }
      } else if (catalogSegment !== requestSegment) {
        matches = false;
        break;
      }
    }
    if (matches) return { tool, params };
  }
  return null;
}

function validatedCanonicalInput(
  request: Request,
  invocation: CatalogInvocationMatch,
): Record<string, unknown> | null {
  const body = typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {};
  const input: Record<string, unknown> = {
    ...(request.method === 'GET' ? request.query : {}),
    ...body,
    ...invocation.params,
  };
  const validateInput = inputValidators.get(invocation.tool.name);
  return validateInput?.(input) ? input : null;
}

async function auditResult(
  claims: CapabilityTicketClaims,
  decision: PolicyDecision,
  statusCode: number,
  idempotencyKeyHash?: string,
): Promise<void> {
  const tool = INBOX_CAPABILITY_CATALOG.tools.find((entry) => entry.name === claims.tool);
  await persistCapabilityAuditEvent({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    requesterAccountId: claims.requesterAccountId,
    coordinator: claims.coordinator,
    executor: claims.actor,
    effectiveAccountId: claims.resource.effectiveAccountId,
    resource: claims.resource,
    appId: claims.resource.appId,
    tool: claims.tool,
    capabilities: claims.capabilities,
    policyDecision: decision,
    result: {
      status: statusCode >= 200 && statusCode < 400 ? 'succeeded' : 'failed',
      code: String(statusCode),
    },
    rollback: { supported: tool?.rollback === 'supported', attempted: false },
    correlation: {
      runId: claims.runId,
      ...(claims.stepId ? { stepId: claims.stepId } : {}),
      ...(claims.automationId ? { automationId: claims.automationId } : {}),
      ...(idempotencyKeyHash ? { idempotencyKeyHash } : {}),
      capabilityTicketId: claims.jti,
    },
  });
}

async function resourceMatches(
  request: EmailCapabilityRequest,
  claims: CapabilityTicketClaims,
  input: Record<string, unknown>,
): Promise<boolean> {
  if (claims.resource.appId !== INBOX_CAPABILITY_CATALOG.appId) return false;
  const accountId = claims.resource.effectiveAccountId;
  const messageId = typeof input.messageId === 'string' ? input.messageId : null;
  if (claims.resource.resourceType === 'email_account') {
    if (claims.resource.resourceId !== accountId) return false;
    return !messageId || messageBelongsToAccount(messageId, accountId);
  }
  if (claims.resource.resourceType !== 'mailbox') return false;
  if (!await mailboxBelongsToAccount(claims.resource.resourceId, accountId)) return false;
  if (request.path === '/search' || request.path === '/messages' || request.path === '/ai-context') {
    request.query.mailbox = claims.resource.resourceId;
    if (request.path === '/messages') request.query.unseen = 'true';
  }
  return !messageId || messageBelongsToMailbox(messageId, accountId, claims.resource.resourceId);
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
    const signing = capabilityTicketSigningConfig();
    claims = verifyCapabilityTicket(token, {
      audience: INBOX_CAPABILITY_CATALOG.audience,
      issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
      resolvePublicKey: (keyId) => keyId === signing.keyId ? signing.publicKey : undefined,
    });
  } catch (error) {
    const code = error instanceof CapabilityTicketError ? error.code : 'invalid_claims';
    response.status(401).json({ error: 'invalid_capability_ticket', code });
    return;
  }
  const invocation = matchCatalogInvocation(request);
  if (!invocation || invocation.tool.name !== claims.tool) {
    response.status(403).json({ error: 'capability_tool_mismatch' });
    return;
  }
  const input = validatedCanonicalInput(request, invocation);
  if (!input) {
    response.status(400).json({ error: 'capability_input_schema_mismatch' });
    return;
  }
  const decision = await reauthorizeCapabilityTicket(claims);
  if (!decision.allowed) {
    await auditResult(claims, decision, 403);
    response.status(403).json({ error: 'capability_revoked_or_denied', reason: decision.reason });
    return;
  }
  if (!await resourceMatches(request, claims, input)) {
    const resourceDecision = { allowed: false, reason: 'capability_resource_mismatch' } as const;
    await auditResult(claims, resourceDecision, 403);
    response.status(403).json({ error: 'capability_resource_mismatch' });
    return;
  }
  if (!inputSatisfiesCapabilityLimits(claims.tool, input, claims.limits)) {
    const limitDecision = { allowed: false, reason: 'capability_limit_exceeded' } as const;
    await auditResult(claims, limitDecision, 403);
    response.status(403).json({ error: 'capability_limit_exceeded' });
    return;
  }
  let keyHash: string | undefined;
  if (invocation.tool.idempotency === 'required') {
    const rawKey = request.header('idempotency-key');
    if (!rawKey) {
      await auditResult(claims, { allowed: false, reason: 'idempotency_key_required' }, 400);
      response.status(400).json({ error: 'idempotency_key_required' });
      return;
    }
    keyHash = createHash('sha256').update(rawKey).digest('hex');
    if (!await reserveCapabilityEffect(claims, keyHash)) {
      await auditResult(claims, { allowed: false, reason: 'duplicate_effect_prevented' }, 409, keyHash);
      response.status(409).json({ error: 'duplicate_effect_prevented' });
      return;
    }
  }
  request.user = { id: claims.resource.effectiveAccountId };
  request.capabilityTicket = claims;
  response.once('finish', () => {
    if (keyHash) {
      void finalizeCapabilityEffect(claims, keyHash, response.statusCode)
        .catch((error: unknown) => logger.error('Failed to finalize capability idempotency key', error));
    }
    void auditResult(claims, decision, response.statusCode, keyHash)
      .catch((error: unknown) => logger.error('Failed to persist capability audit event', error));
  });
  next();
}
