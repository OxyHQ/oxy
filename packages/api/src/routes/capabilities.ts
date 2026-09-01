import { Router, type Response } from 'express';
import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  actorRefSchema,
  auditEventSchema,
  autonomyLevelSchema,
  capabilityPackageSchema,
  grantLimitSchema,
  resourceRefSchema,
  toolGrantOverrideSchema,
  type DelegationGrant as DelegationGrantContract,
} from '@oxyhq/contracts';
import { verifyCapabilityTicket } from '@oxyhq/core/server';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import {
  accountCapabilityPolicies,
  capabilityAuditEvents,
  delegationCapabilities,
  delegationGrants,
  delegationLimits,
  delegationToolOverrides,
  type DelegationGrantRow,
} from '../db/schema/agency';
import { users } from '../db/schema/users';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import accountService from '../services/account.service';
import {
  capabilityTicketSecret,
  evaluateCapabilityAuthority,
  grantAllowsTool,
  mostRestrictiveAutonomy,
  reauthorizeCapabilityTicket,
} from '../services/capabilityAuthority.service';
import {
  activeCapabilityCatalog,
  listActiveCapabilityCatalogs,
  registerCapabilityCatalog,
} from '../services/capabilityCatalog.service';

const router = Router();

const createGrantSchema = z.object({
  ownerAccountId: z.string().min(1),
  actorAccountId: z.string().min(1),
  resource: resourceRefSchema,
  capabilityPackages: z.array(capabilityPackageSchema),
  capabilities: z.array(z.string().min(1)),
  toolOverrides: z.array(toolGrantOverrideSchema).default([]),
  limits: z.array(grantLimitSchema).default([]),
  maximumAutonomy: autonomyLevelSchema,
  canRedelegate: z.boolean().default(false),
  expiresAt: z.string().datetime().nullable().default(null),
}).strict();

const ticketRequestSchema = z.object({
  requesterAccountId: z.string().min(1),
  ownerAccountId: z.string().min(1),
  actor: actorRefSchema,
  resource: resourceRefSchema,
  tool: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  automationId: z.string().min(1).optional(),
  requestedAutonomy: autonomyLevelSchema,
  coordinatorMaximumAutonomy: autonomyLevelSchema.optional(),
  automationLimits: z.array(grantLimitSchema).optional(),
}).strict();

function serviceHasScope(request: ServiceAuthRequest, response: Response, scope: string): boolean {
  if (!request.serviceApp?.scopes.includes(scope)) {
    response.status(403).json({ error: 'insufficient_service_scope', requiredScope: scope });
    return false;
  }
  return true;
}

function idOf(request: AuthRequest): string {
  if (!request.user?._id) throw new Error('Authenticated user id is missing');
  return request.user._id.toString();
}

async function canOperate(operatorId: string, accountId: string): Promise<boolean> {
  const access = await accountService.resolveEffectiveAccess(operatorId, accountId);
  return access?.permissions.includes('account:act_as') ?? false;
}

async function activeBot(accountId: string): Promise<boolean> {
  const [actor] = await getDb()
    .select({ kind: users.kind, accountStatus: users.accountStatus })
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  return actor?.kind === 'bot' && actor.accountStatus !== 'archived';
}

async function grantContract(
  grant: DelegationGrantRow,
  db: DatabaseOrTransaction = getDb(),
): Promise<DelegationGrantContract> {
  const [capabilities, overrides, limits] = await Promise.all([
    db.select({ capability: delegationCapabilities.capability })
      .from(delegationCapabilities)
      .where(eq(delegationCapabilities.grantId, grant.id)),
    db.select({ tool: delegationToolOverrides.tool, decision: delegationToolOverrides.decision })
      .from(delegationToolOverrides)
      .where(eq(delegationToolOverrides.grantId, grant.id)),
    db.select({ key: delegationLimits.key, value: delegationLimits.value })
      .from(delegationLimits)
      .where(eq(delegationLimits.grantId, grant.id)),
  ]);
  return {
    id: grant.id,
    ownerAccountId: grant.ownerAccountId,
    actor: { type: 'agent', accountId: grant.actorAccountId },
    resource: {
      appId: grant.resourceApp,
      effectiveAccountId: grant.effectiveAccountId,
      resourceType: grant.resourceType,
      resourceId: grant.resourceKey,
    },
    capabilityPackages: grant.capabilityPackages,
    capabilities: capabilities.map((entry) => entry.capability),
    toolOverrides: overrides,
    limits,
    maximumAutonomy: grant.maximumAutonomy,
    canRedelegate: grant.canRedelegate,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

router.get('/service-identity', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  const registrations = await listActiveCapabilityCatalogs();
  const catalogs = registrations
    .filter((registration) => registration.registeredByApplicationId === request.serviceApp?.appId)
    .map((registration) => ({
      appId: registration.appSlug,
      eventTypes: registration.catalog.events.map((event) => event.type),
    }));
  response.json({
    service: request.serviceApp,
    catalogAppIds: catalogs.map((catalog) => catalog.appId),
    catalogs,
  });
});

router.post('/grants', authMiddleware, async (request: AuthRequest, response: Response) => {
  const parsed = createGrantSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_grant', details: parsed.error.flatten() });
    return;
  }
  const userId = idOf(request);
  const input = parsed.data;
  if (!await canOperate(userId, input.ownerAccountId) || !await canOperate(userId, input.resource.effectiveAccountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  if (!await activeBot(input.actorAccountId)) {
    response.status(400).json({ error: 'actor_must_be_active_bot_account' });
    return;
  }
  if (input.canRedelegate && (!input.capabilityPackages.includes('delegate') || !input.capabilities.includes('access.delegate'))) {
    response.status(400).json({ error: 'redelegation_requires_access_delegate' });
    return;
  }

  const grant = await getDb().transaction(async (tx) => {
    const [inserted] = await tx.insert(delegationGrants).values({
      ownerAccountId: input.ownerAccountId,
      actorAccountId: input.actorAccountId,
      resourceApp: input.resource.appId,
      effectiveAccountId: input.resource.effectiveAccountId,
      resourceType: input.resource.resourceType,
      resourceKey: input.resource.resourceId,
      capabilityPackages: [...new Set(input.capabilityPackages)],
      maximumAutonomy: input.maximumAutonomy,
      canRedelegate: input.canRedelegate,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      revokedAt: null,
      createdByUserId: userId,
    }).returning();
    if (!inserted) throw new Error('Delegation grant was not persisted');
    const capabilities = [...new Set(input.capabilities)];
    if (capabilities.length) {
      await tx.insert(delegationCapabilities).values(
        capabilities.map((capability) => ({ grantId: inserted.id, capability })),
      );
    }
    if (input.toolOverrides.length) {
      await tx.insert(delegationToolOverrides).values(
        input.toolOverrides.map((override) => ({ grantId: inserted.id, ...override })),
      );
    }
    if (input.limits.length) {
      await tx.insert(delegationLimits).values(
        input.limits.map((limit) => ({ grantId: inserted.id, ...limit })),
      );
    }
    return inserted;
  });
  response.status(201).json({ grant: await grantContract(grant) });
});

router.get('/grants', authMiddleware, async (request: AuthRequest, response: Response) => {
  const userId = idOf(request);
  const ownerAccountId = typeof request.query.ownerAccountId === 'string' ? request.query.ownerAccountId : userId;
  if (!await canOperate(userId, ownerAccountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  const grants = await getDb()
    .select()
    .from(delegationGrants)
    .where(eq(delegationGrants.ownerAccountId, ownerAccountId))
    .orderBy(desc(delegationGrants.createdAt));
  response.json({ grants: await Promise.all(grants.map((grant) => grantContract(grant))) });
});

router.delete('/grants/:grantId', authMiddleware, async (request: AuthRequest, response: Response) => {
  const [grant] = await getDb()
    .select()
    .from(delegationGrants)
    .where(eq(delegationGrants.id, request.params.grantId))
    .limit(1);
  if (!grant) {
    response.status(404).json({ error: 'grant_not_found' });
    return;
  }
  if (!await canOperate(idOf(request), grant.ownerAccountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  await getDb().update(delegationGrants).set({ revokedAt: new Date() }).where(eq(delegationGrants.id, grant.id));
  response.status(204).send();
});

router.post('/catalogs/register', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'catalogs:write')) return;
  try {
    const registration = await registerCapabilityCatalog({
      catalog: request.body.catalog,
      applicationId: request.serviceApp!.appId,
      credentialId: request.serviceApp!.credentialId,
      deployedAt: request.body.deployedAt ? new Date(request.body.deployedAt) : undefined,
    });
    response.status(201).json({ registration });
  } catch (error) {
    response.status(400).json({
      error: 'catalog_registration_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

router.get('/catalogs', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capabilities:read')) return;
  const appIds = typeof request.query.appId === 'string' ? [request.query.appId] : undefined;
  response.json({ registrations: await listActiveCapabilityCatalogs(appIds) });
});

router.post('/capability-map', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capabilities:read')) return;
  const parsed = z.object({
    requesterAccountId: z.string().min(1),
    ownerAccountId: z.string().min(1),
    actorAccountId: z.string().min(1),
  }).strict().safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_capability_map_request' });
    return;
  }
  if (!await canOperate(parsed.data.requesterAccountId, parsed.data.ownerAccountId)) {
    response.status(403).json({ error: 'requester_lacks_grant_owner_authority' });
    return;
  }
  if (!await activeBot(parsed.data.actorAccountId)) {
    response.status(400).json({ error: 'actor_must_be_active_bot_account' });
    return;
  }
  const now = new Date();
  const grants = await getDb()
    .select()
    .from(delegationGrants)
    .where(and(
      eq(delegationGrants.ownerAccountId, parsed.data.ownerAccountId),
      eq(delegationGrants.actorAccountId, parsed.data.actorAccountId),
      isNull(delegationGrants.revokedAt),
      or(isNull(delegationGrants.expiresAt), gt(delegationGrants.expiresAt, now)),
    ))
    .orderBy(asc(delegationGrants.createdAt));

  const assignments = await Promise.all(grants.map(async (grant) => {
    if (!await canOperate(parsed.data.requesterAccountId, grant.effectiveAccountId)) return null;
    const db = getDb();
    const [catalog, capabilities, overrides, limits, policyRows] = await Promise.all([
      activeCapabilityCatalog(grant.resourceApp),
      db.select({ capability: delegationCapabilities.capability })
        .from(delegationCapabilities).where(eq(delegationCapabilities.grantId, grant.id)),
      db.select({ tool: delegationToolOverrides.tool, decision: delegationToolOverrides.decision })
        .from(delegationToolOverrides).where(eq(delegationToolOverrides.grantId, grant.id)),
      db.select({ key: delegationLimits.key, value: delegationLimits.value })
        .from(delegationLimits).where(eq(delegationLimits.grantId, grant.id)),
      db.select().from(accountCapabilityPolicies).where(and(
        eq(accountCapabilityPolicies.accountId, grant.effectiveAccountId),
        eq(accountCapabilityPolicies.appSlug, grant.resourceApp),
      )).limit(1),
    ]);
    if (!catalog) return null;
    const policy = policyRows[0];
    const capabilityNames = capabilities.map((entry) => entry.capability);
    const toolNames = catalog.catalog.tools
      .filter((tool) => tool.exposure.includes('internal'))
      .filter((tool) => tool.resourceTypes.includes(grant.resourceType))
      .filter((tool) => !policy?.deniedCapabilities.some((capability) => tool.requiredCapabilities.includes(capability)))
      .filter((tool) => grantAllowsTool(tool, {
        capabilities: capabilityNames,
        overrides,
        capabilityPackages: grant.capabilityPackages,
      }))
      .map((tool) => tool.name);
    return {
      grantId: grant.id,
      resource: {
        appId: grant.resourceApp,
        effectiveAccountId: grant.effectiveAccountId,
        resourceType: grant.resourceType,
        resourceId: grant.resourceKey,
      },
      maximumAutonomy: mostRestrictiveAutonomy([
        grant.maximumAutonomy,
        policy?.maximumAutonomy ?? 'autonomous',
      ]),
      limits,
      toolNames,
    };
  }));
  response.json({ assignments: assignments.filter((assignment) => assignment !== null) });
});

router.post('/tickets', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capability-tickets:issue')) return;
  const parsed = ticketRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_ticket_request', details: parsed.error.flatten() });
    return;
  }
  const result = await evaluateCapabilityAuthority(parsed.data, { issueTicket: true });
  response.status(result.decision.allowed ? 201 : 403).json(result);
});

router.post('/tickets/introspect', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capabilities:read')) return;
  const parsed = z.object({ ticket: z.string().min(1), audience: z.string().min(1) }).strict().safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_introspection_request' });
    return;
  }
  try {
    const claims = verifyCapabilityTicket(parsed.data.ticket, {
      audience: parsed.data.audience,
      issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
      secret: capabilityTicketSecret(),
    });
    const decision = await reauthorizeCapabilityTicket(claims);
    response.json({ active: decision.allowed, claims, decision });
  } catch (error) {
    response.json({ active: false, error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/audit', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capability-audit:write')) return;
  const parsed = auditEventSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_audit_event', details: parsed.error.flatten() });
    return;
  }
  const event = parsed.data;
  await getDb().insert(capabilityAuditEvents).values({
    eventKey: event.eventId,
    effectiveAccountKey: event.effectiveAccountId,
    executorAccountKey: event.executor.type === 'agent' ? event.executor.accountId : null,
    runKey: event.correlation.runId,
    event,
  }).onConflictDoNothing({ target: capabilityAuditEvents.eventKey });
  const [stored] = await getDb()
    .select()
    .from(capabilityAuditEvents)
    .where(eq(capabilityAuditEvents.eventKey, event.eventId))
    .limit(1);
  response.status(201).json({ event: stored?.event ?? event });
});

router.get('/audit', authMiddleware, async (request: AuthRequest, response: Response) => {
  const userId = idOf(request);
  const accountId = typeof request.query.accountId === 'string' ? request.query.accountId : userId;
  if (!await canOperate(userId, accountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  const events = await getDb()
    .select({ event: capabilityAuditEvents.event })
    .from(capabilityAuditEvents)
    .where(eq(capabilityAuditEvents.effectiveAccountKey, accountId))
    .orderBy(desc(capabilityAuditEvents.createdAt))
    .limit(200);
  response.json({ events: events.map((entry) => entry.event) });
});

export default router;
