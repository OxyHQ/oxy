import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import {
  type ActorRef,
  type AutonomyLevel,
  type CapabilityTicketClaims,
  type CatalogTool,
  type GrantLimit,
  type PolicyDecision,
  type ResourceRef,
} from '@oxyhq/contracts';
import { issueCapabilityTicket } from '@oxyhq/core/server';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { getDb } from '../config/postgres';
import {
  accountCapabilityPolicies,
  capabilityExecutionAuthorizations,
  delegationCapabilities,
  delegationGrants,
  delegationLimits,
  delegationToolOverrides,
  type DelegationGrantRow,
} from '../db/schema/agency';
import { users } from '../db/schema/users';
import accountService from './account.service';
import { activeCapabilityCatalog } from './capabilityCatalog.service';
import { resolveLiveAgencyCoordinator } from './agencyServicePrincipal.service';
import { AGENCY_COORDINATE_CAPABILITY } from '../utils/applicationCapabilities';

const AUTONOMY_RANK: Readonly<Record<AutonomyLevel, number>> = {
  read_only: 0,
  draft: 1,
  execute_on_request: 2,
  autonomous: 3,
};
const SENSITIVE_PACKAGES = new Set(['finance', 'security', 'delegate']);

export interface CapabilityCoordinatorPrincipal {
  applicationId: string;
  credentialId: string;
}

export interface AuthorityRequest {
  executionAuthorizationId: string;
  coordinator: CapabilityCoordinatorPrincipal;
  /** Required when durable automation authority is materialized for one run. */
  runId?: string;
  stepId?: string;
}

export interface AuthorityResult {
  decision: PolicyDecision;
  ticket?: string;
  claims?: CapabilityTicketClaims;
}

interface GrantParts {
  grant: DelegationGrantRow;
  capabilities: string[];
  overrides: Array<{ tool: string; decision: 'allow' | 'deny' }>;
  limits: GrantLimit[];
}

type ExecutionAuthorizationRow = typeof capabilityExecutionAuthorizations.$inferSelect;

export function mostRestrictiveAutonomy(levels: readonly AutonomyLevel[]): AutonomyLevel {
  if (levels.length === 0) return 'read_only';
  return levels.reduce((result, level) => (
    AUTONOMY_RANK[level] < AUTONOMY_RANK[result] ? level : result
  ));
}

export function grantAllowsTool(
  tool: CatalogTool,
  grant: Pick<GrantParts, 'capabilities' | 'overrides'> & { capabilityPackages: readonly string[] },
): boolean {
  const override = grant.overrides.find((entry) => entry.tool === tool.name);
  if (override?.decision === 'deny') return false;
  if (override?.decision === 'allow') return true;
  if (tool.requiredCapabilities.every((capability) => grant.capabilities.includes(capability))) return true;
  return !SENSITIVE_PACKAGES.has(tool.capabilityPackage)
    && grant.capabilityPackages.includes(tool.capabilityPackage);
}

function mergeLimits(primary: readonly GrantLimit[], narrowing: readonly GrantLimit[]): GrantLimit[] {
  const merged = new Map(primary.map((limit) => [`${limit.tool}\0${limit.key}`, limit]));
  for (const limit of narrowing) {
    const mapKey = `${limit.tool}\0${limit.key}`;
    const current = merged.get(mapKey);
    if (!current) {
      merged.set(mapKey, limit);
    } else if (typeof current.value === 'number' && typeof limit.value === 'number') {
      merged.set(mapKey, { ...limit, value: Math.min(current.value, limit.value) });
    } else if (current.value !== limit.value) {
      throw new Error(`Execution limit ${limit.tool}.${limit.key} conflicts with the delegation`);
    }
  }
  return [...merged.values()];
}

async function requesterCanOperate(requesterAccountId: string, accountId: string): Promise<boolean> {
  const access = await accountService.resolveEffectiveAccess(requesterAccountId, accountId);
  return access?.permissions.includes('account:act_as') ?? false;
}

async function loadExecutionAuthorization(
  request: AuthorityRequest,
  now: Date,
): Promise<ExecutionAuthorizationRow | null> {
  const [authorization] = await getDb().select().from(capabilityExecutionAuthorizations).where(and(
    eq(capabilityExecutionAuthorizations.id, request.executionAuthorizationId),
    eq(capabilityExecutionAuthorizations.coordinatorApplicationId, request.coordinator.applicationId),
    eq(capabilityExecutionAuthorizations.coordinatorCredentialId, request.coordinator.credentialId),
    isNull(capabilityExecutionAuthorizations.revokedAt),
    gt(capabilityExecutionAuthorizations.expiresAt, now),
  )).limit(1);
  return authorization ?? null;
}

function actorOf(authorization: ExecutionAuthorizationRow): ActorRef {
  if (authorization.actorType === 'alia') {
    return { type: 'alia', ownerAccountId: authorization.ownerAccountId };
  }
  if (!authorization.actorAccountId) throw new Error('Agent execution authorization has no actor account');
  return { type: 'agent', accountId: authorization.actorAccountId };
}

function resourceOf(authorization: ExecutionAuthorizationRow): ResourceRef {
  return {
    appId: authorization.resourceApp,
    effectiveAccountId: authorization.effectiveAccountId,
    resourceType: authorization.resourceType,
    resourceId: authorization.resourceKey,
  };
}

async function loadGrant(
  authorization: ExecutionAuthorizationRow,
  actorAccountId: string,
  now: Date,
): Promise<GrantParts | null> {
  const db = getDb();
  const [grant] = await db.select().from(delegationGrants).where(and(
    eq(delegationGrants.ownerAccountId, authorization.ownerAccountId),
    eq(delegationGrants.actorAccountId, actorAccountId),
    eq(delegationGrants.resourceApp, authorization.resourceApp),
    eq(delegationGrants.effectiveAccountId, authorization.effectiveAccountId),
    eq(delegationGrants.resourceType, authorization.resourceType),
    eq(delegationGrants.resourceKey, authorization.resourceKey),
    isNull(delegationGrants.revokedAt),
    or(isNull(delegationGrants.expiresAt), gt(delegationGrants.expiresAt, now)),
  )).orderBy(desc(delegationGrants.createdAt)).limit(1);
  if (!grant) return null;
  const [capabilities, overrides, limits] = await Promise.all([
    db.select({ capability: delegationCapabilities.capability })
      .from(delegationCapabilities).where(eq(delegationCapabilities.grantId, grant.id)),
    db.select({ tool: delegationToolOverrides.tool, decision: delegationToolOverrides.decision })
      .from(delegationToolOverrides).where(eq(delegationToolOverrides.grantId, grant.id)),
    db.select({ tool: delegationLimits.tool, key: delegationLimits.key, value: delegationLimits.value })
      .from(delegationLimits).where(and(
        eq(delegationLimits.grantId, grant.id),
        eq(delegationLimits.tool, authorization.tool),
      )),
  ]);
  return { grant, capabilities: capabilities.map((entry) => entry.capability), overrides, limits };
}

function denied(reason: string): AuthorityResult {
  return { decision: { allowed: false, reason } };
}

export async function evaluateCapabilityAuthority(
  request: AuthorityRequest,
  options: { issueTicket?: boolean; now?: Date } = {},
): Promise<AuthorityResult> {
  const now = options.now ?? new Date();
  const coordinator = await resolveLiveAgencyCoordinator(
    request.coordinator.applicationId,
    request.coordinator.credentialId,
  );
  if (!coordinator
    || !coordinator.capabilities.includes(AGENCY_COORDINATE_CAPABILITY)
    || !coordinator.scopes.includes('capability-tickets:issue')) {
    return denied('coordinator_no_longer_authorized');
  }
  const authorization = await loadExecutionAuthorization(request, now);
  if (!authorization) return denied('execution_authorization_not_active');
  let runId: string;
  let stepId: string | undefined;
  if (authorization.kind === 'automation') {
    if (!request.runId) return denied('automation_run_identity_missing');
    runId = request.runId;
    stepId = request.stepId;
  } else {
    if (!authorization.runId) return denied('direct_request_run_identity_missing');
    if (request.runId !== undefined || request.stepId !== undefined) {
      return denied('direct_request_runtime_scope_override');
    }
    runId = authorization.runId;
    stepId = authorization.stepId ?? undefined;
  }
  if (!await requesterCanOperate(authorization.requesterAccountId, authorization.effectiveAccountId)) {
    return denied('requester_lacks_current_account_authority');
  }
  if (!await requesterCanOperate(authorization.requesterAccountId, authorization.ownerAccountId)) {
    return denied('requester_lacks_grant_owner_authority');
  }

  const registration = await activeCapabilityCatalog(authorization.resourceApp);
  if (!registration) return denied('catalog_not_registered');
  const tool = registration.catalog.tools.find((entry) => entry.name === authorization.tool);
  if (!tool || !tool.exposure.includes('internal')) return denied('tool_not_exposed_internally');
  if (!tool.resourceTypes.includes(authorization.resourceType)) return denied('resource_type_mismatch');

  const [policy] = await getDb().select().from(accountCapabilityPolicies).where(and(
    eq(accountCapabilityPolicies.accountId, authorization.effectiveAccountId),
    eq(accountCapabilityPolicies.appSlug, authorization.resourceApp),
  )).limit(1);
  if (policy?.deniedCapabilities.some((capability) => tool.requiredCapabilities.includes(capability))) {
    return denied('account_policy_denied_capability');
  }

  const actor = actorOf(authorization);
  let grantParts: GrantParts | null = null;
  let grantAutonomy: AutonomyLevel = 'autonomous';
  let limits = authorization.limits.filter((limit) => limit.tool === authorization.tool);
  if (limits.length !== authorization.limits.length) return denied('execution_limit_tool_mismatch');
  if (actor.type === 'agent') {
    const [actorRow] = await getDb().select({ kind: users.kind, accountStatus: users.accountStatus })
      .from(users).where(eq(users.id, actor.accountId)).limit(1);
    if (!actorRow || actorRow.kind !== 'bot' || actorRow.accountStatus === 'archived') {
      return denied('actor_is_not_an_active_bot_account');
    }
    grantParts = await loadGrant(authorization, actor.accountId, now);
    if (!grantParts) return denied('agent_has_no_active_grant');
    if (!grantAllowsTool(tool, {
      capabilities: grantParts.capabilities,
      overrides: grantParts.overrides,
      capabilityPackages: grantParts.grant.capabilityPackages,
    })) return denied('grant_does_not_allow_tool');
    grantAutonomy = grantParts.grant.maximumAutonomy;
    try {
      limits = mergeLimits(grantParts.limits, limits);
    } catch {
      return denied('execution_limits_conflict_with_grant');
    }
  }

  const effectiveAutonomy = mostRestrictiveAutonomy([
    authorization.maximumAutonomy,
    grantAutonomy,
    policy?.maximumAutonomy ?? 'autonomous',
  ]);
  if (AUTONOMY_RANK[effectiveAutonomy] < AUTONOMY_RANK[authorization.maximumAutonomy]) {
    return denied('requested_autonomy_exceeds_effective_policy');
  }
  if (authorization.kind === 'direct_request' && effectiveAutonomy === 'autonomous') {
    return denied('direct_request_cannot_be_autonomous');
  }
  if (tool.effect !== 'read' && AUTONOMY_RANK[effectiveAutonomy] < AUTONOMY_RANK.execute_on_request) {
    return denied('effect_requires_execution_authority');
  }

  const decision: PolicyDecision = {
    allowed: true,
    reason: 'allowed_by_current_authority',
    effectiveAutonomy,
    ...(grantParts ? { grantId: grantParts.grant.id } : {}),
  };
  if (!options.issueTicket) return { decision };

  const resource = resourceOf(authorization);
  const automationId = authorization.automationId;
  if (authorization.kind === 'automation' && !automationId) {
    return denied('automation_identity_missing');
  }
  const executionAuthorization: CapabilityTicketClaims['executionAuthorization'] =
    authorization.kind === 'automation' && automationId
      ? { kind: 'automation', id: authorization.id, automationId }
      : { kind: 'direct_request', id: authorization.id };
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const jti = randomUUID();
  const unsignedClaims: Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'> = {
    aud: registration.catalog.audience,
    sub: actor.type === 'agent' ? actor.accountId : `alia:${authorization.ownerAccountId}`,
    runId,
    ...(stepId ? { stepId } : {}),
    ...(automationId ? { automationId } : {}),
    executionAuthorization,
    coordinator: request.coordinator,
    ...(grantParts ? { grantId: grantParts.grant.id } : {}),
    requesterAccountId: authorization.requesterAccountId,
    ownerAccountId: authorization.ownerAccountId,
    actor,
    resource,
    tool: authorization.tool,
    capabilities: tool.requiredCapabilities,
    limits,
    autonomy: effectiveAutonomy,
  };
  const signing = capabilityTicketSigningConfig();
  const ticket = issueCapabilityTicket(unsignedClaims, {
    issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    privateKey: signing.privateKey,
    keyId: signing.keyId,
    ttlSeconds: 60,
    now,
    jti,
  });
  const claims: CapabilityTicketClaims = {
    ...unsignedClaims,
    iss: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    iat: issuedAt,
    exp: issuedAt + 60,
    jti,
  };
  return { decision, ticket, claims };
}

function claimsMatchAuthorization(claims: CapabilityTicketClaims, authorization: ExecutionAuthorizationRow): boolean {
  const actor = actorOf(authorization);
  const executionAuthorizationMatches = claims.executionAuthorization.kind === authorization.kind
    && (authorization.kind === 'direct_request'
      || (claims.executionAuthorization.kind === 'automation'
        && claims.executionAuthorization.automationId === authorization.automationId));
  const runScopeMatches = authorization.kind === 'automation'
    ? claims.automationId === authorization.automationId
    : claims.runId === authorization.runId
      && claims.stepId === (authorization.stepId ?? undefined);
  return executionAuthorizationMatches
    && claims.requesterAccountId === authorization.requesterAccountId
    && claims.ownerAccountId === authorization.ownerAccountId
    && claims.actor.type === actor.type
    && (actor.type === 'alia'
      ? claims.actor.type === 'alia' && claims.actor.ownerAccountId === actor.ownerAccountId
      : claims.actor.type === 'agent' && claims.actor.accountId === actor.accountId)
    && claims.resource.appId === authorization.resourceApp
    && claims.resource.effectiveAccountId === authorization.effectiveAccountId
    && claims.resource.resourceType === authorization.resourceType
    && claims.resource.resourceId === authorization.resourceKey
    && claims.tool === authorization.tool
    && runScopeMatches
    && claims.automationId === (authorization.automationId ?? undefined)
    && claims.autonomy === authorization.maximumAutonomy;
}

export async function reauthorizeCapabilityTicket(claims: CapabilityTicketClaims): Promise<PolicyDecision> {
  const now = new Date();
  const request = {
    executionAuthorizationId: claims.executionAuthorization.id,
    coordinator: claims.coordinator,
    ...(claims.executionAuthorization.kind === 'automation' ? {
      runId: claims.runId,
      ...(claims.stepId ? { stepId: claims.stepId } : {}),
    } : {}),
  };
  const authorization = await loadExecutionAuthorization(request, now);
  if (!authorization || !claimsMatchAuthorization(claims, authorization)) {
    return { allowed: false, reason: 'ticket_execution_authorization_mismatch' };
  }
  const result = await evaluateCapabilityAuthority(request, { now });
  if (claims.grantId && result.decision.grantId !== claims.grantId) {
    return { allowed: false, reason: 'ticket_grant_is_no_longer_current' };
  }
  return result.decision;
}
