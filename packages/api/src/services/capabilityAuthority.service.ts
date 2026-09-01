import { createHmac } from 'node:crypto';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import {
  autonomyLevelSchema,
  type ActorRef,
  type AutonomyLevel,
  type CapabilityTicketClaims,
  type CatalogTool,
  type GrantLimit,
  type PolicyDecision,
  type ResourceRef,
} from '@oxyhq/contracts';
import { issueCapabilityTicket, verifyCapabilityTicket } from '@oxyhq/core/server';
import { getDb } from '../config/postgres';
import {
  accountCapabilityPolicies,
  delegationCapabilities,
  delegationGrants,
  delegationLimits,
  delegationToolOverrides,
  type DelegationGrantRow,
} from '../db/schema/agency';
import { users } from '../db/schema/users';
import accountService from './account.service';
import { activeCapabilityCatalog } from './capabilityCatalog.service';

const AUTONOMY_RANK: Readonly<Record<AutonomyLevel, number>> = {
  read_only: 0,
  draft: 1,
  execute_on_request: 2,
  autonomous: 3,
};

const SENSITIVE_PACKAGES = new Set(['finance', 'security', 'delegate']);

export interface AuthorityRequest {
  requesterAccountId: string;
  ownerAccountId: string;
  actor: ActorRef;
  resource: ResourceRef;
  tool: string;
  runId: string;
  stepId?: string;
  automationId?: string;
  requestedAutonomy: AutonomyLevel;
  coordinatorMaximumAutonomy?: AutonomyLevel;
  automationLimits?: GrantLimit[];
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
  const merged = new Map(primary.map((limit) => [limit.key, limit]));
  for (const limit of narrowing) {
    const current = merged.get(limit.key);
    if (!current) {
      merged.set(limit.key, limit);
      continue;
    }
    if (typeof current.value === 'number' && typeof limit.value === 'number') {
      merged.set(limit.key, { key: limit.key, value: Math.min(current.value, limit.value) });
    } else if (Array.isArray(current.value) && Array.isArray(limit.value)) {
      const allowedValues = limit.value;
      merged.set(limit.key, {
        key: limit.key,
        value: current.value.filter((value) => allowedValues.includes(value)),
      });
    } else if (current.value !== limit.value) {
      throw new Error(`Automation limit ${limit.key} conflicts with the delegation`);
    }
  }
  return [...merged.values()];
}

export function capabilityTicketSecret(): Buffer {
  const secret = process.env.CAPABILITY_TICKET_SECRET ?? process.env.ACCESS_TOKEN_SECRET;
  if (!secret) throw new Error('CAPABILITY_TICKET_SECRET or ACCESS_TOKEN_SECRET must be configured');
  return createHmac('sha256', secret).update('oxy-capability-ticket-v1').digest();
}

async function requesterCanOperate(requesterAccountId: string, accountId: string): Promise<boolean> {
  const access = await accountService.resolveEffectiveAccess(requesterAccountId, accountId);
  return access?.permissions.includes('account:act_as') ?? false;
}

async function loadGrant(request: AuthorityRequest, now: Date): Promise<GrantParts | null> {
  if (request.actor.type !== 'agent') return null;
  const db = getDb();
  const [grant] = await db
    .select()
    .from(delegationGrants)
    .where(and(
      eq(delegationGrants.ownerAccountId, request.ownerAccountId),
      eq(delegationGrants.actorAccountId, request.actor.accountId),
      eq(delegationGrants.resourceApp, request.resource.appId),
      eq(delegationGrants.effectiveAccountId, request.resource.effectiveAccountId),
      eq(delegationGrants.resourceType, request.resource.resourceType),
      eq(delegationGrants.resourceKey, request.resource.resourceId),
      isNull(delegationGrants.revokedAt),
      or(isNull(delegationGrants.expiresAt), gt(delegationGrants.expiresAt, now)),
    ))
    .orderBy(desc(delegationGrants.createdAt))
    .limit(1);
  if (!grant) return null;
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
    grant,
    capabilities: capabilities.map((entry) => entry.capability),
    overrides,
    limits,
  };
}

function denied(reason: string): AuthorityResult {
  return { decision: { allowed: false, reason } };
}

export async function evaluateCapabilityAuthority(
  request: AuthorityRequest,
  options: { issueTicket?: boolean; now?: Date } = {},
): Promise<AuthorityResult> {
  const now = options.now ?? new Date();
  if (request.resource.appId.trim().length === 0 || request.tool.trim().length === 0) return denied('invalid_request');
  if (!await requesterCanOperate(request.requesterAccountId, request.resource.effectiveAccountId)) {
    return denied('requester_lacks_current_account_authority');
  }
  if (!await requesterCanOperate(request.requesterAccountId, request.ownerAccountId)) {
    return denied('requester_lacks_grant_owner_authority');
  }

  const registration = await activeCapabilityCatalog(request.resource.appId);
  if (!registration) return denied('catalog_not_registered');
  const tool = registration.catalog.tools.find((entry) => entry.name === request.tool);
  if (!tool || !tool.exposure.includes('internal')) return denied('tool_not_exposed_internally');
  if (!tool.resourceTypes.includes(request.resource.resourceType)) return denied('resource_type_mismatch');

  const [policy] = await getDb()
    .select()
    .from(accountCapabilityPolicies)
    .where(and(
      eq(accountCapabilityPolicies.accountId, request.resource.effectiveAccountId),
      eq(accountCapabilityPolicies.appSlug, request.resource.appId),
    ))
    .limit(1);
  if (policy?.deniedCapabilities.some((capability) => tool.requiredCapabilities.includes(capability))) {
    return denied('account_policy_denied_capability');
  }

  let grantParts: GrantParts | null = null;
  let grantAutonomy: AutonomyLevel = 'autonomous';
  let limits: GrantLimit[] = [];
  if (request.actor.type === 'alia') {
    if (request.actor.ownerAccountId !== request.ownerAccountId) return denied('alia_owner_mismatch');
  } else {
    const [actor] = await getDb()
      .select({ kind: users.kind, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, request.actor.accountId))
      .limit(1);
    if (!actor || actor.kind !== 'bot' || actor.accountStatus === 'archived') {
      return denied('actor_is_not_an_active_bot_account');
    }
    grantParts = await loadGrant(request, now);
    if (!grantParts) return denied('agent_has_no_active_grant');
    if (!grantAllowsTool(tool, {
      capabilities: grantParts.capabilities,
      overrides: grantParts.overrides,
      capabilityPackages: grantParts.grant.capabilityPackages,
    })) return denied('grant_does_not_allow_tool');
    grantAutonomy = grantParts.grant.maximumAutonomy;
    try {
      limits = mergeLimits(grantParts.limits, request.automationLimits ?? []);
    } catch {
      return denied('automation_limits_conflict_with_grant');
    }
  }

  const effectiveAutonomy = mostRestrictiveAutonomy([
    request.requestedAutonomy,
    request.coordinatorMaximumAutonomy ?? 'execute_on_request',
    grantAutonomy,
    policy?.maximumAutonomy ?? 'autonomous',
  ]);
  if (AUTONOMY_RANK[effectiveAutonomy] < AUTONOMY_RANK[request.requestedAutonomy]) {
    return denied('requested_autonomy_exceeds_effective_policy');
  }
  if (tool.effect !== 'read' && effectiveAutonomy === 'read_only') return denied('read_only_policy_blocks_effect');

  const decision: PolicyDecision = {
    allowed: true,
    reason: 'allowed_by_current_authority',
    effectiveAutonomy,
    ...(grantParts ? { grantId: grantParts.grant.id } : {}),
  };
  if (!options.issueTicket) return { decision };

  const unsignedClaims: Omit<CapabilityTicketClaims, 'iss' | 'iat' | 'exp' | 'jti'> = {
    aud: registration.catalog.audience,
    sub: request.actor.type === 'agent' ? request.actor.accountId : `alia:${request.ownerAccountId}`,
    runId: request.runId,
    ...(request.stepId ? { stepId: request.stepId } : {}),
    ...(request.automationId ? { automationId: request.automationId } : {}),
    ...(grantParts ? { grantId: grantParts.grant.id } : {}),
    requesterAccountId: request.requesterAccountId,
    ownerAccountId: request.ownerAccountId,
    actor: request.actor,
    resource: request.resource,
    tool: request.tool,
    capabilities: tool.requiredCapabilities,
    limits,
    autonomy: effectiveAutonomy,
  };
  const ticket = issueCapabilityTicket(unsignedClaims, {
    issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    secret: capabilityTicketSecret(),
    ttlSeconds: 60,
    now,
  });
  const claims = verifyCapabilityTicket(ticket, {
    audience: registration.catalog.audience,
    issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
    secret: capabilityTicketSecret(),
    now,
  });
  return { decision, ticket, claims };
}

export async function reauthorizeCapabilityTicket(claims: CapabilityTicketClaims): Promise<PolicyDecision> {
  const result = await evaluateCapabilityAuthority({
    requesterAccountId: claims.requesterAccountId,
    ownerAccountId: claims.ownerAccountId,
    actor: claims.actor,
    resource: claims.resource,
    tool: claims.tool,
    runId: claims.runId,
    stepId: claims.stepId,
    automationId: claims.automationId,
    requestedAutonomy: autonomyLevelSchema.parse(claims.autonomy),
    automationLimits: claims.limits,
  });
  if (claims.grantId && result.decision.grantId !== claims.grantId) {
    return { allowed: false, reason: 'ticket_grant_is_no_longer_current' };
  }
  return result.decision;
}
