/**
 * The server-side halves of the namespaces: what exists only with a service
 * credential. `OxyServer` returns these from its namespace getters, so
 * `server.assets.metadataByIds(...)` sits beside every client method of
 * `oxy.assets`.
 */
import { capabilityTicketRequestSchema, foregroundExecutionAuthorizationInputSchema, type ForegroundExecutionAuthorizationInput, type ActorRef, type AppCapabilityCatalog, type AutonomyLevel, type CapabilityTicketClaims, type CapabilityTicketRequest, type GrantLimit, type PolicyDecision, type ResourceRef, type CreateOxyNotificationRequest, type AwardReputationInput, type ReputationTransaction, type ServiceLinkedAccountListResponse } from '@oxy.so/contracts';
import type { RequestOptions } from '../HttpService';
import type { OxyContext, ServiceLane } from '../client/context';
import type {
  Notification,
  ServiceAssetMetadata,
  ServiceAssetMetadataBySha,
  ServiceLinkedDownloadUrl,
} from '../models/interfaces';
import { AssetsApi } from '../api/assets';
import { NotificationsApi } from '../api/notifications';
import { LinkedAccountsApi } from '../api/linkedAccounts';
import { AgencyApi, type CapabilityExecutionAuthorization, type RequesterAssertionGrant, type RequesterAssertionIntrospection } from '../api/agency';
import { ReputationApi } from '../api/reputation';
import { ServiceAssetMetadataError, ServiceLinkedDownloadUrlError } from '../OxyServices.errors';
import { extractErrorStatus } from '../utils/errorUtils';
import { logger } from '../logger';

/** Server-side cap of `POST /assets/service/by-ids`. */
const SERVICE_ASSET_METADATA_CHUNK_SIZE = 100;
/** Server-side cap of `POST /assets/service/by-sha256`. */
const SERVICE_ASSET_METADATA_BY_SHA_CHUNK_SIZE = 100;
/** Server-side cap of `POST /assets/service/linked-url`. */
const SERVICE_LINKED_DOWNLOAD_URL_CHUNK_SIZE = 25;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

const REPUTATION_CACHE_PREFIX = 'GET:/reputation/';

function lane(ctx: OxyContext): ServiceLane {
  if (!ctx.service) {
    throw new Error('This call needs a service credential (OxyServer from @oxy.so/core/server)');
  }
  return ctx.service;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)));
}

export class ServerAssetsApi extends AssetsApi {
  /**
   * Resolve many asset ids to their content-addressed metadata (`sha256`,
   * `mime`, `size`, `status`) via `POST /assets/service/by-ids`, one call per
   * chunk of 100. Service token with `files:read`.
   *
   * The server omits unknown/deleted ids, so a short result is normal — map by
   * `id`. FAILURE IS NOT ABSENCE: a failed chunk throws
   * {@link ServiceAssetMetadataError} carrying the ids it could not resolve,
   * unless `{ partial: true }` asks for best-effort. Never cached.
   */
  async metadataByIds(ids: string[], options: { partial?: boolean } = {}): Promise<ServiceAssetMetadata[]> {
    const unique = uniqueIds(ids);
    if (unique.length === 0) return [];

    const unresolvedIds: string[] = [];
    const statuses: number[] = [];
    let firstError: unknown;

    const settled = await Promise.all(
      chunk(unique, SERVICE_ASSET_METADATA_CHUNK_SIZE).map(async (part): Promise<ServiceAssetMetadata[]> => {
        try {
          const entries = await lane(this.ctx).request<ServiceAssetMetadata[]>('POST', '/assets/service/by-ids', { ids: part });
          return Array.isArray(entries) ? entries : [];
        } catch (error: unknown) {
          const status = extractErrorStatus(error);
          logger.warn('assets.metadataByIds: chunk failed', {
            method: 'assets.metadataByIds',
            chunkSize: part.length,
            status,
            partial: options.partial === true,
            error: error instanceof Error ? error.message : String(error),
          });
          unresolvedIds.push(...part);
          if (typeof status === 'number') statuses.push(status);
          firstError ??= error;
          return [];
        }
      }),
    );

    if (unresolvedIds.length > 0 && options.partial !== true) {
      throw new ServiceAssetMetadataError(unresolvedIds, statuses, firstError);
    }
    return settled.flat();
  }

  /**
   * Mint short-lived direct download URLs for files the calling application's
   * own users attached to it (`POST /assets/service/linked-url`, scope
   * `files:linked:read`). The ONLY way a service token reaches file bytes.
   *
   * A URL comes back only for a file whose OWN OWNER linked it to this
   * application; every other id is omitted, and the route answers identically
   * for "no such file" and "not yours". ABSENCE IS A REFUSAL, not a fact about
   * the file: decide what to tell your user from your own entitlement record.
   * A failed chunk throws {@link ServiceLinkedDownloadUrlError}; there is no
   * partial mode. Never cached — each URL is a live credential.
   */
  async linkedDownloadUrls(ids: string[]): Promise<ServiceLinkedDownloadUrl[]> {
    const unique = uniqueIds(ids);
    if (unique.length === 0) return [];

    const unresolvedIds: string[] = [];
    const statuses: number[] = [];
    let firstError: unknown;

    const settled = await Promise.all(
      chunk(unique, SERVICE_LINKED_DOWNLOAD_URL_CHUNK_SIZE).map(async (part): Promise<ServiceLinkedDownloadUrl[]> => {
        try {
          const entries = await lane(this.ctx).request<ServiceLinkedDownloadUrl[]>('POST', '/assets/service/linked-url', { ids: part });
          return Array.isArray(entries) ? entries : [];
        } catch (error: unknown) {
          const status = extractErrorStatus(error);
          // `chunkSize` and `status`, never the ids and never a `url`: a minted
          // URL in a log line is a credential in a log line.
          logger.warn('assets.linkedDownloadUrls: chunk failed', {
            method: 'assets.linkedDownloadUrls',
            chunkSize: part.length,
            status,
            error: error instanceof Error ? error.message : String(error),
          });
          unresolvedIds.push(...part);
          if (typeof status === 'number') statuses.push(status);
          firstError ??= error;
          return [];
        }
      }),
    );

    if (unresolvedIds.length > 0) {
      throw new ServiceLinkedDownloadUrlError(unresolvedIds, statuses, firstError);
    }
    return settled.flat();
  }

  /**
   * Reverse content-address lookup: resolve `sha256` digests to the servable
   * asset holding each (`POST /assets/service/by-sha256`, scope `files:read`),
   * with a public `url` for active public assets. Malformed hashes are dropped
   * client-side; the server omits unknown ones, so map by `sha256`. A failed
   * chunk is logged and skipped. Never cached.
   *
   * Asset rows are per owner. Pass `ownerUserId` to resolve each hash to THAT
   * account's own row — the id it may attach to its own content. Without it,
   * each hash resolves to the oldest live row of any owner: fine for "is this
   * stored" and for the public `url`, but that id belongs to whoever uploaded
   * first.
   */
  async metadataBySha256(
    sha256s: string[],
    options: { ownerUserId?: string } = {},
  ): Promise<ServiceAssetMetadataBySha[]> {
    const unique = Array.from(
      new Set(
        sha256s
          .filter((sha): sha is string => typeof sha === 'string')
          .map((sha) => sha.trim().toLowerCase())
          .filter((sha) => SHA256_HEX_PATTERN.test(sha)),
      ),
    );
    if (unique.length === 0) return [];

    const settled = await Promise.all(
      chunk(unique, SERVICE_ASSET_METADATA_BY_SHA_CHUNK_SIZE).map(async (part): Promise<ServiceAssetMetadataBySha[]> => {
        try {
          const body = options.ownerUserId ? { sha256s: part, ownerUserId: options.ownerUserId } : { sha256s: part };
          const entries = await lane(this.ctx).request<ServiceAssetMetadataBySha[]>('POST', '/assets/service/by-sha256', body);
          return Array.isArray(entries) ? entries : [];
        } catch (error: unknown) {
          logger.warn('assets.metadataBySha256: chunk failed, continuing with remaining chunks', {
            method: 'assets.metadataBySha256',
            chunkSize: part.length,
            status: extractErrorStatus(error),
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }),
    );
    return settled.flat();
  }
}

export class ServerNotificationsApi extends NotificationsApi {
  /**
   * Create a notification (`POST /notifications`; the application needs
   * `notifications:write`). `type` is one of `OXY_NOTIFICATION_TYPES` from
   * `@oxy.so/contracts` — `system` for a message from an Oxy service about the
   * recipient's own account.
   */
  async create(data: CreateOxyNotificationRequest): Promise<Notification> {
    const res = await lane(this.ctx).request<{ notification: Notification }>('POST', '/notifications', data);
    return res.notification;
  }
}

export class ServerLinkedAccountsApi extends LinkedAccountsApi {
  /**
   * A user's live linked accounts, each with the federated shadow user Oxy holds
   * for it (`federatedUserId`). Needs the privileged `linked-accounts:read`.
   */
  async forUser(userId: string): Promise<ServiceLinkedAccountListResponse> {
    return lane(this.ctx).request<ServiceLinkedAccountListResponse>(
      'GET',
      `/linked-accounts/by-user/${encodeURIComponent(userId)}`,
    );
  }
}

/** Projection of the existing service-authenticated registry response. */
export interface ServiceCapabilityCatalog {
  id: string;
  appSlug: string;
  version: string;
  digest: string;
  audience: string;
  catalog: AppCapabilityCatalog;
}

export interface CapabilityTicketGrant {
  decision: PolicyDecision;
  ticket?: string;
  claims?: CapabilityTicketClaims;
}

export interface CapabilityTicketIntrospection {
  active: boolean;
  claims?: CapabilityTicketClaims;
  decision?: PolicyDecision;
  error?: string;
}

interface ExecutionAuthorizationTerms {
  ownerAccountId: string;
  coordinatorApplicationId: string;
  coordinatorCredentialId: string;
  actor: ActorRef;
  resource: ResourceRef;
  tool: string;
  limits?: GrantLimit[];
  expiresAt: string;
}

export type CreateExecutionAuthorizationInput = ExecutionAuthorizationTerms & (
  | { kind: 'direct_request'; runId: string; stepId?: string; automationId?: never; maximumAutonomy: Exclude<AutonomyLevel, 'autonomous'> }
  | { kind: 'automation'; automationId: string; runId?: never; stepId?: never; maximumAutonomy: AutonomyLevel }
);

function agencyAuthorityOptions(signal?: AbortSignal): RequestOptions {
  signal?.throwIfAborted();
  return { cache: false, deduplicate: false, retry: false, skipAuth: true, timeout: 5000, ...(signal ? { signal } : {}) };
}

export class ServerAgencyApi extends AgencyApi {
  /** Live registry discovery with this service's existing capability scopes. */
  async serviceCatalogs(input: { appId?: string; signal?: AbortSignal } = {}): Promise<ServiceCapabilityCatalog[]> {
    const path = `/capabilities/catalogs${input.appId === undefined ? '' : `?appId=${encodeURIComponent(input.appId)}`}`;
    const result = await lane(this.ctx).request<{ registrations: ServiceCapabilityCatalog[] }>('GET', path, undefined, agencyAuthorityOptions(input.signal));
    return result.registrations;
  }

  /** Existing Oxy execution authority is required; this call creates none. */
  async issueCapabilityTicket(input: CapabilityTicketRequest, options: { signal?: AbortSignal } = {}): Promise<CapabilityTicketGrant> {
    return lane(this.ctx).request<CapabilityTicketGrant>('POST', '/capabilities/tickets', capabilityTicketRequestSchema.parse(input), agencyAuthorityOptions(options.signal));
  }

  /** Receiving app authenticates live introspection using its own service credential. */
  async introspectCapabilityTicket(ticket: string, options: { signal?: AbortSignal } = {}): Promise<CapabilityTicketIntrospection> {
    if (ticket.trim() === '') throw new Error('A capability ticket is required');
    return lane(this.ctx).request<CapabilityTicketIntrospection>('POST', '/capabilities/tickets/introspect', { ticket }, agencyAuthorityOptions(options.signal));
  }

  /**
   * Authenticates the existing user-authority route with the requester's bearer.
   * The service bearer and attribution headers cannot substitute for that user.
   * The token goes only to this client's configured Oxy authority; never retry.
   */
  async createExecutionAuthorization(input: CreateExecutionAuthorizationInput, options: { requesterToken: string; signal?: AbortSignal }): Promise<CapabilityExecutionAuthorization> {
    if (options.requesterToken === '' || /\s/.test(options.requesterToken)) throw new Error('A requester bearer is required');
    const result = await this.ctx.request<{ authorization: CapabilityExecutionAuthorization }>('POST', '/capabilities/execution-authorizations', input, {
      ...agencyAuthorityOptions(options.signal),
      headers: { Authorization: `Bearer ${options.requesterToken}` },
    });
    return result.authorization;
  }

  /** Revoke a direct approval on its canonical requester-authenticated lane. */
  async revokeExecutionAuthorization(authorizationId: string, options: { requesterToken: string; signal?: AbortSignal }): Promise<void> {
    options.signal?.throwIfAborted();
    if (!authorizationId || authorizationId.length > 255 || /\s/.test(authorizationId)) throw new Error('An execution authorization id is required');
    if (!options.requesterToken || options.requesterToken.length > 16_384 || /\s/.test(options.requesterToken)) throw new Error('A requester bearer is required');
    await this.ctx.request<void>('DELETE', `/capabilities/execution-authorizations/${encodeURIComponent(authorizationId)}`,
      undefined, { ...agencyAuthorityOptions(options.signal), headers: { Authorization: `Bearer ${options.requesterToken}` } });
  }

  /** Independent service proof plus present requester bearer, sent only to Oxy. */
  async createForegroundExecutionAuthorization(input: ForegroundExecutionAuthorizationInput, options: { requesterToken: string; signal?: AbortSignal }): Promise<CapabilityExecutionAuthorization> {
    if (options.requesterToken === '' || options.requesterToken.length > 16_384 || /\s/.test(options.requesterToken)) throw new Error('A requester bearer is required');
    const result = await lane(this.ctx).request<{ authorization: CapabilityExecutionAuthorization }>(
      'POST', '/capabilities/foreground-execution-authorizations',
      { ...foregroundExecutionAuthorizationInputSchema.parse(input), subjectToken: options.requesterToken },
      agencyAuthorityOptions(options.signal),
    );
    return result.authorization;
  }

  /**
   * Product backend → Oxy: trade the signed-in requester's access token for a
   * one-use assertion naming `agentId` (ADR 0025), authenticated with this
   * service's credential. `subjectToken` goes to Oxy only, in the body; never
   * forward it anywhere else. Not retried: a refusal is an answer, and the
   * caller mints per turn.
   */
  async mintRequesterAssertion(input: { agentId: string; subjectToken: string }): Promise<RequesterAssertionGrant> {
    return lane(this.ctx).request<RequesterAssertionGrant>(
      'POST',
      '/internal/native-agents/requester-assertions',
      { agentId: input.agentId, subjectToken: input.subjectToken },
      { retry: false, timeout: 5000 },
    );
  }

  /**
   * Audience → Oxy: verify, live-revalidate and CONSUME a present-requester
   * assertion (ADR 0025). A second call with the same assertion answers
   * `active: false`. Authenticated with the audience's own service credential.
   */
  async introspectRequesterAssertion(input: {
    assertion: string;
    presenter: { applicationId: string; credentialId: string };
  }): Promise<RequesterAssertionIntrospection> {
    return lane(this.ctx).request<RequesterAssertionIntrospection>(
      'POST',
      '/internal/native-agents/requester-assertions/introspect',
      { assertion: input.assertion, presenter: input.presenter },
      { retry: false, timeout: 5000 },
    );
  }
}

export class ServerReputationApi extends ReputationApi {
  /**
   * Award (or penalise) reputation to a user by `actionType`. Service token with
   * `reputation:write` only — people never award reputation, and nobody at Oxy
   * moves it by hand. Invalidates cached reputation reads.
   */
  async award(input: AwardReputationInput): Promise<ReputationTransaction> {
    const res = await lane(this.ctx).request<{ transaction: ReputationTransaction }>('POST', '/reputation/award', input);
    this.ctx.oxy.cache.deletePrefix(REPUTATION_CACHE_PREFIX);
    return res.transaction;
  }
}
