/**
 * `oxy.agency` — native Alia and digital-agent authority.
 *
 * Oxy-owned delegation grants, account autonomy policy, execution
 * authorizations and their audit trail. These use the signed-in account
 * session: capability tickets and app service credentials stay on the server
 * and are never exposed to Settings clients.
 */
import type {
  AppCapabilityCatalog,
  AuditEvent,
  AutonomyLevel,
  CapabilityCatalogBinding,
  CapabilityPackage,
  DelegationGrant,
  GrantLimit,
  ResourceRef,
  ToolGrantOverride,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';

const SHORT_TTL = 60 * 1000;
const MEDIUM_TTL = 2 * 60 * 1000;

const enc = encodeURIComponent;

export type DelegationCatalogBinding = CapabilityCatalogBinding;
export type DelegationGrantView = DelegationGrant;

export interface CreateDelegationGrantInput {
  ownerAccountId: string;
  actorAccountId: string;
  resource: ResourceRef;
  capabilityPackages: CapabilityPackage[];
  capabilities: string[];
  toolOverrides?: ToolGrantOverride[];
  limits?: GrantLimit[];
  maximumAutonomy: AutonomyLevel;
  canRedelegate?: boolean;
  expiresAt?: string | null;
}

export type UpdateDelegationGrantInput = Pick<
  CreateDelegationGrantInput,
  | 'capabilityPackages'
  | 'capabilities'
  | 'toolOverrides'
  | 'limits'
  | 'maximumAutonomy'
  | 'canRedelegate'
  | 'expiresAt'
>;

export interface AvailableCapabilityCatalog {
  id: string;
  appId: string;
  version: string;
  digest: string;
  audience: string;
  catalog: AppCapabilityCatalog;
}

export interface AccountCapabilityPolicy {
  id: string;
  accountId: string;
  appSlug: string;
  maximumAutonomy: AutonomyLevel;
  deniedCapabilities: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PutAccountCapabilityPolicyInput {
  accountId: string;
  maximumAutonomy: AutonomyLevel;
  deniedCapabilities: string[];
}

export interface CapabilityExecutionAuthorization {
  id: string;
  kind: 'direct_request' | 'automation';
  requesterAccountId: string;
  ownerAccountId: string;
  coordinatorApplicationId: string;
  coordinatorCredentialId: string;
  actorType: 'alia' | 'agent';
  actorAccountId: string | null;
  resourceApp: string;
  effectiveAccountId: string;
  resourceType: string;
  resourceKey: string;
  tool: string;
  runId: string | null;
  stepId: string | null;
  automationId: string | null;
  maximumAutonomy: AutonomyLevel;
  limits: GrantLimit[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A present-requester assertion minted for a product backend (ADR 0025). */
export interface RequesterAssertionGrant {
  assertion: string;
  expiresAt: string;
  requesterAccountId: string;
  agentId: string;
}

/** Oxy's live answer to the audience that consumed an assertion (ADR 0025). */
export interface RequesterAssertionIntrospection {
  active: boolean;
  requesterAccountId?: string;
  agentId?: string;
  applicationId?: string;
  credentialId?: string;
  jti?: string;
  expiresAt?: string;
}


function query(path: string, key: string, value: string): string {
  return `${path}?${key}=${enc(value)}`;
}

const grantsKey = (ownerAccountId: string): string => `GET:${query('/capabilities/grants', 'ownerAccountId', ownerAccountId)}`;
const policiesKey = (accountId: string): string => `GET:${query('/capabilities/account-policies', 'accountId', accountId)}`;
const authorizationsKey = (ownerAccountId: string): string =>
  `GET:${query('/capabilities/execution-authorizations', 'ownerAccountId', ownerAccountId)}`;

/** `oxy.agency.grants` — what an owner account delegated to an actor. */
export class DelegationGrantsApi {
  constructor(private readonly ctx: OxyContext) {}

  /** The delegation grants an owner account issued. */
  async list(ownerAccountId: string): Promise<DelegationGrantView[]> {
    const res = await this.ctx.request<{ grants: DelegationGrantView[] }>(
      'GET',
      query('/capabilities/grants', 'ownerAccountId', ownerAccountId),
      undefined,
      { cache: true, cacheTTL: SHORT_TTL },
    );
    return res.grants;
  }

  /** Issue a delegation grant. */
  async create(input: CreateDelegationGrantInput): Promise<DelegationGrantView> {
    const res = await this.ctx.request<{ grant: DelegationGrantView }>('POST', '/capabilities/grants', input, {
      cache: false,
    });
    this.ctx.oxy.cache.delete(grantsKey(input.ownerAccountId));
    return res.grant;
  }

  /** Change a grant's capabilities, limits or autonomy. */
  async update(grantId: string, ownerAccountId: string, input: UpdateDelegationGrantInput): Promise<DelegationGrantView> {
    const res = await this.ctx.request<{ grant: DelegationGrantView }>(
      'PUT',
      `/capabilities/grants/${enc(grantId)}`,
      input,
      { cache: false },
    );
    this.ctx.oxy.cache.delete(grantsKey(ownerAccountId));
    return res.grant;
  }

  /** Revoke a grant. */
  async revoke(grantId: string, ownerAccountId: string): Promise<void> {
    await this.ctx.request<void>('DELETE', `/capabilities/grants/${enc(grantId)}`, undefined, { cache: false });
    this.ctx.oxy.cache.delete(grantsKey(ownerAccountId));
  }
}

/** `oxy.agency.policies` — an account's per-app autonomy policy. */
export class CapabilityPoliciesApi {
  constructor(private readonly ctx: OxyContext) {}

  /** An account's capability policies, one per app. */
  async list(accountId: string): Promise<AccountCapabilityPolicy[]> {
    const res = await this.ctx.request<{ policies: AccountCapabilityPolicy[] }>(
      'GET',
      query('/capabilities/account-policies', 'accountId', accountId),
      undefined,
      { cache: true, cacheTTL: SHORT_TTL },
    );
    return res.policies;
  }

  /** Set an account's policy for one app. */
  async put(appId: string, input: PutAccountCapabilityPolicyInput): Promise<AccountCapabilityPolicy> {
    const res = await this.ctx.request<{ policy: AccountCapabilityPolicy }>(
      'PUT',
      `/capabilities/account-policies/${enc(appId)}`,
      input,
      { cache: false },
    );
    this.ctx.oxy.cache.delete(policiesKey(input.accountId));
    return res.policy;
  }

  /** Drop an account's policy for one app. */
  async delete(appId: string, accountId: string): Promise<void> {
    await this.ctx.request<void>(
      'DELETE',
      `/capabilities/account-policies/${enc(appId)}?accountId=${enc(accountId)}`,
      undefined,
      { cache: false },
    );
    this.ctx.oxy.cache.delete(policiesKey(accountId));
  }
}

/** `oxy.agency.authorizations` — live execution authorizations. */
export class ExecutionAuthorizationsApi {
  constructor(private readonly ctx: OxyContext) {}

  /** An owner account's execution authorizations. */
  async list(ownerAccountId: string): Promise<CapabilityExecutionAuthorization[]> {
    const res = await this.ctx.request<{ authorizations: CapabilityExecutionAuthorization[] }>(
      'GET',
      query('/capabilities/execution-authorizations', 'ownerAccountId', ownerAccountId),
      undefined,
      { cache: true, cacheTTL: SHORT_TTL },
    );
    return res.authorizations;
  }

  /** Revoke an execution authorization. */
  async revoke(authorizationId: string, ownerAccountId: string): Promise<void> {
    await this.ctx.request<void>(
      'DELETE',
      `/capabilities/execution-authorizations/${enc(authorizationId)}`,
      undefined,
      { cache: false },
    );
    this.ctx.oxy.cache.delete(authorizationsKey(ownerAccountId));
  }
}

export class AgencyApi {
  /** What an owner account delegated to an actor. */
  readonly grants: DelegationGrantsApi;
  /** An account's per-app autonomy policy. */
  readonly policies: CapabilityPoliciesApi;
  /** Live execution authorizations. */
  readonly authorizations: ExecutionAuthorizationsApi;

  constructor(protected readonly ctx: OxyContext) {
    this.grants = new DelegationGrantsApi(ctx);
    this.policies = new CapabilityPoliciesApi(ctx);
    this.authorizations = new ExecutionAuthorizationsApi(ctx);
  }

  /** The capability catalogs available to an account. */
  async catalogs(accountId: string): Promise<AvailableCapabilityCatalog[]> {
    const res = await this.ctx.request<{ catalogs: AvailableCapabilityCatalog[] }>(
      'GET',
      query('/capabilities/catalogs/available', 'accountId', accountId),
      undefined,
      { cache: true, cacheTTL: MEDIUM_TTL },
    );
    return res.catalogs;
  }

  /** An account's capability audit trail. */
  async auditEvents(accountId: string): Promise<AuditEvent[]> {
    const res = await this.ctx.request<{ events: AuditEvent[] }>(
      'GET',
      query('/capabilities/audit', 'accountId', accountId),
      undefined,
      { cache: true, cacheTTL: SHORT_TTL },
    );
    return res.events;
  }
}
