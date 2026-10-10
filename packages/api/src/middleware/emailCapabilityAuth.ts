import { createHash, randomUUID } from 'node:crypto';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { NextFunction, Request, Response } from 'express';
import {
  matchCatalogInvocation,
  type CapabilityTicketClaims,
  type CatalogInvocationMatch,
  type CatalogTool,
  type PolicyDecision,
} from '@oxy.so/contracts';
import {
  CapabilityTicketError,
  inputSatisfiesCapabilityLimits,
  readCapabilityAuthorization,
  verifyCapabilityTicket,
} from '@oxy.so/core/server';
import { INBOX_CAPABILITY_CATALOG } from '../capabilities/inbox.catalog';
import { INBOX_TOOLS, type InboxToolContext } from '../capabilities/inbox.tools';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { reauthorizeCapabilityTicket } from '../services/capabilityAuthority.service';
import {
  finalizeCapabilityEffect,
  mailboxBelongsToAccount,
  persistCapabilityAuditEvent,
  reserveCapabilityEffect,
} from '../services/capabilityRuntimeStore.service';
import { logger } from '../utils/logger';
import { authMiddleware, type AuthRequest } from './auth';

/**
 * Authentication for the `/email` router, and the HTTP transport of the Inbox
 * capability catalog.
 *
 * A request without a capability ticket is the owner using the Inbox app: it
 * goes through the ordinary bearer `authMiddleware` to the REST controllers.
 *
 * A request WITH one is a catalog tool call (Alia), and it never reaches those
 * controllers. After the ticket, tool, input schema, live authority, resource
 * and limits all check out and the idempotency key is reserved, the tool the
 * ticket names is executed by `inbox.tools.ts` — the same function the
 * external MCP server runs — and its result is the response. The REST routes
 * exist for a different client with different rules (a 400 unless a folder is
 * named, a flat `offset`, no mailbox scope); serving tickets through them is
 * how `getUnreadEmails` ended up answering every Alia call with a 400.
 */

// `useDefaults` writes each property's schema `default` into the canonical
// input before the limit check reads it — see `applyLimitBoundedDefaults`.
const schemaValidator = addFormats(
  new Ajv({ allErrors: true, coerceTypes: true, strict: true, useDefaults: true }),
);
const inputValidators = new Map<string, ValidateFunction>(
  INBOX_CAPABILITY_CATALOG.tools.map((tool) => [
    tool.name,
    schemaValidator.compile(tool.inputSchema),
  ]),
);

type ValidatedInput =
  | {
      readonly ok: true;
      readonly input: Record<string, unknown>;
      readonly supplied: ReadonlySet<string>;
    }
  | { readonly ok: false; readonly errors: readonly ErrorObject[] };

/**
 * The tool input exactly as the catalog schema defines it: GET query or JSON
 * body, plus the path parameters. The idempotency key is NOT part of it — it is
 * transport metadata carried by the `Idempotency-Key` header, which the tool
 * schemas deliberately do not declare, so the model is never asked for one.
 */
function validatedCanonicalInput(
  request: Request,
  invocation: CatalogInvocationMatch<CatalogTool>,
): ValidatedInput {
  const body =
    typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>)
      : {};
  const input: Record<string, unknown> = {
    ...(request.method === 'GET' ? request.query : body),
    ...invocation.params,
  };
  const supplied = new Set(Object.keys(input));
  const validateInput = inputValidators.get(invocation.tool.name);
  if (validateInput?.(input)) return { ok: true, input, supplied };
  return { ok: false, errors: validateInput?.errors ?? [] };
}

/**
 * A signed `maximum_number` limit also bounds the DEFAULT a caller got by
 * omitting the value. `inputSatisfiesCapabilityLimits` fails closed when a
 * limited key is absent, and a grant capping `limit` at 10 would otherwise
 * refuse every call that relied on the default page size of 20 — the model is
 * told limit is optional, and it is. An explicit value above the cap is still
 * refused: only an omitted value is chosen by us, so only it is adjusted.
 */
function applyLimitBoundedDefaults(
  input: Record<string, unknown>,
  supplied: ReadonlySet<string>,
  claims: CapabilityTicketClaims,
): void {
  for (const limit of claims.limits) {
    if (limit.tool !== claims.tool || typeof limit.value !== 'number' || limit.key.includes('.'))
      continue;
    const value = input[limit.key];
    if (supplied.has(limit.key) || typeof value !== 'number') continue;
    input[limit.key] = Math.min(value, limit.value);
  }
}

function schemaErrorDetails(
  errors: readonly ErrorObject[],
): Array<{ path: string; message: string }> {
  return errors.slice(0, 10).map((error) => ({
    path: error.instancePath || '/',
    message:
      error.keyword === 'additionalProperties'
        ? `unknown property ${String((error.params as { additionalProperty?: unknown }).additionalProperty)}`
        : (error.message ?? error.keyword),
  }));
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

/**
 * Whether the ticket's resource is one this tool can act on, and real.
 *
 * This checks the RESOURCE only. Whether an addressed email lies inside it is
 * the tool's own check (`inbox.tools.ts`), made against the same
 * `InboxToolContext` for every transport — this file used to answer that too,
 * by rewriting query strings for some paths, so the rule existed in four
 * places and none of them agreed.
 */
async function resourceScope(
  claims: CapabilityTicketClaims,
  tool: CatalogTool,
): Promise<InboxToolContext | null> {
  const { resource } = claims;
  if (resource.appId !== INBOX_CAPABILITY_CATALOG.appId) return null;
  if (!tool.resourceTypes.includes(resource.resourceType)) return null;
  const accountId = resource.effectiveAccountId;
  if (resource.resourceType === INBOX_CAPABILITY_CATALOG.accountResourceType) {
    return resource.resourceId === accountId ? { accountId } : null;
  }
  if (resource.resourceType !== 'mailbox') return null;
  if (!(await mailboxBelongsToAccount(resource.resourceId, accountId))) return null;
  return { accountId, mailboxId: resource.resourceId };
}

export async function emailCapabilityAuth(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const token = readCapabilityAuthorization(request.header('authorization'));
  if (!token) {
    authMiddleware(request as AuthRequest, response, next);
    return;
  }
  try {
    await executeCapabilityTicket(token, request, response);
  } catch (error) {
    next(error);
  }
}

async function executeCapabilityTicket(
  token: string,
  request: Request,
  response: Response,
): Promise<void> {
  let claims: CapabilityTicketClaims;
  try {
    const signing = capabilityTicketSigningConfig();
    claims = verifyCapabilityTicket(token, {
      audience: INBOX_CAPABILITY_CATALOG.audience,
      issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
      resolvePublicKey: (keyId) => (keyId === signing.keyId ? signing.publicKey : undefined),
    });
  } catch (error) {
    const code = error instanceof CapabilityTicketError ? error.code : 'invalid_claims';
    response.status(401).json({ error: 'invalid_capability_ticket', code });
    return;
  }
  // The FULL app-local path (`/email/messages/abc`), which is what the catalog
  // templates name — not the path relative to wherever this router is mounted.
  const invocation = matchCatalogInvocation(
    INBOX_CAPABILITY_CATALOG.tools,
    request.method,
    `${request.baseUrl}${request.path}`,
  );
  if (!invocation || invocation.tool.name !== claims.tool) {
    response.status(403).json({ error: 'capability_tool_mismatch' });
    return;
  }
  const idempotencyKey = request.header('idempotency-key');
  if (invocation.tool.idempotency === 'required' && !idempotencyKey) {
    await auditResult(claims, { allowed: false, reason: 'idempotency_key_required' }, 400);
    response.status(400).json({ error: 'idempotency_key_required' });
    return;
  }
  const validated = validatedCanonicalInput(request, invocation);
  if (!validated.ok) {
    response.status(400).json({
      error: 'capability_input_schema_mismatch',
      details: schemaErrorDetails(validated.errors),
    });
    return;
  }
  const { input } = validated;
  const decision = await reauthorizeCapabilityTicket(claims);
  if (!decision.allowed) {
    await auditResult(claims, decision, 403);
    response.status(403).json({ error: 'capability_revoked_or_denied', reason: decision.reason });
    return;
  }
  const scope = await resourceScope(claims, invocation.tool);
  if (!scope) {
    const resourceDecision = { allowed: false, reason: 'capability_resource_mismatch' } as const;
    await auditResult(claims, resourceDecision, 403);
    response.status(403).json({ error: 'capability_resource_mismatch' });
    return;
  }
  applyLimitBoundedDefaults(input, validated.supplied, claims);
  if (!inputSatisfiesCapabilityLimits(claims.tool, input, claims.limits)) {
    const limitDecision = { allowed: false, reason: 'capability_limit_exceeded' } as const;
    await auditResult(claims, limitDecision, 403);
    response.status(403).json({ error: 'capability_limit_exceeded' });
    return;
  }
  let keyHash: string | undefined;
  if (invocation.tool.idempotency === 'required' && idempotencyKey) {
    keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
    if (!(await reserveCapabilityEffect(claims, keyHash))) {
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
  // Settled on the response, not on the tool's promise, so an error answered
  // by the app's error handler is finalized and audited with ITS status.
  response.once('finish', () => {
    if (keyHash) {
      void finalizeCapabilityEffect(claims, keyHash, response.statusCode).catch((error: unknown) =>
        logger.error('Failed to finalize capability idempotency key', error),
      );
    }
    void auditResult(claims, decision, response.statusCode, keyHash).catch((error: unknown) =>
      logger.error('Failed to persist capability audit event', error),
    );
  });

  const run = INBOX_TOOLS[invocation.tool.name];
  if (!run) throw new Error(`Inbox tool ${invocation.tool.name} has no implementation`);
  const result = await run(input, {
    ...scope,
    ...(invocation.tool.idempotency === 'required' && idempotencyKey ? { idempotencyKey } : {}),
  });
  response.status(200).json(result);
}
