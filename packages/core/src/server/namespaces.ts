/**
 * The server-side halves of the namespaces: what exists only with a service
 * credential. `OxyServer` returns these from its namespace getters, so
 * `server.assets.metadataByIds(...)` sits beside every client method of
 * `oxy.assets`.
 */
import {
  capabilityTicketRequestSchema,
  foregroundExecutionAuthorizationInputSchema,
  type ForegroundExecutionAuthorizationInput,
  type ActorRef,
  type AppCapabilityCatalog,
  type AutonomyLevel,
  type CapabilityTicketClaims,
  type CapabilityTicketRequest,
  type GrantLimit,
  type PolicyDecision,
  type ResourceRef,
  type CreateOxyNotificationRequest,
  type AwardReputationInput,
  type ReputationTransaction,
  type ServiceLinkedAccountListResponse,
  accountAccessVerdictSchema,
  type AccountAccessVerdict,
} from '@oxy.so/contracts';
import type { RequestOptions } from '../HttpService';
import type { OxyContext, ServiceLane } from '../client/context';
import type {
  ApplicationFile,
  ApplicationFilePage,
  ApplicationFileUpload,
  FileVisibility,
  Notification,
  ServiceAssetMetadata,
  ServiceAssetMetadataBySha,
  ServiceLinkedDownloadUrl,
  ServiceUserMediaFile,
} from '../models/interfaces';
import { AssetsApi } from '../api/assets';
import { NotificationsApi } from '../api/notifications';
import { LinkedAccountsApi } from '../api/linkedAccounts';
import {
  AgencyApi,
  type CapabilityExecutionAuthorization,
  type RequesterAssertionGrant,
  type RequesterAssertionIntrospection,
} from '../api/agency';
import { ReputationApi } from '../api/reputation';
import { AppsApi } from '../api/apps';
import { AccountsApi } from '../api/accounts';
import {
  isOxyAliaMachinePrincipal,
  type AliaMachineCredentialIntrospection,
} from './aliaMachineCredential';
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
/** A header value fetch accepts on every runtime: printable ASCII only. */
const HEADER_SAFE_PATTERN = /^[\x20-\x7e]*$/;

/** The bytes of a streamed service upload: sent as the whole request body. */
export type ServiceUploadBody = Uint8Array | ArrayBuffer | Blob;

/** What `uploadAppFile` and `uploadUserMedia` may say about the bytes besides their type. */
export interface ServiceUploadDescription {
  /**
   * Stored as the file's original name. Sent as a header, so only printable
   * ASCII is sent; any other name is left out and the server names the file.
   */
  originalName?: string;
  /** Intrinsic media metadata (`x-media-metadata`), a JSON object. */
  metadata?: Record<string, unknown>;
  /** Abort the upload. */
  signal?: AbortSignal;
  /** Per-attempt timeout in ms; the SDK default is short for a file upload. */
  timeout?: number;
}

/** The headers both streamed service uploads share. */
function uploadHeaders(
  mime: string,
  description: ServiceUploadDescription,
): Record<string, string> {
  return {
    'Content-Type': mime,
    ...(description.originalName && HEADER_SAFE_PATTERN.test(description.originalName)
      ? { 'x-original-name': description.originalName }
      : {}),
    ...(description.metadata ? { 'x-media-metadata': JSON.stringify(description.metadata) } : {}),
  };
}

const REPUTATION_CACHE_PREFIX = 'GET:/reputation/';

function lane(ctx: OxyContext): ServiceLane {
  if (!ctx.service) {
    throw new Error('This call needs a service credential (OxyServer from @oxy.so/core/server)');
  }
  return ctx.service;
}

export class ServerAppsApi extends AppsApi {
  constructor(private readonly serverCtx: OxyContext) {
    super(serverCtx);
  }
  /** Live receiver-bound lookup using THIS resource server's own service token. */
  async introspectAliaMachineCredential(
    token: string,
  ): Promise<AliaMachineCredentialIntrospection> {
    if (!token.startsWith('oxy_sk_') || token.length > 2048) return { active: false };
    const answer = await lane(this.serverCtx).request<unknown>(
      'POST',
      '/internal/alia/machine-credentials/introspect',
      { token },
      { cache: false, retry: false },
    );
    if (!answer || typeof answer !== 'object' || Array.isArray(answer))
      throw new Error('Invalid machine credential verdict');
    const record = answer as Record<string, unknown>;
    if (record.active === false && Object.keys(record).length === 1) return { active: false };
    if (
      record.active !== true ||
      Object.keys(record).length !== 2 ||
      !isOxyAliaMachinePrincipal(record.principal)
    ) {
      throw new Error('Invalid machine credential verdict');
    }
    return { active: true, principal: record.principal };
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(
    new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
  );
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
  async metadataByIds(
    ids: string[],
    options: { partial?: boolean } = {},
  ): Promise<ServiceAssetMetadata[]> {
    const unique = uniqueIds(ids);
    if (unique.length === 0) return [];

    const unresolvedIds: string[] = [];
    const statuses: number[] = [];
    let firstError: unknown;

    const settled = await Promise.all(
      chunk(unique, SERVICE_ASSET_METADATA_CHUNK_SIZE).map(
        async (part): Promise<ServiceAssetMetadata[]> => {
          try {
            const entries = await lane(this.ctx).request<ServiceAssetMetadata[]>(
              'POST',
              '/assets/service/by-ids',
              { ids: part },
            );
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
        },
      ),
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
      chunk(unique, SERVICE_LINKED_DOWNLOAD_URL_CHUNK_SIZE).map(
        async (part): Promise<ServiceLinkedDownloadUrl[]> => {
          try {
            const entries = await lane(this.ctx).request<ServiceLinkedDownloadUrl[]>(
              'POST',
              '/assets/service/linked-url',
              { ids: part },
            );
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
        },
      ),
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
      chunk(unique, SERVICE_ASSET_METADATA_BY_SHA_CHUNK_SIZE).map(
        async (part): Promise<ServiceAssetMetadataBySha[]> => {
          try {
            const body = options.ownerUserId
              ? { sha256s: part, ownerUserId: options.ownerUserId }
              : { sha256s: part };
            const entries = await lane(this.ctx).request<ServiceAssetMetadataBySha[]>(
              'POST',
              '/assets/service/by-sha256',
              body,
            );
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
        },
      ),
    );
    return settled.flat();
  }

  /**
   * Store a file THIS application owns (`POST /assets/service/app`, scope
   * `files:app:write`, ADR 0041) — platform artwork no person owns. The owner
   * is always the calling application; its bytes count against the account
   * that owns the application. Image or video only, at most 40 MiB.
   *
   * `visibility` is required: `public` and `unlisted` are readable by anyone
   * with the link; `private` by no person — only this application, through
   * {@link linkedDownloadUrls}. Idempotent per (application, bytes): re-uploading
   * bytes this application already holds returns that file with
   * `deduplicated: true`, its visibility unchanged.
   */
  async uploadAppFile(
    bytes: ServiceUploadBody,
    mime: string,
    options: ServiceUploadDescription & { visibility: FileVisibility },
  ): Promise<ApplicationFileUpload> {
    return lane(this.ctx).request<ApplicationFileUpload>('POST', '/assets/service/app', bytes, {
      headers: { ...uploadHeaders(mime, options), 'x-visibility': options.visibility },
      cache: false,
      retry: false,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeout ? { timeout: options.timeout } : {}),
    });
  }

  /**
   * Change the visibility of one of this application's files
   * (`PATCH /assets/service/app/:id/visibility`, `files:app:write`). Rejects
   * with a 404 for a file that is not this application's.
   */
  async setAppFileVisibility(fileId: string, visibility: FileVisibility): Promise<ApplicationFile> {
    const res = await lane(this.ctx).request<{ file: ApplicationFile }>(
      'PATCH',
      `/assets/service/app/${encodeURIComponent(fileId)}/visibility`,
      { visibility },
      { cache: false },
    );
    return res.file;
  }

  /**
   * Delete one of this application's files (`DELETE /assets/service/app/:id`,
   * `files:app:delete`); its storage is purged in the background. Rejects with
   * a 404 for a file that is not this application's (or is already deleted)
   * and a 409 `FILE_IN_USE` while somebody else still holds it.
   */
  async deleteAppFile(fileId: string): Promise<void> {
    await lane(this.ctx).request<unknown>(
      'DELETE',
      `/assets/service/app/${encodeURIComponent(fileId)}`,
      undefined,
      { cache: false },
    );
  }

  /**
   * One page of this application's own files, newest first
   * (`GET /assets/service/app`, `files:app:write` or `files:app:delete`).
   * Pass the returned `nextCursor` back as `cursor` for the next page.
   */
  async listAppFiles(
    options: { limit?: number; cursor?: string } = {},
  ): Promise<ApplicationFilePage> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor) params.set('cursor', options.cursor);
    const query = params.toString();
    return lane(this.ctx).request<ApplicationFilePage>(
      'GET',
      `/assets/service/app${query ? `?${query}` : ''}`,
      undefined,
      { cache: false },
    );
  }

  /**
   * Store a public file OWNED BY an existing local user
   * (`POST /assets/service/user-media`, the staff-granted scope
   * `files:user-media:write`) — e.g. importing a person's media into their own
   * file space. Image or video only, at most 40 MiB. Rows are per owner: bytes
   * that user already holds return their existing file.
   */
  async uploadUserMedia(
    ownerUserId: string,
    bytes: ServiceUploadBody,
    mime: string,
    options: ServiceUploadDescription = {},
  ): Promise<ServiceUserMediaFile> {
    const res = await lane(this.ctx).request<{ file: ServiceUserMediaFile }>(
      'POST',
      '/assets/service/user-media',
      bytes,
      {
        headers: { ...uploadHeaders(mime, options), 'x-owner-user-id': ownerUserId },
        cache: false,
        retry: false,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeout ? { timeout: options.timeout } : {}),
      },
    );
    return res.file;
  }
}

export class ServerAccountsApi extends AccountsApi {
  constructor(private readonly serverCtx: OxyContext) {
    super(serverCtx);
  }

  /**
   * May `userId` act FOR `accountId`, and with what effective role and
   * permissions? `GET /internal/accounts/:accountId/access/:userId`, with this
   * service's own token; the application must be platform-trusted and hold the
   * privileged `accounts:membership:read`.
   *
   * The check an app makes before publishing to a `channel` on a member's
   * behalf with its own credential — nobody can act AS a channel, so this is how
   * a service with no session of that member (a long import) learns it may.
   *
   * `access` is `null` for no active membership, an archived, unknown or
   * unclaimed directory account. FAIL CLOSED: anything but a 200 carrying a
   * valid verdict throws, so a caller cannot read an outage as a "yes" — or as a
   * "no" that it then caches. Never cached: a removed member must lose the
   * right on the next call. Gate on `access.permissions`, not on `access.role`.
   */
  async accessFor(accountId: string, userId: string): Promise<AccountAccessVerdict> {
    if (!accountId || !userId)
      throw new Error('accounts.accessFor needs an accountId and a userId');
    const answer = await lane(this.serverCtx).request<unknown>(
      'GET',
      `/internal/accounts/${encodeURIComponent(accountId)}/access/${encodeURIComponent(userId)}`,
      undefined,
      { cache: false },
    );
    const verdict = accountAccessVerdictSchema.safeParse(answer);
    if (!verdict.success || verdict.data.accountId !== accountId) {
      throw new Error('Invalid account access verdict');
    }
    return verdict.data;
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
    const res = await lane(this.ctx).request<{ notification: Notification }>(
      'POST',
      '/notifications',
      data,
    );
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
  /**
   * The agent owner's published ceiling that bounds this authority (ADR 0042):
   * an agent acting for the requester on the requester's own account root,
   * with `ownerAccountId` the requester.
   */
  ceilingId?: string;
  expiresAt: string;
}

export type CreateExecutionAuthorizationInput = ExecutionAuthorizationTerms &
  (
    | {
        kind: 'direct_request';
        runId: string;
        stepId?: string;
        automationId?: never;
        maximumAutonomy: Exclude<AutonomyLevel, 'autonomous'>;
      }
    | {
        kind: 'automation';
        automationId: string;
        runId?: never;
        stepId?: never;
        maximumAutonomy: AutonomyLevel;
      }
  );

function agencyAuthorityOptions(signal?: AbortSignal): RequestOptions {
  signal?.throwIfAborted();
  return {
    cache: false,
    deduplicate: false,
    retry: false,
    skipAuth: true,
    timeout: 5000,
    ...(signal ? { signal } : {}),
  };
}

export class ServerAgencyApi extends AgencyApi {
  /** Live registry discovery with this service's existing capability scopes. */
  async serviceCatalogs(
    input: { appId?: string; signal?: AbortSignal } = {},
  ): Promise<ServiceCapabilityCatalog[]> {
    const path = `/capabilities/catalogs${input.appId === undefined ? '' : `?appId=${encodeURIComponent(input.appId)}`}`;
    const result = await lane(this.ctx).request<{ registrations: ServiceCapabilityCatalog[] }>(
      'GET',
      path,
      undefined,
      agencyAuthorityOptions(input.signal),
    );
    return result.registrations;
  }

  /** Existing Oxy execution authority is required; this call creates none. */
  async issueCapabilityTicket(
    input: CapabilityTicketRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<CapabilityTicketGrant> {
    return lane(this.ctx).request<CapabilityTicketGrant>(
      'POST',
      '/capabilities/tickets',
      capabilityTicketRequestSchema.parse(input),
      agencyAuthorityOptions(options.signal),
    );
  }

  /** Receiving app authenticates live introspection using its own service credential. */
  async introspectCapabilityTicket(
    ticket: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<CapabilityTicketIntrospection> {
    if (ticket.trim() === '') throw new Error('A capability ticket is required');
    return lane(this.ctx).request<CapabilityTicketIntrospection>(
      'POST',
      '/capabilities/tickets/introspect',
      { ticket },
      agencyAuthorityOptions(options.signal),
    );
  }

  /**
   * Authenticates the existing user-authority route with the requester's bearer.
   * The service bearer and attribution headers cannot substitute for that user.
   * The token goes only to this client's configured Oxy authority; never retry.
   */
  async createExecutionAuthorization(
    input: CreateExecutionAuthorizationInput,
    options: { requesterToken: string; signal?: AbortSignal },
  ): Promise<CapabilityExecutionAuthorization> {
    if (options.requesterToken === '' || /\s/.test(options.requesterToken))
      throw new Error('A requester bearer is required');
    const result = await this.ctx.request<{ authorization: CapabilityExecutionAuthorization }>(
      'POST',
      '/capabilities/execution-authorizations',
      input,
      {
        ...agencyAuthorityOptions(options.signal),
        headers: { Authorization: `Bearer ${options.requesterToken}` },
      },
    );
    return result.authorization;
  }

  /** Revoke a direct approval on its canonical requester-authenticated lane. */
  async revokeExecutionAuthorization(
    authorizationId: string,
    options: { requesterToken: string; signal?: AbortSignal },
  ): Promise<void> {
    options.signal?.throwIfAborted();
    if (!authorizationId || authorizationId.length > 255 || /\s/.test(authorizationId))
      throw new Error('An execution authorization id is required');
    if (
      !options.requesterToken ||
      options.requesterToken.length > 16_384 ||
      /\s/.test(options.requesterToken)
    )
      throw new Error('A requester bearer is required');
    await this.ctx.request<void>(
      'DELETE',
      `/capabilities/execution-authorizations/${encodeURIComponent(authorizationId)}`,
      undefined,
      {
        ...agencyAuthorityOptions(options.signal),
        headers: { Authorization: `Bearer ${options.requesterToken}` },
      },
    );
  }

  /** Independent service proof plus present requester bearer, sent only to Oxy. */
  async createForegroundExecutionAuthorization(
    input: ForegroundExecutionAuthorizationInput,
    options: { requesterToken: string; signal?: AbortSignal },
  ): Promise<CapabilityExecutionAuthorization> {
    if (
      options.requesterToken === '' ||
      options.requesterToken.length > 16_384 ||
      /\s/.test(options.requesterToken)
    )
      throw new Error('A requester bearer is required');
    const result = await lane(this.ctx).request<{
      authorization: CapabilityExecutionAuthorization;
    }>(
      'POST',
      '/capabilities/foreground-execution-authorizations',
      {
        ...foregroundExecutionAuthorizationInputSchema.parse(input),
        subjectToken: options.requesterToken,
      },
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
  async mintRequesterAssertion(input: {
    agentId: string;
    subjectToken: string;
  }): Promise<RequesterAssertionGrant> {
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
    const res = await lane(this.ctx).request<{ transaction: ReputationTransaction }>(
      'POST',
      '/reputation/award',
      input,
    );
    this.ctx.oxy.cache.deletePrefix(REPUTATION_CACHE_PREFIX);
    return res.transaction;
  }
}
