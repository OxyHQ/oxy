import { Router, type Response } from 'express';
import mongoose from 'mongoose';
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
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import { CapabilityAuditEvent } from '../models/CapabilityAuditEvent';
import {
  DelegationCapability,
  DelegationGrant,
  DelegationLimit,
  DelegationToolOverride,
  type IDelegationGrant,
} from '../models/DelegationGrant';
import User from '../models/User';
import { AccountCapabilityPolicy } from '../models/AccountCapabilityPolicy';
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

router.get('/service-identity', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  const registrations = await listActiveCapabilityCatalogs();
  const catalogs = registrations
    .filter((registration) => registration.registeredByApplicationId.toString() === request.serviceApp?.appId)
    .map((registration) => ({
      appId: registration.appId,
      eventTypes: registration.catalog.events.map((event) => event.type),
    }));
  return response.json({
    service: request.serviceApp,
    catalogAppIds: catalogs.map((catalog) => catalog.appId),
    catalogs,
  });
});

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

async function canOperate(userId: string, accountId: string): Promise<boolean> {
  const access = await accountService.resolveEffectiveAccess(userId, accountId);
  return access?.permissions.includes('account:act_as') ?? false;
}

async function grantContract(grant: IDelegationGrant): Promise<DelegationGrantContract> {
  const [capabilities, overrides, limits] = await Promise.all([
    DelegationCapability.find({ grantId: grant._id }).lean(),
    DelegationToolOverride.find({ grantId: grant._id }).lean(),
    DelegationLimit.find({ grantId: grant._id }).lean(),
  ]);
  return {
    id: grant._id.toString(),
    ownerAccountId: grant.ownerAccountId.toString(),
    actor: { type: 'agent', accountId: grant.actorAccountId.toString() },
    resource: {
      appId: grant.resourceAppId,
      effectiveAccountId: grant.effectiveAccountId.toString(),
      resourceType: grant.resourceType,
      resourceId: grant.resourceId,
    },
    capabilityPackages: grant.capabilityPackages,
    capabilities: capabilities.map((entry) => entry.capability),
    toolOverrides: overrides.map((entry) => ({ tool: entry.tool, decision: entry.decision })),
    limits: limits.map((entry) => ({ key: entry.key, value: entry.value })),
    maximumAutonomy: grant.maximumAutonomy,
    canRedelegate: grant.canRedelegate,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
    updatedAt: grant.updatedAt.toISOString(),
  };
}

router.post('/grants', authMiddleware, async (request: AuthRequest, response: Response) => {
  const parsed = createGrantSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_grant', details: parsed.error.flatten() });
  const userId = idOf(request);
  const input = parsed.data;
  if (!mongoose.isValidObjectId(input.ownerAccountId) || !mongoose.isValidObjectId(input.actorAccountId)
    || !mongoose.isValidObjectId(input.resource.effectiveAccountId)) {
    return response.status(400).json({ error: 'invalid_account_id' });
  }
  if (!await canOperate(userId, input.ownerAccountId) || !await canOperate(userId, input.resource.effectiveAccountId)) {
    return response.status(403).json({ error: 'account_authority_required' });
  }
  const actor = await User.findById(input.actorAccountId).select('kind accountStatus').lean();
  if (!actor || actor.kind !== 'bot' || actor.accountStatus === 'archived') {
    return response.status(400).json({ error: 'actor_must_be_active_bot_account' });
  }
  if (input.canRedelegate && (!input.capabilityPackages.includes('delegate') || !input.capabilities.includes('access.delegate'))) {
    return response.status(400).json({ error: 'redelegation_requires_access_delegate' });
  }

  const grant = await DelegationGrant.create({
    ownerAccountId: input.ownerAccountId,
    actorAccountId: input.actorAccountId,
    resourceAppId: input.resource.appId,
    effectiveAccountId: input.resource.effectiveAccountId,
    resourceType: input.resource.resourceType,
    resourceId: input.resource.resourceId,
    capabilityPackages: [...new Set(input.capabilityPackages)],
    maximumAutonomy: input.maximumAutonomy,
    canRedelegate: input.canRedelegate,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    revokedAt: null,
    createdByUserId: userId,
  });
  try {
    await Promise.all([
      DelegationCapability.insertMany([...new Set(input.capabilities)].map((capability) => ({ grantId: grant._id, capability }))),
      DelegationToolOverride.insertMany(input.toolOverrides.map((override) => ({ grantId: grant._id, ...override }))),
      DelegationLimit.insertMany(input.limits.map((limit) => ({ grantId: grant._id, ...limit }))),
    ]);
  } catch (error) {
    await Promise.all([
      DelegationCapability.deleteMany({ grantId: grant._id }),
      DelegationToolOverride.deleteMany({ grantId: grant._id }),
      DelegationLimit.deleteMany({ grantId: grant._id }),
      DelegationGrant.deleteOne({ _id: grant._id }),
    ]);
    throw error;
  }
  return response.status(201).json({ grant: await grantContract(grant) });
});

router.get('/grants', authMiddleware, async (request: AuthRequest, response: Response) => {
  const userId = idOf(request);
  const ownerAccountId = typeof request.query.ownerAccountId === 'string' ? request.query.ownerAccountId : userId;
  if (!mongoose.isValidObjectId(ownerAccountId)) return response.status(400).json({ error: 'invalid_owner_account_id' });
  if (!await canOperate(userId, ownerAccountId)) return response.status(403).json({ error: 'account_authority_required' });
  const grants = await DelegationGrant.find({ ownerAccountId }).sort({ createdAt: -1 });
  return response.json({ grants: await Promise.all(grants.map(grantContract)) });
});

router.delete('/grants/:grantId', authMiddleware, async (request: AuthRequest, response: Response) => {
  if (!mongoose.isValidObjectId(request.params.grantId)) return response.status(400).json({ error: 'invalid_grant_id' });
  const grant = await DelegationGrant.findById(request.params.grantId);
  if (!grant) return response.status(404).json({ error: 'grant_not_found' });
  if (!await canOperate(idOf(request), grant.ownerAccountId.toString())) {
    return response.status(403).json({ error: 'account_authority_required' });
  }
  grant.revokedAt = new Date();
  await grant.save();
  return response.status(204).send();
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
    return response.status(201).json({ registration });
  } catch (error) {
    return response.status(400).json({ error: 'catalog_registration_failed', message: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/catalogs', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capabilities:read')) return;
  const appIds = typeof request.query.appId === 'string' ? [request.query.appId] : undefined;
  const registrations = await listActiveCapabilityCatalogs(appIds);
  return response.json({ registrations });
});

router.post('/capability-map', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capabilities:read')) return;
  const parsed = z.object({
    requesterAccountId: z.string().min(1),
    ownerAccountId: z.string().min(1),
    actorAccountId: z.string().min(1),
  }).strict().safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_capability_map_request' });
  if (!await canOperate(parsed.data.requesterAccountId, parsed.data.ownerAccountId)) {
    return response.status(403).json({ error: 'requester_lacks_grant_owner_authority' });
  }
  const actor = await User.findById(parsed.data.actorAccountId).select('kind accountStatus').lean();
  if (!actor || actor.kind !== 'bot' || actor.accountStatus === 'archived') {
    return response.status(400).json({ error: 'actor_must_be_active_bot_account' });
  }
  const now = new Date();
  const grants = await DelegationGrant.find({
    ownerAccountId: parsed.data.ownerAccountId,
    actorAccountId: parsed.data.actorAccountId,
    revokedAt: null,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).sort({ createdAt: 1 });
  const assignments = await Promise.all(grants.map(async (grant) => {
    if (!await canOperate(parsed.data.requesterAccountId, grant.effectiveAccountId.toString())) return null;
    const [catalog, capabilities, overrides, limits, policy] = await Promise.all([
      activeCapabilityCatalog(grant.resourceAppId),
      DelegationCapability.find({ grantId: grant._id }).lean(),
      DelegationToolOverride.find({ grantId: grant._id }).lean(),
      DelegationLimit.find({ grantId: grant._id }).lean(),
      AccountCapabilityPolicy.findOne({ accountId: grant.effectiveAccountId, appId: grant.resourceAppId }).lean(),
    ]);
    if (!catalog) return null;
    const capabilityNames = capabilities.map((entry) => entry.capability);
    const toolOverrides = overrides.map((entry) => ({ tool: entry.tool, decision: entry.decision }));
    const toolNames = catalog.catalog.tools
      .filter((tool) => tool.exposure.includes('internal'))
      .filter((tool) => tool.resourceTypes.includes(grant.resourceType))
      .filter((tool) => !policy?.deniedCapabilities.some((capability) => tool.requiredCapabilities.includes(capability)))
      .filter((tool) => grantAllowsTool(tool, {
        capabilities: capabilityNames,
        overrides: toolOverrides,
        capabilityPackages: grant.capabilityPackages,
      }))
      .map((tool) => tool.name);
    return {
      grantId: grant._id.toString(),
      resource: {
        appId: grant.resourceAppId,
        effectiveAccountId: grant.effectiveAccountId.toString(),
        resourceType: grant.resourceType,
        resourceId: grant.resourceId,
      },
      maximumAutonomy: mostRestrictiveAutonomy([
        grant.maximumAutonomy,
        policy?.maximumAutonomy ?? 'autonomous',
      ]),
      limits: limits.map((limit) => ({ key: limit.key, value: limit.value })),
      toolNames,
    };
  }));
  return response.json({ assignments: assignments.filter((assignment) => assignment !== null) });
});

router.post('/tickets', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capability-tickets:issue')) return;
  const parsed = ticketRequestSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_ticket_request', details: parsed.error.flatten() });
  const result = await evaluateCapabilityAuthority(parsed.data, { issueTicket: true });
  return response.status(result.decision.allowed ? 201 : 403).json(result);
});

router.post('/tickets/introspect', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capabilities:read')) return;
  const parsed = z.object({ ticket: z.string().min(1), audience: z.string().min(1) }).strict().safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_introspection_request' });
  try {
    const claims = verifyCapabilityTicket(parsed.data.ticket, {
      audience: parsed.data.audience,
      issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
      secret: capabilityTicketSecret(),
    });
    const decision = await reauthorizeCapabilityTicket(claims);
    return response.json({ active: decision.allowed, claims, decision });
  } catch (error) {
    return response.json({ active: false, error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/audit', serviceAuthMiddleware, async (request: ServiceAuthRequest, response: Response) => {
  if (!serviceHasScope(request, response, 'capability-audit:write')) return;
  const parsed = auditEventSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'invalid_audit_event', details: parsed.error.flatten() });
  const stored = await CapabilityAuditEvent.findOneAndUpdate(
    { eventId: parsed.data.eventId },
    { $setOnInsert: { eventId: parsed.data.eventId, event: parsed.data } },
    { upsert: true, new: true },
  );
  return response.status(201).json({ event: stored });
});

router.get('/audit', authMiddleware, async (request: AuthRequest, response: Response) => {
  const userId = idOf(request);
  const accountId = typeof request.query.accountId === 'string' ? request.query.accountId : userId;
  if (!mongoose.isValidObjectId(accountId)) return response.status(400).json({ error: 'invalid_account_id' });
  if (!await canOperate(userId, accountId)) return response.status(403).json({ error: 'account_authority_required' });
  const events = await CapabilityAuditEvent.find({ 'event.effectiveAccountId': accountId }).sort({ createdAt: -1 }).limit(200);
  return response.json({ events });
});

export default router;
