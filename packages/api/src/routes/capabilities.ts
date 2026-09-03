import { createHash } from 'node:crypto';
import { Router, type Response } from 'express';
import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  actorRefSchema,
  auditResultSchema,
  autonomyLevelSchema,
  capabilityPackageSchema,
  grantLimitSchema,
  resourceRefSchema,
  toolGrantOverrideSchema,
  type DelegationGrant as DelegationGrantContract,
} from '@oxyhq/contracts';
import { verifyCapabilityTicket } from '@oxyhq/core/server';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import {
  accountCapabilityPolicies,
  appCapabilityCatalogRegistrations,
  capabilityAuditEvents,
  capabilityExecutionAuthorizations,
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
  evaluateCapabilityAuthority,
  mostRestrictiveAutonomy,
  reauthorizeCapabilityTicket,
} from '../services/capabilityAuthority.service';
import {
  principalHasCatalogCapability,
  resolveLiveAgencyCoordinator,
  resolveLiveAgencyServicePrincipal,
  type LiveAgencyServicePrincipal,
} from '../services/agencyServicePrincipal.service';
import { AGENCY_COORDINATE_CAPABILITY } from '../utils/applicationCapabilities';
import {
  activeCapabilityCatalog,
  listActiveCapabilityCatalogs,
  registerCapabilityCatalog,
} from '../services/capabilityCatalog.service';
import { persistCapabilityAuditEvent } from '../services/capabilityRuntimeStore.service';
import { capabilityLimitError } from '../services/capabilityLimitPolicy';
import {
  autonomousSensitiveToolLimitError,
  capabilityGrantError,
  grantAllowsTool,
} from '../services/capabilityGrantPolicy';

const router = Router();

const mutableGrantSchema = z.object({
  capabilityPackages: z.array(capabilityPackageSchema),
  capabilities: z.array(z.string().min(1)),
  toolOverrides: z.array(toolGrantOverrideSchema).default([]),
  limits: z.array(grantLimitSchema).default([]),
  maximumAutonomy: autonomyLevelSchema,
  canRedelegate: z.boolean().default(false),
  expiresAt: z.string().datetime().nullable().default(null),
}).strict();

const createGrantSchema = mutableGrantSchema.extend({
  ownerAccountId: z.string().min(1),
  actorAccountId: z.string().min(1),
  resource: resourceRefSchema,
}).strict();

const executionAuthorizationSchema = z.object({
  kind: z.enum(['direct_request', 'automation']),
  ownerAccountId: z.string().min(1),
  coordinatorApplicationId: z.string().min(1),
  coordinatorCredentialId: z.string().min(1),
  actor: actorRefSchema,
  resource: resourceRefSchema,
  tool: z.string().min(1),
  runId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  automationId: z.string().min(1).optional(),
  maximumAutonomy: autonomyLevelSchema,
  limits: z.array(grantLimitSchema).default([]),
  expiresAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if ((value.kind === 'automation') !== (value.automationId !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['automationId'], message: 'automationId is required only for automation authority' });
  }
  if (value.kind === 'direct_request' && !value.runId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['runId'], message: 'runId is required for direct request authority' });
  }
  if (value.kind === 'automation' && (value.runId !== undefined || value.stepId !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runId'],
      message: 'automation run and step identity are supplied when a ticket is issued',
    });
  }
  if (value.kind === 'direct_request' && value.maximumAutonomy === 'autonomous') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['maximumAutonomy'], message: 'direct requests cannot authorize autonomous execution' });
  }
  value.limits.forEach((limit, index) => {
    if (limit.tool !== value.tool) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['limits', index, 'tool'], message: 'limit must name the authorized tool' });
    }
  });
});

const ticketRequestSchema = z.object({
  executionAuthorizationId: z.string().min(1),
  runId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
}).strict();

const accountPolicyWriteSchema = z.object({
  accountId: z.string().min(1),
  maximumAutonomy: autonomyLevelSchema,
  deniedCapabilities: z.array(z.string().min(1)),
}).strict().superRefine((value, context) => {
  if (new Set(value.deniedCapabilities).size !== value.deniedCapabilities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deniedCapabilities'],
      message: 'deniedCapabilities cannot contain duplicates',
    });
  }
});

async function livePrincipal(
  request: ServiceAuthRequest,
  response: Response,
  scope: string,
  capability?: string,
): Promise<LiveAgencyServicePrincipal | null> {
  if (!request.serviceApp) {
    response.status(401).json({ error: 'service_principal_required' });
    return null;
  }
  const principal = await resolveLiveAgencyServicePrincipal(request.serviceApp);
  if (!principal) {
    response.status(401).json({ error: 'service_principal_no_longer_active' });
    return null;
  }
  if (!principal.scopes.includes(scope)) {
    response.status(403).json({ error: 'insufficient_service_scope', requiredScope: scope });
    return null;
  }
  if (capability && !principal.capabilities.includes(capability)) {
    response.status(403).json({ error: 'missing_application_capability', requiredCapability: capability });
    return null;
  }
  return principal;
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
  const [capabilities, overrides, limits, registrations] = await Promise.all([
    db.select({ capability: delegationCapabilities.capability })
      .from(delegationCapabilities)
      .where(eq(delegationCapabilities.grantId, grant.id)),
    db.select({ tool: delegationToolOverrides.tool, decision: delegationToolOverrides.decision })
      .from(delegationToolOverrides)
      .where(eq(delegationToolOverrides.grantId, grant.id)),
    db.select({ tool: delegationLimits.tool, key: delegationLimits.key, value: delegationLimits.value })
      .from(delegationLimits)
      .where(eq(delegationLimits.grantId, grant.id)),
    grant.catalogRegistrationId
      ? db.select({
          id: appCapabilityCatalogRegistrations.id,
          version: appCapabilityCatalogRegistrations.version,
          digest: appCapabilityCatalogRegistrations.digest,
        }).from(appCapabilityCatalogRegistrations)
          .where(eq(appCapabilityCatalogRegistrations.id, grant.catalogRegistrationId))
          .limit(1)
      : Promise.resolve([]),
  ]);
  const registration = registrations[0];
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
    catalog: registration ? {
      registrationId: registration.id,
      version: registration.version,
      digest: registration.digest,
    } : null,
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
  if (!request.serviceApp) {
    response.status(401).json({ error: 'service_principal_required' });
    return;
  }
  const principal = await resolveLiveAgencyServicePrincipal(request.serviceApp);
  if (!principal) {
    response.status(401).json({ error: 'service_principal_no_longer_active' });
    return;
  }
  const registrations = await listActiveCapabilityCatalogs();
  const catalogs = registrations
    .filter((registration) => registration.registeredByApplicationId === principal.applicationId)
    .map((registration) => ({
      appId: registration.appSlug,
      eventTypes: registration.catalog.events.map((event) => event.type),
    }));
  response.json({
    service: principal,
    catalogAppIds: catalogs.map((catalog) => catalog.appId),
    catalogs,
  });
});

router.get('/.well-known/jwks.json', (_request, response) => {
  const signing = capabilityTicketSigningConfig();
  response.set('cache-control', 'public, max-age=300, must-revalidate');
  response.json({ keys: [signing.publicJwk] });
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
  const catalog = await activeCapabilityCatalog(input.resource.appId);
  if (!catalog) {
    response.status(400).json({ error: 'catalog_not_registered' });
    return;
  }
  const grantError = capabilityGrantError({
    resourceType: input.resource.resourceType,
    capabilityPackages: input.capabilityPackages,
    capabilities: input.capabilities,
    toolOverrides: input.toolOverrides,
    limits: input.limits,
    maximumAutonomy: input.maximumAutonomy,
  }, catalog.catalog);
  if (grantError) {
    response.status(400).json({ error: grantError });
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
      catalogRegistrationId: catalog.id,
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

router.put('/grants/:grantId', authMiddleware, async (request: AuthRequest, response: Response) => {
  const parsed = mutableGrantSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_grant', details: parsed.error.flatten() });
    return;
  }
  const [existing] = await getDb().select().from(delegationGrants)
    .where(eq(delegationGrants.id, request.params.grantId)).limit(1);
  if (!existing) {
    response.status(404).json({ error: 'grant_not_found' });
    return;
  }
  if (existing.revokedAt) {
    response.status(409).json({ error: 'grant_revoked' });
    return;
  }
  const userId = idOf(request);
  if (!await canOperate(userId, existing.ownerAccountId)
    || !await canOperate(userId, existing.effectiveAccountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  if (!await activeBot(existing.actorAccountId)) {
    response.status(400).json({ error: 'actor_must_be_active_bot_account' });
    return;
  }
  const input = parsed.data;
  if (input.canRedelegate
    && (!input.capabilityPackages.includes('delegate') || !input.capabilities.includes('access.delegate'))) {
    response.status(400).json({ error: 'redelegation_requires_access_delegate' });
    return;
  }
  const catalog = await activeCapabilityCatalog(existing.resourceApp);
  if (!catalog) {
    response.status(400).json({ error: 'catalog_not_registered' });
    return;
  }
  const grantError = capabilityGrantError({
    resourceType: existing.resourceType,
    capabilityPackages: input.capabilityPackages,
    capabilities: input.capabilities,
    toolOverrides: input.toolOverrides,
    limits: input.limits,
    maximumAutonomy: input.maximumAutonomy,
  }, catalog.catalog);
  if (grantError) {
    response.status(400).json({ error: grantError });
    return;
  }

  const grant = await getDb().transaction(async (tx) => {
    const [updated] = await tx.update(delegationGrants).set({
      capabilityPackages: [...new Set(input.capabilityPackages)],
      catalogRegistrationId: catalog.id,
      maximumAutonomy: input.maximumAutonomy,
      canRedelegate: input.canRedelegate,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      updatedAt: new Date(),
    }).where(eq(delegationGrants.id, existing.id)).returning();
    if (!updated) throw new Error('Delegation grant was not updated');
    await tx.delete(delegationCapabilities).where(eq(delegationCapabilities.grantId, existing.id));
    await tx.delete(delegationToolOverrides).where(eq(delegationToolOverrides.grantId, existing.id));
    await tx.delete(delegationLimits).where(eq(delegationLimits.grantId, existing.id));
    if (input.capabilities.length) {
      await tx.insert(delegationCapabilities).values(
        input.capabilities.map((capability) => ({ grantId: existing.id, capability })),
      );
    }
    if (input.toolOverrides.length) {
      await tx.insert(delegationToolOverrides).values(
        input.toolOverrides.map((override) => ({ grantId: existing.id, ...override })),
      );
    }
    if (input.limits.length) {
      await tx.insert(delegationLimits).values(
        input.limits.map((limit) => ({ grantId: existing.id, ...limit })),
      );
    }
    return updated;
  });
  response.json({ grant: await grantContract(grant) });
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

router.get('/account-policies', authMiddleware, async (request: AuthRequest, response: Response) => {
  const userId = idOf(request);
  const accountId = typeof request.query.accountId === 'string' ? request.query.accountId : userId;
  if (!await canOperate(userId, accountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  const appId = typeof request.query.appId === 'string' ? request.query.appId : null;
  const policies = await getDb().select().from(accountCapabilityPolicies)
    .where(appId
      ? and(eq(accountCapabilityPolicies.accountId, accountId), eq(accountCapabilityPolicies.appSlug, appId))
      : eq(accountCapabilityPolicies.accountId, accountId))
    .orderBy(asc(accountCapabilityPolicies.appSlug));
  response.json({ policies });
});

router.put('/account-policies/:appId', authMiddleware, async (request: AuthRequest, response: Response) => {
  const parsed = accountPolicyWriteSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_account_capability_policy', details: parsed.error.flatten() });
    return;
  }
  if (!await canOperate(idOf(request), parsed.data.accountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  const catalog = await activeCapabilityCatalog(request.params.appId);
  if (!catalog) {
    response.status(400).json({ error: 'catalog_not_registered' });
    return;
  }
  const availableCapabilities = new Set(catalog.catalog.tools.flatMap((tool) => tool.requiredCapabilities));
  if (parsed.data.deniedCapabilities.some((capability) => !availableCapabilities.has(capability))) {
    response.status(400).json({ error: 'capability_not_available_in_catalog' });
    return;
  }
  const [policy] = await getDb().insert(accountCapabilityPolicies).values({
    accountId: parsed.data.accountId,
    appSlug: catalog.appSlug,
    maximumAutonomy: parsed.data.maximumAutonomy,
    deniedCapabilities: parsed.data.deniedCapabilities,
  }).onConflictDoUpdate({
    target: [accountCapabilityPolicies.accountId, accountCapabilityPolicies.appSlug],
    set: {
      maximumAutonomy: parsed.data.maximumAutonomy,
      deniedCapabilities: parsed.data.deniedCapabilities,
      updatedAt: new Date(),
    },
  }).returning();
  if (!policy) throw new Error('Account capability policy was not persisted');
  response.json({ policy });
});

router.delete('/account-policies/:appId', authMiddleware, async (request: AuthRequest, response: Response) => {
  const accountId = typeof request.query.accountId === 'string' ? request.query.accountId : idOf(request);
  if (!await canOperate(idOf(request), accountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  const [policy] = await getDb().delete(accountCapabilityPolicies).where(and(
    eq(accountCapabilityPolicies.accountId, accountId),
    eq(accountCapabilityPolicies.appSlug, request.params.appId),
  )).returning({ id: accountCapabilityPolicies.id });
  if (!policy) {
    response.status(404).json({ error: 'account_capability_policy_not_found' });
    return;
  }
  response.status(204).send();
});

router.get('/execution-authorizations', authMiddleware, async (request: AuthRequest, response: Response) => {
  const userId = idOf(request);
  const ownerAccountId = typeof request.query.ownerAccountId === 'string' ? request.query.ownerAccountId : userId;
  if (!await canOperate(userId, ownerAccountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  const authorizations = await getDb().select().from(capabilityExecutionAuthorizations)
    .where(eq(capabilityExecutionAuthorizations.ownerAccountId, ownerAccountId))
    .orderBy(desc(capabilityExecutionAuthorizations.createdAt))
    .limit(200);
  response.json({ authorizations });
});

router.post('/execution-authorizations', authMiddleware, async (request: AuthRequest, response: Response) => {
  const parsed = executionAuthorizationSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_execution_authorization', details: parsed.error.flatten() });
    return;
  }
  const requesterAccountId = idOf(request);
  const input = parsed.data;
  if (!await canOperate(requesterAccountId, input.ownerAccountId)
    || !await canOperate(requesterAccountId, input.resource.effectiveAccountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  if (input.actor.type === 'alia' && input.actor.ownerAccountId !== input.ownerAccountId) {
    response.status(400).json({ error: 'alia_owner_mismatch' });
    return;
  }
  if (input.actor.type === 'agent' && !await activeBot(input.actor.accountId)) {
    response.status(400).json({ error: 'actor_must_be_active_bot_account' });
    return;
  }
  const coordinator = await resolveLiveAgencyCoordinator(
    input.coordinatorApplicationId,
    input.coordinatorCredentialId,
  );
  if (!coordinator
    || !coordinator.capabilities.includes(AGENCY_COORDINATE_CAPABILITY)
    || !coordinator.scopes.includes('capability-tickets:issue')) {
    response.status(400).json({ error: 'coordinator_not_active_or_authorized' });
    return;
  }
  const catalog = await activeCapabilityCatalog(input.resource.appId);
  const tool = catalog?.catalog.tools.find((entry) => entry.name === input.tool);
  if (!tool || !tool.exposure.includes('internal') || !tool.resourceTypes.includes(input.resource.resourceType)) {
    response.status(400).json({ error: 'tool_not_available_for_resource' });
    return;
  }
  const limitError = capabilityLimitError(input.limits, [tool], input.resource.resourceType);
  if (limitError) {
    response.status(400).json({ error: limitError });
    return;
  }
  const sensitiveLimitError = autonomousSensitiveToolLimitError(
    input.maximumAutonomy,
    tool,
    input.limits,
  );
  if (sensitiveLimitError) {
    response.status(400).json({ error: sensitiveLimitError });
    return;
  }
  if (tool.effect !== 'read' && (input.maximumAutonomy === 'read_only' || input.maximumAutonomy === 'draft')) {
    response.status(400).json({ error: 'effect_requires_execution_authority' });
    return;
  }
  const now = new Date();
  const expiresAt = new Date(input.expiresAt);
  const maximumLifetimeMs = input.kind === 'direct_request' ? 15 * 60_000 : 366 * 24 * 60 * 60_000;
  if (expiresAt <= now || expiresAt.getTime() - now.getTime() > maximumLifetimeMs) {
    response.status(400).json({ error: 'execution_authorization_expiry_out_of_range' });
    return;
  }
  const [authorization] = await getDb().insert(capabilityExecutionAuthorizations).values({
    kind: input.kind,
    requesterAccountId,
    ownerAccountId: input.ownerAccountId,
    coordinatorApplicationId: coordinator.applicationId,
    coordinatorCredentialId: coordinator.credentialId,
    actorType: input.actor.type,
    actorAccountId: input.actor.type === 'agent' ? input.actor.accountId : null,
    resourceApp: input.resource.appId,
    effectiveAccountId: input.resource.effectiveAccountId,
    resourceType: input.resource.resourceType,
    resourceKey: input.resource.resourceId,
    tool: input.tool,
    runId: input.runId ?? null,
    stepId: input.stepId ?? null,
    automationId: input.automationId ?? null,
    maximumAutonomy: input.maximumAutonomy,
    limits: input.limits,
    expiresAt,
  }).returning();
  response.status(201).json({ authorization });
});

router.delete('/execution-authorizations/:authorizationId', authMiddleware, async (request: AuthRequest, response: Response) => {
  const [authorization] = await getDb().select().from(capabilityExecutionAuthorizations)
    .where(eq(capabilityExecutionAuthorizations.id, request.params.authorizationId)).limit(1);
  if (!authorization) {
    response.status(404).json({ error: 'execution_authorization_not_found' });
    return;
  }
  if (!await canOperate(idOf(request), authorization.ownerAccountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  await getDb().update(capabilityExecutionAuthorizations).set({ revokedAt: new Date() })
    .where(eq(capabilityExecutionAuthorizations.id, authorization.id));
  response.status(204).send();
});

router.get('/catalogs/available', authMiddleware, async (request: AuthRequest, response: Response) => {
  const parsed = z.object({ accountId: z.string().min(1) }).strict().safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_available_catalogs_request' });
    return;
  }
  if (!await canOperate(idOf(request), parsed.data.accountId)) {
    response.status(403).json({ error: 'account_authority_required' });
    return;
  }
  const registrations = await listActiveCapabilityCatalogs();
  response.json({
    catalogs: registrations.map((registration) => ({
      id: registration.id,
      appId: registration.appSlug,
      version: registration.version,
      digest: registration.digest,
      audience: registration.audience,
      catalog: registration.catalog,
    })),
  });
});

router.post('/catalogs/register', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  const catalogAppId = typeof request.body?.catalog?.appId === 'string' ? request.body.catalog.appId : '';
  const principal = await livePrincipal(request, response, 'catalogs:write');
  if (!principal) return;
  if (!principalHasCatalogCapability(principal, catalogAppId)) {
    response.status(403).json({ error: 'catalog_namespace_not_authorized', requiredCapability: `catalog:${catalogAppId}` });
    return;
  }
  try {
    const registration = await registerCapabilityCatalog({
      catalog: request.body.catalog,
      applicationId: principal.applicationId,
      credentialId: principal.credentialId,
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
  if (!await livePrincipal(request, response, 'capabilities:read', AGENCY_COORDINATE_CAPABILITY)) return;
  const appIds = typeof request.query.appId === 'string' ? [request.query.appId] : undefined;
  response.json({ registrations: await listActiveCapabilityCatalogs(appIds) });
});

router.post('/capability-map', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!await livePrincipal(request, response, 'capabilities:read', AGENCY_COORDINATE_CAPABILITY)) return;
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
    if (!grant.catalogRegistrationId) return null;
    const [catalog, boundRegistrations, capabilities, overrides, limits, policyRows] = await Promise.all([
      activeCapabilityCatalog(grant.resourceApp),
      db.select({ catalog: appCapabilityCatalogRegistrations.catalog })
        .from(appCapabilityCatalogRegistrations).where(and(
          eq(appCapabilityCatalogRegistrations.id, grant.catalogRegistrationId),
          eq(appCapabilityCatalogRegistrations.appSlug, grant.resourceApp),
        )).limit(1),
      db.select({ capability: delegationCapabilities.capability })
        .from(delegationCapabilities).where(eq(delegationCapabilities.grantId, grant.id)),
      db.select({ tool: delegationToolOverrides.tool, decision: delegationToolOverrides.decision })
        .from(delegationToolOverrides).where(eq(delegationToolOverrides.grantId, grant.id)),
      db.select({ tool: delegationLimits.tool, key: delegationLimits.key, value: delegationLimits.value })
        .from(delegationLimits).where(eq(delegationLimits.grantId, grant.id)),
      db.select().from(accountCapabilityPolicies).where(and(
        eq(accountCapabilityPolicies.accountId, grant.effectiveAccountId),
        eq(accountCapabilityPolicies.appSlug, grant.resourceApp),
      )).limit(1),
    ]);
    const boundRegistration = boundRegistrations[0];
    if (!catalog || !boundRegistration) return null;
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
      }, boundRegistration.catalog.tools.find((entry) => entry.name === tool.name)))
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
  const principal = await livePrincipal(request, response, 'capability-tickets:issue', AGENCY_COORDINATE_CAPABILITY);
  if (!principal) return;
  const parsed = ticketRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_ticket_request', details: parsed.error.flatten() });
    return;
  }
  const result = await evaluateCapabilityAuthority({
    executionAuthorizationId: parsed.data.executionAuthorizationId,
    coordinator: {
      applicationId: principal.applicationId,
      credentialId: principal.credentialId,
    },
    ...(parsed.data.runId ? { runId: parsed.data.runId } : {}),
    ...(parsed.data.stepId ? { stepId: parsed.data.stepId } : {}),
  }, { issueTicket: true });
  response.status(result.decision.allowed ? 201 : 403).json(result);
});

router.post('/tickets/introspect', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  const principal = await livePrincipal(request, response, 'capabilities:read');
  if (!principal) return;
  const parsed = z.object({ ticket: z.string().min(1) }).strict().safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_introspection_request' });
    return;
  }
  try {
    const registrations = (await listActiveCapabilityCatalogs()).filter((registration) => (
      registration.registeredByApplicationId === principal.applicationId
      && principalHasCatalogCapability(principal, registration.appSlug)
    ));
    const signing = capabilityTicketSigningConfig();
    const claims = registrations.map((registration) => {
      try {
        return verifyCapabilityTicket(parsed.data.ticket, {
          audience: registration.audience,
          issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
          resolvePublicKey: (keyId) => keyId === signing.keyId ? signing.publicKey : undefined,
        });
      } catch {
        return null;
      }
    }).find((entry) => entry !== null);
    if (!claims) {
      response.json({ active: false, error: 'ticket_not_issued_for_calling_application' });
      return;
    }
    const decision = await reauthorizeCapabilityTicket(claims);
    response.json({ active: decision.allowed, claims, decision });
  } catch (error) {
    response.json({ active: false, error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/audit', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  const principal = await livePrincipal(request, response, 'capability-audit:write');
  if (!principal) return;
  const parsed = z.object({
    ticket: z.string().min(1),
    result: auditResultSchema,
    rollback: z.object({
      supported: z.boolean(),
      attempted: z.boolean(),
      succeeded: z.boolean().optional(),
    }).strict(),
    idempotencyKey: z.string().min(1).optional(),
  }).strict().safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: 'invalid_audit_event', details: parsed.error.flatten() });
    return;
  }
  const registrations = (await listActiveCapabilityCatalogs()).filter((registration) => (
    registration.registeredByApplicationId === principal.applicationId
    && principalHasCatalogCapability(principal, registration.appSlug)
  ));
  const signing = capabilityTicketSigningConfig();
  const claims = registrations.map((registration) => {
    try {
      return verifyCapabilityTicket(parsed.data.ticket, {
        audience: registration.audience,
        issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
        resolvePublicKey: (keyId) => keyId === signing.keyId ? signing.publicKey : undefined,
      });
    } catch {
      return null;
    }
  }).find((entry) => entry !== null);
  if (!claims) {
    response.status(403).json({ error: 'ticket_not_issued_for_calling_application' });
    return;
  }
  const decision = await reauthorizeCapabilityTicket(claims);
  const event = {
    eventId: `${claims.jti}:${parsed.data.result.status}`,
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
    result: parsed.data.result,
    rollback: parsed.data.rollback,
    correlation: {
      runId: claims.runId,
      ...(claims.stepId ? { stepId: claims.stepId } : {}),
      ...(claims.automationId ? { automationId: claims.automationId } : {}),
      ...(parsed.data.idempotencyKey ? {
        idempotencyKeyHash: createHash('sha256').update(parsed.data.idempotencyKey).digest('hex'),
      } : {}),
      capabilityTicketId: claims.jti,
    },
  };
  await persistCapabilityAuditEvent(event);
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
