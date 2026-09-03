/**
 * Native Alia and digital-agent authority.
 *
 * These methods manage Oxy-owned delegation grants, account autonomy policy,
 * execution authorizations and their audit trail. They deliberately use the
 * signed-in account session: capability tickets and app service credentials
 * stay on the server and are never exposed to Settings clients.
 */
import type {
  AppCapabilityCatalog,
  AuditEvent,
  AutonomyLevel,
  CapabilityPackage,
  DelegationGrant,
  GrantLimit,
  ResourceRef,
  ToolGrantOverride,
} from '@oxyhq/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import { CACHE_TIMES } from './mixinHelpers';

export interface DelegationCatalogBinding {
  registrationId: string;
  version: string;
  digest: string;
}

export interface DelegationGrantView extends DelegationGrant {
  catalog: DelegationCatalogBinding | null;
}

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

function query(path: string, key: string, value: string): string {
  return `${path}?${key}=${encodeURIComponent(value)}`;
}

export function OxyServicesAgencyMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    async listAvailableCapabilityCatalogs(accountId: string): Promise<AvailableCapabilityCatalog[]> {
      try {
        const response = await this.makeRequest<{ catalogs: AvailableCapabilityCatalog[] }>(
          'GET',
          query('/capabilities/catalogs/available', 'accountId', accountId),
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.MEDIUM },
        );
        return response.catalogs;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async listDelegationGrants(ownerAccountId: string): Promise<DelegationGrantView[]> {
      try {
        const response = await this.makeRequest<{ grants: DelegationGrantView[] }>(
          'GET',
          query('/capabilities/grants', 'ownerAccountId', ownerAccountId),
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return response.grants;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async createDelegationGrant(input: CreateDelegationGrantInput): Promise<DelegationGrantView> {
      try {
        const response = await this.makeRequest<{ grant: DelegationGrantView }>(
          'POST',
          '/capabilities/grants',
          input,
          { cache: false },
        );
        this.clearCacheEntry(`GET:/capabilities/grants?ownerAccountId=${encodeURIComponent(input.ownerAccountId)}`);
        return response.grant;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async revokeDelegationGrant(grantId: string, ownerAccountId: string): Promise<void> {
      try {
        await this.makeRequest<void>(
          'DELETE',
          `/capabilities/grants/${encodeURIComponent(grantId)}`,
          undefined,
          { cache: false },
        );
        this.clearCacheEntry(`GET:/capabilities/grants?ownerAccountId=${encodeURIComponent(ownerAccountId)}`);
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async updateDelegationGrant(
      grantId: string,
      ownerAccountId: string,
      input: UpdateDelegationGrantInput,
    ): Promise<DelegationGrantView> {
      try {
        const response = await this.makeRequest<{ grant: DelegationGrantView }>(
          'PUT',
          `/capabilities/grants/${encodeURIComponent(grantId)}`,
          input,
          { cache: false },
        );
        this.clearCacheEntry(`GET:/capabilities/grants?ownerAccountId=${encodeURIComponent(ownerAccountId)}`);
        return response.grant;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async listAccountCapabilityPolicies(accountId: string): Promise<AccountCapabilityPolicy[]> {
      try {
        const response = await this.makeRequest<{ policies: AccountCapabilityPolicy[] }>(
          'GET',
          query('/capabilities/account-policies', 'accountId', accountId),
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return response.policies;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async putAccountCapabilityPolicy(
      appId: string,
      input: PutAccountCapabilityPolicyInput,
    ): Promise<AccountCapabilityPolicy> {
      try {
        const response = await this.makeRequest<{ policy: AccountCapabilityPolicy }>(
          'PUT',
          `/capabilities/account-policies/${encodeURIComponent(appId)}`,
          input,
          { cache: false },
        );
        this.clearCacheEntry(`GET:/capabilities/account-policies?accountId=${encodeURIComponent(input.accountId)}`);
        return response.policy;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async deleteAccountCapabilityPolicy(appId: string, accountId: string): Promise<void> {
      try {
        await this.makeRequest<void>(
          'DELETE',
          `/capabilities/account-policies/${encodeURIComponent(appId)}?accountId=${encodeURIComponent(accountId)}`,
          undefined,
          { cache: false },
        );
        this.clearCacheEntry(`GET:/capabilities/account-policies?accountId=${encodeURIComponent(accountId)}`);
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async listCapabilityExecutionAuthorizations(
      ownerAccountId: string,
    ): Promise<CapabilityExecutionAuthorization[]> {
      try {
        const response = await this.makeRequest<{ authorizations: CapabilityExecutionAuthorization[] }>(
          'GET',
          query('/capabilities/execution-authorizations', 'ownerAccountId', ownerAccountId),
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return response.authorizations;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async revokeCapabilityExecutionAuthorization(
      authorizationId: string,
      ownerAccountId: string,
    ): Promise<void> {
      try {
        await this.makeRequest<void>(
          'DELETE',
          `/capabilities/execution-authorizations/${encodeURIComponent(authorizationId)}`,
          undefined,
          { cache: false },
        );
        this.clearCacheEntry(
          `GET:/capabilities/execution-authorizations?ownerAccountId=${encodeURIComponent(ownerAccountId)}`,
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    async listCapabilityAuditEvents(accountId: string): Promise<AuditEvent[]> {
      try {
        const response = await this.makeRequest<{ events: AuditEvent[] }>(
          'GET',
          query('/capabilities/audit', 'accountId', accountId),
          undefined,
          { cache: true, cacheTTL: CACHE_TIMES.SHORT },
        );
        return response.events;
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
