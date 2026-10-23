/**
 * The server-side halves of the namespaces: what exists only with a service
 * credential. `OxyServer` returns these from its namespace getters, so
 * `server.assets.metadataByIds(...)` sits beside every client method of
 * `oxy.assets`.
 */
import {
  agentAvailabilitySchema,
  type AgentAvailability,
  capabilityTicketRequestSchema,
  foregroundExecutionAuthorizationInputSchema,
  firstPartyExecutionAuthorizationInputSchema,
  firstPartyTaskInputSchema,
  type FirstPartyTaskInput,
  type FirstPartyExecutionAuthorizationInput,
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
  ApplicationFileAdoption,
  AssetLiveStatus,
  ApplicationFileImport,
  ApplicationFileImportBatchResult,
  ApplicationFilePage,
  ApplicationFileUpload,
  AudioRenditionOptions,
  CreatedRecordingTarget,
  FileImportOptions,
  FileImportState,
  FileVisibility,
  PendingFileImport,
  Notification,
  PlaySession,
  PlaySessionState,
  PlaySessionOptions,
  RecordingTarget,
  RecordingTargetOptions,
  ServiceAssetMetadata,
  ServiceAssetMetadataBySha,
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceLinkedDownloadUrl,
  ServiceReferenceInventoryItem,
  ServiceReferenceReconcileResult,
  ServiceUserMediaFile,
  ServiceUserMediaImport,
} from '../models/interfaces';
import { AssetsApi } from '../api/assets';
import {
  runLargeUpload,
  type LargeServiceUploadOptions,
  type LargeServiceUploadResult,
  type LargeUploadSource,
} from './largeUpload';
import {
  ASSET_JOB_POLL_INITIAL_MS,
  isPendingImport,
  nextPollInterval,
  sleep,
  waitForImport,
} from './assetJobs';
import { NotificationsApi } from '../api/notifications';
import { OxyApiError } from '../OxyServices.errors';
import { LinkedAccountsApi } from '../api/linkedAccounts';
import {
  AgencyApi,
  type CapabilityExecutionAuthorization,
  type FirstPartyTask,
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
/** Server-side cap of `POST`/`DELETE /assets/service/references`. */
const SERVICE_REFERENCES_CHUNK_SIZE = 100;
/** Server-side cap of `POST /assets/service/app/import/batch`. */
const SERVICE_IMPORT_BATCH_SIZE = 50;
/** An import fetches a remote source (up to 60 s server-side): a longer per-attempt timeout. */
const SERVICE_IMPORT_TIMEOUT_MS = 90_000;
/** Server-side cap of one `PUT /assets/service/references/reconcile/:sessionId` page. */
const SERVICE_RECONCILE_PAGE_SIZE = 1000;
/** A page is a thousand rows written in one transaction: more than the default request budget. */
const SERVICE_RECONCILE_PAGE_TIMEOUT_MS = 30_000;
/** The commit request answers within seconds (202 while still running): its own budget. */
const SERVICE_RECONCILE_COMMIT_TIMEOUT_MS = 30_000;
/** How long `reconcile` waits for a commit Oxy runs in the background. */
const SERVICE_RECONCILE_COMMIT_WAIT_MS = 60 * 60_000;
/**
 * The least time between two pages of one inventory. Oxy allows an application
 * 240 inventory requests a minute (`appReferenceReconcileLimiter`); one
 * inventory paced at 200 a minute never meets that on its own, and leaves room
 * for a second task of the same application.
 */
const SERVICE_RECONCILE_PAGE_INTERVAL_MS = 300;
/** How many refusals (429) one reconciliation request waits out before failing. */
const SERVICE_RECONCILE_RATE_LIMIT_RETRIES = 8;
/** The wait after a refusal that names no `retryAfterSeconds`; doubled per refusal. */
const SERVICE_RECONCILE_RATE_LIMIT_FALLBACK_MS = 2_000;
/** The longest one wait may be, whatever the refusal says. */
const SERVICE_RECONCILE_RATE_LIMIT_MAX_WAIT_MS = 60_000;
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
  /** How an audio file is rendered (`x-audio-options`); ignored for images and videos. */
  audio?: AudioRenditionOptions;
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
    ...(description.audio ? { 'x-audio-options': JSON.stringify(description.audio) } : {}),
  };
}

/** A `202` import answer: the source is fetched in the background. */
type PendingImportAnswer = PendingFileImport;

/** One item of `/assets/service/app/import/batch` as the wire carries it. */
type ImportBatchWireItem =
  | ApplicationFileImportBatchResult
  | ({ index: number; ok: true; pending: true } & PendingFileImport);

/** Server-side bounds of a play session's lifetime. */
const PLAY_SESSION_MIN_TTL_SECONDS = 60;
const PLAY_SESSION_MAX_TTL_SECONDS = 43_200;
/** How long `completeRecordingTarget` waits for verification by default. */
const RECORDING_DEFAULT_WAIT_MS = 10 * 60_000;

/** An import's JSON body: the options the server reads, never the SDK's own. */
function importBody(
  sourceUrl: string,
  options: FileImportOptions & { visibility?: FileVisibility },
) {
  return {
    sourceUrl,
    ...(options.visibility ? { visibility: options.visibility } : {}),
    ...(options.reference ? { reference: options.reference } : {}),
    ...(options.revalidate !== undefined ? { revalidate: options.revalidate } : {}),
    ...(options.audio ? { audio: options.audio } : {}),
  };
}

/** The recording-target routes of one owner family, and the headers every call of it carries. */
function recordingTargetRoute(ownerUserId?: string): {
  base: string;
  headers: Record<string, string> | undefined;
} {
  return ownerUserId
    ? {
        base: '/assets/service/user-media/recording-targets',
        headers: { 'x-owner-user-id': ownerUserId },
      }
    : { base: '/assets/service/app/recording-targets', headers: undefined };
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
  /** Isolated requester context for uploads, imports, recordings and reads. */
  withRequester(
    proof: { requesterToken: string; taskId?: never } | { taskId: string; requesterToken?: never },
  ): ServerAssetsApi {
    const value = proof.requesterToken ?? proof.taskId;
    if (!value || /\s/.test(value) || (proof.requesterToken && proof.taskId))
      throw new Error('One requester proof is required');
    const original = lane(this.ctx);
    const fixed = { ...proof };
    const service: ServiceLane = {
      available: original.available,
      request: (method, url, data, options) =>
        original.request(method, url, data, { ...options, ...fixed }),
    };
    return new ServerAssetsApi({ ...this.ctx, service });
  }

  /**
   * The calling application's own uses of files (`file_references`, ADR 0043
   * D4; scope `files:references:write`). The application is always the service
   * token's — never sent. Batches above 100 go as several requests, in order;
   * the results come back in the order given.
   *
   * - `add`: this application's own files, any owner's active `public` or
   *   `unlisted` file, and a person's private file that person attached to this
   *   application. Never another application's private file. A reference never
   *   changes the file's visibility.
   * - `remove`: only references this application holds. Never trashes or
   *   deletes the file.
   */
  readonly references = {
    add: (references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]> =>
      this.sendReferences('POST', references),
    remove: (references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]> =>
      this.sendReferences('DELETE', references),
    /**
     * Reconcile this application's references of ONE entity type with its
     * real inventory (ADR 0043 D6) — the safety net for a reference a crash or
     * an old bug never registered, and how existing data first enters the
     * model. `items` is every `{ fileId, entityId }` the application uses for
     * `entityType` (an array or any (async) iterable — stream a large table);
     * it is sent in pages of 1,000 and committed: Oxy adds the missing
     * references it may hold, removes the stale ones created before the
     * reconciliation began (never trashing a file), and returns the counts.
     * `dryRun` returns the counts and changes nothing. One reconciliation per
     * entity type at a time (409 `RECONCILIATION_IN_PROGRESS`); if sending the
     * inventory fails, the session is released before the error is rethrown.
     *
     * Pages go at most 200 a minute, under Oxy's 240 a minute per application,
     * and every request waits out a refusal (429) for the `Retry-After` Oxy
     * names before sending again — so an inventory needs no pacing of its own.
     */
    reconcile: (
      entityType: string,
      items: Iterable<ServiceReferenceInventoryItem> | AsyncIterable<ServiceReferenceInventoryItem>,
      options: { dryRun?: boolean } = {},
    ): Promise<ServiceReferenceReconcileResult> =>
      this.reconcileReferences(entityType, items, options),
  };

  /**
   * Per-play, revocable streaming access (ADR 0043 stage 4c). A play session
   * is ONE file's HLS ladder (a video's, or an audio file's audio-only one)
   * for a short time, optionally for one end user: `masterUrl` is what the
   * player opens, and every playlist, segment and key it then fetches is
   * checked against the session — {@link revoke} stops playback at the next
   * request, on every Oxy server at once.
   *
   * Who may: this application's own file (`files:app:write` or
   * `files:linked:read`), or a person's file this application may read
   * (`files:linked:read`: the person attached it to this application, or this
   * application stored it for them — unless they revoked that). Anything else
   * is 404. A file with no ladder yet is 409 `STREAM_NOT_READY`.
   *
   * `encryption: 'aes-128'` (the default) encrypts every segment; the key is
   * served only inside the session, and with `keyAuthorization: 'webhook'`
   * only after your file-events endpoint allows it
   * (`verifyStreamKeyAuthorization`; 409 `FILES_WEBHOOK_REQUIRED` without a
   * verified endpoint).
   *
   * `renditions` limits the session to some rungs of the ladder (a free tier,
   * data saver): `create(fileId, { renditions: ['hls_a64', 'hls_a128'] })`
   * lists only those in the master and Oxy refuses every other rung's
   * playlist, segments and key for that session — enforced on each request,
   * not by omission.
   */
  readonly streams = {
    create: (fileId: string, options: PlaySessionOptions = {}): Promise<PlaySession> =>
      this.createPlaySession(fileId, options),
    /** The session's state; its URLs are shown only by `create`. */
    get: (sessionId: string): Promise<PlaySessionState> =>
      lane(this.ctx).request<PlaySessionState>(
        'GET',
        `/assets/service/streams/${encodeURIComponent(sessionId)}`,
        undefined,
        { cache: false },
      ),
    /** Revoke one session at once; revoking a revoked or expired one answers the same. */
    revoke: (sessionId: string): Promise<{ sessionId: string; revoked: true }> =>
      lane(this.ctx).request<{ sessionId: string; revoked: true }>(
        'DELETE',
        `/assets/service/streams/${encodeURIComponent(sessionId)}`,
        undefined,
        { cache: false },
      ),
    /** Revoke every active session of this application for a file, an end user, or both. */
    revokeWhere: (filter: { fileId?: string; endUserId?: string }): Promise<{ revoked: number }> =>
      this.revokePlaySessionsWhere(filter),
  };

  private async createPlaySession(
    fileId: string,
    options: PlaySessionOptions,
  ): Promise<PlaySession> {
    if (
      options.ttlSeconds !== undefined &&
      (!Number.isInteger(options.ttlSeconds) ||
        options.ttlSeconds < PLAY_SESSION_MIN_TTL_SECONDS ||
        options.ttlSeconds > PLAY_SESSION_MAX_TTL_SECONDS)
    ) {
      throw new RangeError(
        `ttlSeconds must be a whole number between ${PLAY_SESSION_MIN_TTL_SECONDS} and ${PLAY_SESSION_MAX_TTL_SECONDS}`,
      );
    }
    if (options.renditions !== undefined && options.renditions.length === 0) {
      throw new RangeError('renditions must name at least one rendition (omit it for all)');
    }
    return lane(this.ctx).request<PlaySession>(
      'POST',
      '/assets/service/streams',
      {
        fileId,
        ...(options.endUserId ? { endUserId: options.endUserId } : {}),
        ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
        ...(options.encryption ? { encryption: options.encryption } : {}),
        ...(options.keyAuthorization ? { keyAuthorization: options.keyAuthorization } : {}),
        ...(options.renditions ? { renditions: [...options.renditions] } : {}),
      },
      // Not retried: a lost answer would leave a second live session behind.
      { cache: false, retry: false },
    );
  }

  private async revokePlaySessionsWhere(filter: {
    fileId?: string;
    endUserId?: string;
  }): Promise<{ revoked: number }> {
    if (!filter.fileId && !filter.endUserId) {
      throw new Error('revokeWhere needs a fileId, an endUserId, or both');
    }
    return lane(this.ctx).request<{ revoked: number }>(
      'POST',
      '/assets/service/streams/revoke',
      {
        ...(filter.fileId ? { fileId: filter.fileId } : {}),
        ...(filter.endUserId ? { endUserId: filter.endUserId } : {}),
      },
      { cache: false },
    );
  }

  private async reconcileReferences(
    entityType: string,
    items: Iterable<ServiceReferenceInventoryItem> | AsyncIterable<ServiceReferenceInventoryItem>,
    options: { dryRun?: boolean },
  ): Promise<ServiceReferenceReconcileResult> {
    const service = lane(this.ctx);
    const dryRun = options.dryRun === true;
    // Every request below waits out Oxy's refusals (429): a refused request
    // never ran, so sending it again is safe whatever its method — and one
    // refused page used to fail the whole inventory.
    const { sessionId } = await waitingOutRateLimits(() =>
      service.request<{ sessionId: string }>(
        'POST',
        '/assets/service/references/reconcile',
        { entityType },
        // Not retried on a lost answer: a begin that succeeded would make the
        // retry a 409 against its own session.
        { cache: false, retry: false },
      ),
    );
    const path = `/assets/service/references/reconcile/${encodeURIComponent(sessionId)}`;
    const release = () =>
      waitingOutRateLimits(() =>
        service.request('DELETE', path, undefined, { cache: false }),
      ).catch(() => undefined);
    let result: ServiceReferenceReconcileResult;
    try {
      let page: ServiceReferenceInventoryItem[] = [];
      let lastPageAt = 0;
      const flush = async () => {
        if (page.length === 0) return;
        const items = page;
        page = [];
        const wait = lastPageAt + SERVICE_RECONCILE_PAGE_INTERVAL_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastPageAt = Date.now();
        // A page is idempotent (a pair sent twice counts once).
        await waitingOutRateLimits(() =>
          service.request(
            'PUT',
            path,
            { items },
            { cache: false, timeout: SERVICE_RECONCILE_PAGE_TIMEOUT_MS },
          ),
        );
      };
      for await (const { fileId, entityId } of items) {
        page.push({ fileId, entityId });
        if (page.length === SERVICE_RECONCILE_PAGE_SIZE) await flush();
      }
      await flush();
      // A large inventory can take longer than a request may: Oxy answers 202
      // while it is still committing, and the outcome is read back.
      const answer = await waitingOutRateLimits(() =>
        service.request<ServiceReferenceReconcileResult | { status: 'committing' }>(
          'POST',
          `${path}/commit`,
          { dryRun, background: true },
          { cache: false, retry: false, timeout: SERVICE_RECONCILE_COMMIT_TIMEOUT_MS },
        ),
      );
      result = isCommitting(answer) ? await waitForCommit(service, path, sessionId) : answer;
    } catch (error) {
      // Release the slot so the next attempt need not wait for it to expire.
      // Best effort: a session still committing is not released (Oxy finishes
      // it), and an already-committed or expired one answers 404, which is fine.
      await release();
      throw error;
    }
    // A dry run leaves the session open for a real commit this API never makes:
    // release it, or the entity type's next reconciliation is refused (409)
    // until the session expires.
    if (dryRun) await release();
    return result;
  }

  private async sendReferences(
    method: 'POST' | 'DELETE',
    references: ServiceFileReference[],
  ): Promise<ServiceFileReferenceResult[]> {
    const results: ServiceFileReferenceResult[] = [];
    for (let start = 0; start < references.length; start += SERVICE_REFERENCES_CHUNK_SIZE) {
      const chunk = references
        .slice(start, start + SERVICE_REFERENCES_CHUNK_SIZE)
        .map(({ fileId, entityType, entityId }) => ({ fileId, entityType, entityId }));
      const res = await lane(this.ctx).request<{ results: ServiceFileReferenceResult[] }>(
        method,
        '/assets/service/references',
        { references: chunk },
        { cache: false },
      );
      results.push(...res.results);
    }
    return results;
  }

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
   * Mint short-lived direct download URLs for files the calling application
   * may read (`POST /assets/service/linked-url`, scope `files:linked:read`).
   * The way a service token reaches file bytes (besides {@link streams}).
   *
   * A URL comes back for this application's own files, and for a person's
   * file the person consented to: they attached it to this application (ADR
   * 0021), or this application stored it for them (a user-media upload,
   * import, large upload or recording, ADR 0043 stage 4c) — unless they
   * revoked this application's access in their file manager. Every other id
   * is omitted, and the route answers identically
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
   * `files:app:write`, ADR 0043) — content no person owns. The owner is
   * always the calling application. A third-party application's bytes count
   * toward its developer account's storage plan (over it: 413
   * `STORAGE_QUOTA_EXCEEDED`); Oxy's own applications are not metered. Image,
   * video or audio (an SVG is sanitized and stored as sanitized), at most
   * 40 MiB; `audio` sets how an audio file is rendered. Bytes taken down after a content claim are
   * refused for every owner (451 `CONTENT_BLOCKED`, ADR 0043 D10) — here, by
   * the imports and by every other upload.
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
   * Store a file of ANY type, up to 8 GiB, that THIS application owns, by a
   * resumable multipart upload (`/assets/service/app/uploads`, ADR 0043 stage
   * 4b; `files:app:write`, plus `files:references:write` for `reference`).
   * The source is hashed first (8 MiB at a time; pass `sha256` to skip it),
   * then its parts go straight to storage on presigned URLs,
   * `partConcurrency` at a time, each retried — no byte passes through the
   * API — and Oxy hashes the assembled file before it is one: bytes that do
   * not match are refused (422 `CHECKSUM_MISMATCH`). Calling again for the
   * same bytes after a crash RESUMES: only the parts storage lacks are sent.
   * Bytes this application already holds answer at once (`deduplicated`).
   * Refused: executables and active documents such as HTML or XML (415), more
   * than 8 GiB (413), taken-down bytes (451 `CONTENT_BLOCKED`), a full plan
   * for a third-party application (413 `STORAGE_QUOTA_EXCEEDED`). An SVG (at
   * most 5 MiB) is sanitized at verification and stored sanitized. Non-media
   * types are served as downloads. Renditions are made for images (up to
   * 100 MiB; an SVG is rasterized), videos, and audio (an audio-only HLS
   * ladder, a waveform and a 30-second preview; `audio` options).
   */
  async uploadAppFileLarge(
    source: LargeUploadSource,
    options: LargeServiceUploadOptions & { visibility: FileVisibility },
  ): Promise<LargeServiceUploadResult<ApplicationFile>> {
    return runLargeUpload<ApplicationFile>(
      lane(this.ctx),
      '/assets/service/app/uploads',
      {},
      options.visibility,
      source,
      options,
    );
  }

  /**
   * {@link uploadAppFileLarge} into an existing local user's files
   * (`/assets/service/user-media/uploads`, `files:user-media:write`): the
   * account owns the file; public unless `visibility` says otherwise. This
   * application may read the file (it stored it for the person) until the
   * person revokes that.
   */
  async uploadUserMediaLarge(
    ownerUserId: string,
    source: LargeUploadSource,
    options: LargeServiceUploadOptions & { visibility?: FileVisibility },
  ): Promise<LargeServiceUploadResult<ServiceUserMediaFile & { status: AssetLiveStatus }>> {
    return runLargeUpload<ServiceUserMediaFile & { status: AssetLiveStatus }>(
      lane(this.ctx),
      '/assets/service/user-media/uploads',
      { 'x-owner-user-id': ownerUserId },
      options.visibility,
      source,
      options,
    );
  }

  /**
   * Abandon an unfinished large upload of this application's: storage
   * discards its parts. One being verified cannot be aborted (409).
   */
  async abortAppFileUpload(uploadId: string): Promise<void> {
    await lane(this.ctx).request<unknown>(
      'DELETE',
      `/assets/service/app/uploads/${encodeURIComponent(uploadId)}`,
      undefined,
      { cache: false },
    );
  }

  /** {@link abortAppFileUpload} for an upload into `ownerUserId`'s files. */
  async abortUserMediaUpload(ownerUserId: string, uploadId: string): Promise<void> {
    await lane(this.ctx).request<unknown>(
      'DELETE',
      `/assets/service/user-media/uploads/${encodeURIComponent(uploadId)}`,
      undefined,
      { headers: { 'x-owner-user-id': ownerUserId }, cache: false },
    );
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
   * Take ownership of a file this application can read, without uploading it
   * again (`POST /assets/service/app/adopt`, `files:app:write`, ADR 0043 stage
   * 4b): this application gets its OWN file of the same bytes — it outlives the
   * source, whose owner may delete theirs — sharing the stored object. Readable
   * means what a reference may name: any owner's active `public` or `unlisted`
   * file, a person's private file its owner attached to this application (ADR
   * 0021), or this application's own (answered as it is). The copy may not be
   * more visible than the source (400 `VISIBILITY_WIDER_THAN_SOURCE`);
   * anything else is 404, taken-down bytes 451. Idempotent per (application,
   * bytes). `reference` registers the use in the same call (needs
   * `files:references:write`). A third-party application's adoption counts
   * toward its developer's plan.
   */
  async adoptAppFile(
    fileId: string,
    options: {
      visibility: FileVisibility;
      reference?: { entityType: string; entityId: string };
    },
  ): Promise<ApplicationFileAdoption> {
    return lane(this.ctx).request<ApplicationFileAdoption>(
      'POST',
      '/assets/service/app/adopt',
      {
        fileId,
        visibility: options.visibility,
        ...(options.reference ? { reference: options.reference } : {}),
      },
      { cache: false },
    );
  }

  /**
   * Import a file by URL that THIS application owns
   * (`POST /assets/service/app/import`, `files:app:write`, ADR 0043 D7). Oxy
   * fetches `sourceUrl` itself — `https` only, public addresses only, bounded
   * redirects, size and time — and stores it like {@link uploadAppFile}
   * (image, video or audio; SVG is sanitized). A source over 40 MiB (up to
   * 8 GiB — a podcast enclosure) is fetched in the background: this call
   * waits for it (`waitMs`, default 60 min) and resolves the same way.
   * Importing the same URL again answers the existing file without fetching
   * (`outcome: 'existing'`); `revalidate` asks the source conditionally.
   * `reference` registers this application's use of the file in the same
   * request (needs `files:references:write`). Not retried: a lost answer is
   * safe to repeat by calling again.
   */
  async importAppFile(
    sourceUrl: string,
    options: FileImportOptions & { visibility: FileVisibility; signal?: AbortSignal },
  ): Promise<ApplicationFileImport> {
    const { signal } = options;
    const answer = await lane(this.ctx).request<ApplicationFileImport | PendingImportAnswer>(
      'POST',
      '/assets/service/app/import',
      importBody(sourceUrl, options),
      {
        cache: false,
        retry: false,
        timeout: SERVICE_IMPORT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
    );
    if (!isPendingImport(answer)) return answer;
    return waitForImport<ApplicationFileImport>(
      lane(this.ctx),
      '/assets/service/app/imports',
      answer.importId,
      undefined,
      { waitMs: options.waitMs, signal },
    );
  }

  /**
   * Import many files by URL for THIS application
   * (`POST /assets/service/app/import/batch`), 50 per request, in order. Each
   * item answers on its own — `{ ok: true, file, outcome, … }` or
   * `{ ok: false, error: { status, code, message } }` — with `index` into the
   * array given here. An item whose source is over 40 MiB is waited for (up to
   * `options.waitMs`, default 60 min) and answers like the others; one that
   * fails or is not done in time answers `ok: false` with its error.
   */
  async importAppFiles(
    items: Array<FileImportOptions & { sourceUrl: string; visibility: FileVisibility }>,
    options: { waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<ApplicationFileImportBatchResult[]> {
    const results: ApplicationFileImportBatchResult[] = [];
    for (let start = 0; start < items.length; start += SERVICE_IMPORT_BATCH_SIZE) {
      const part = items
        .slice(start, start + SERVICE_IMPORT_BATCH_SIZE)
        .map(({ sourceUrl, ...rest }) => importBody(sourceUrl, rest));
      const res = await lane(this.ctx).request<{ results: ImportBatchWireItem[] }>(
        'POST',
        '/assets/service/app/import/batch',
        { items: part },
        {
          cache: false,
          retry: false,
          timeout: SERVICE_IMPORT_TIMEOUT_MS * 2,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      const settled = await Promise.all(
        res.results.map((result) => this.settleBatchImport(result, options)),
      );
      results.push(...settled.map((result) => ({ ...result, index: result.index + start })));
    }
    return results;
  }

  /** A batch item Oxy is still fetching, waited for and answered like the others. */
  private async settleBatchImport(
    item: ImportBatchWireItem,
    options: { waitMs?: number; signal?: AbortSignal },
  ): Promise<ApplicationFileImportBatchResult> {
    if (!(item.ok && 'pending' in item && item.pending === true)) {
      return item as ApplicationFileImportBatchResult;
    }
    try {
      const done = await waitForImport<ApplicationFileImport>(
        lane(this.ctx),
        '/assets/service/app/imports',
        item.importId,
        undefined,
        options,
      );
      return { index: item.index, ok: true, ...done };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure =
        error instanceof OxyApiError
          ? { status: error.status, code: error.code, message: error.message }
          : {
              status: 502,
              code: 'IMPORT_FAILED',
              message: error instanceof Error ? error.message : 'The import failed',
            };
      return { index: item.index, ok: false, error: failure };
    }
  }

  /**
   * Import a file by URL into an existing local user's files
   * (`POST /assets/service/user-media/import`, the staff-granted scope
   * `files:user-media:write`, ADR 0043 D7) — the account-owned twin of
   * {@link importAppFile}, public unless `visibility` says otherwise (a
   * `private` file reaches no CDN; this application can still read it — it
   * stored it for the person — until the person revokes that). The same URL
   * imported again for the same user answers the existing file. Sources over
   * 40 MiB are waited for as in {@link importAppFile}.
   */
  async importUserMedia(
    ownerUserId: string,
    sourceUrl: string,
    options: FileImportOptions & { visibility?: FileVisibility; signal?: AbortSignal } = {},
  ): Promise<ServiceUserMediaImport> {
    const { signal } = options;
    const headers = { 'x-owner-user-id': ownerUserId };
    const answer = await lane(this.ctx).request<ServiceUserMediaImport | PendingImportAnswer>(
      'POST',
      '/assets/service/user-media/import',
      importBody(sourceUrl, options),
      {
        headers,
        cache: false,
        retry: false,
        timeout: SERVICE_IMPORT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
    );
    if (!isPendingImport(answer)) return answer;
    return waitForImport<ServiceUserMediaImport>(
      lane(this.ctx),
      '/assets/service/user-media/imports',
      answer.importId,
      headers,
      { waitMs: options.waitMs, signal },
    );
  }

  /**
   * One background import as it stands (`GET /assets/service/{app,user-media}/imports/:importId`)
   * — to collect an import an earlier call stopped waiting for
   * (`IMPORT_WAIT_TIMEOUT`). Pass `ownerUserId` for an import into a person's files.
   */
  async getImport(
    importId: string,
    options: { ownerUserId?: string } = {},
  ): Promise<
    FileImportState<ApplicationFile | (ServiceUserMediaFile & { status: AssetLiveStatus })>
  > {
    const base = options.ownerUserId
      ? '/assets/service/user-media/imports'
      : '/assets/service/app/imports';
    return lane(this.ctx).request('GET', `${base}/${encodeURIComponent(importId)}`, undefined, {
      cache: false,
      ...(options.ownerUserId ? { headers: { 'x-owner-user-id': options.ownerUserId } } : {}),
    });
  }

  // ── Recording targets (LiveKit egress) ──────────────────────────────────

  /**
   * An upload target a room recorder writes into (ADR 0043 stage 4c): Oxy
   * answers S3-compatible credentials that accept exactly ONE object — the
   * recording at `filepath` — and nothing else, for `expiresInSeconds`.
   * Hand `livekit` to LiveKit's egress as its `EncodedFileOutput`
   * (`{ filepath, s3 }`, as it is); any S3 client works with `s3` (path-style).
   * Once the recording is written Oxy hashes it and it becomes THIS
   * application's file (`visibility`), with `reference` registered
   * (`files:references:write`). `files:app:write`. The secret is shown only
   * in this answer.
   */
  async createAppRecordingTarget(
    options: RecordingTargetOptions & { visibility: FileVisibility },
  ): Promise<CreatedRecordingTarget> {
    return this.createRecordingTarget(recordingTargetRoute(), options);
  }

  /**
   * {@link createAppRecordingTarget} for a recording an existing local user
   * will own (`files:user-media:write`): private unless `visibility` says
   * otherwise; this application may read it (it stored it for the person)
   * until the person revokes that.
   */
  async createUserRecordingTarget(
    ownerUserId: string,
    options: RecordingTargetOptions & { visibility?: FileVisibility } = {},
  ): Promise<CreatedRecordingTarget> {
    return this.createRecordingTarget(recordingTargetRoute(ownerUserId), options);
  }

  private async createRecordingTarget(
    route: { base: string; headers: Record<string, string> | undefined },
    options: RecordingTargetOptions & { visibility?: FileVisibility },
  ): Promise<CreatedRecordingTarget> {
    return lane(this.ctx).request<CreatedRecordingTarget>(
      'POST',
      route.base,
      {
        ...(options.visibility ? { visibility: options.visibility } : {}),
        ...(options.filename ? { filename: options.filename } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
        ...(options.reference ? { reference: options.reference } : {}),
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        ...(options.expiresInSeconds !== undefined
          ? { expiresInSeconds: options.expiresInSeconds }
          : {}),
        ...(options.audio ? { audio: options.audio } : {}),
      },
      // Not retried: each answer carries a new secret.
      { cache: false, retry: false, ...(route.headers ? { headers: route.headers } : {}) },
    );
  }

  /** A recording target as it stands. Pass `ownerUserId` for a person's recording. */
  async getRecordingTarget(
    targetId: string,
    options: { ownerUserId?: string } = {},
  ): Promise<RecordingTarget> {
    const route = recordingTargetRoute(options.ownerUserId);
    return lane(this.ctx).request<RecordingTarget>(
      'GET',
      `${route.base}/${encodeURIComponent(targetId)}`,
      undefined,
      { cache: false, ...(route.headers ? { headers: route.headers } : {}) },
    );
  }

  /**
   * Collect a recording once the recorder finished (Oxy also finalizes it on
   * its own as soon as the object is written; this is idempotent): resolves to
   * the completed target with its `file`, waiting while Oxy verifies (up to
   * `waitMs`, default 10 min). Rejects with 409 `RECORDING_NOT_RECEIVED` while
   * nothing was written, and with the target's own error once it failed.
   */
  async completeRecordingTarget(
    targetId: string,
    options: { ownerUserId?: string; waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<RecordingTarget> {
    const route = recordingTargetRoute(options.ownerUserId);
    const path = `${route.base}/${encodeURIComponent(targetId)}`;
    const requestOptions = {
      cache: false,
      ...(route.headers ? { headers: route.headers } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const complete = () =>
      lane(this.ctx).request<RecordingTarget>('POST', `${path}/complete`, undefined, {
        ...requestOptions,
        retry: false,
      });
    let target = await complete();
    const deadline = Date.now() + (options.waitMs ?? RECORDING_DEFAULT_WAIT_MS);
    let interval = ASSET_JOB_POLL_INITIAL_MS;
    while (target.status === 'verifying' || target.status === 'receiving') {
      if (Date.now() + interval > deadline) {
        throw new OxyApiError('Oxy is still verifying the recording; collect it later', {
          status: 0,
          code: 'RECORDING_WAIT_TIMEOUT',
          details: { targetId },
          timeout: true,
        });
      }
      await sleep(interval, options.signal);
      interval = nextPollInterval(interval);
      target = await lane(this.ctx).request<RecordingTarget>(
        'GET',
        path,
        undefined,
        requestOptions,
      );
    }
    // A target that failed while it was polled: `complete` answers its own
    // error status (422, 451, 413, 410), which is the error to raise.
    if (target.status === 'failed' || target.status === 'aborted') return complete();
    return target;
  }

  /** Abandon a recording target: its credentials stop working and anything written goes. */
  async abortRecordingTarget(
    targetId: string,
    options: { ownerUserId?: string } = {},
  ): Promise<RecordingTarget> {
    const route = recordingTargetRoute(options.ownerUserId);
    return lane(this.ctx).request<RecordingTarget>(
      'DELETE',
      `${route.base}/${encodeURIComponent(targetId)}`,
      undefined,
      { cache: false, ...(route.headers ? { headers: route.headers } : {}) },
    );
  }

  /**
   * Store a file OWNED BY an existing local user
   * (`POST /assets/service/user-media`, the staff-granted scope
   * `files:user-media:write`) — e.g. a person's media stored by your backend
   * acting for them. Image, video or audio (SVG is sanitized), at most 40 MiB.
   * `visibility` defaults to `public`; a `private` file never reaches the CDN
   * and only its person — and this application, which stored it for them —
   * can read it ({@link linkedDownloadUrls}, {@link streams}), until the
   * person revokes this application's access. Rows are per owner: bytes that
   * user already holds return their existing file.
   */
  async uploadUserMedia(
    ownerUserId: string,
    bytes: ServiceUploadBody,
    mime: string,
    options: ServiceUploadDescription & { visibility?: FileVisibility } = {},
  ): Promise<ServiceUserMediaFile> {
    const res = await lane(this.ctx).request<{ file: ServiceUserMediaFile }>(
      'POST',
      '/assets/service/user-media',
      bytes,
      {
        headers: {
          ...uploadHeaders(mime, options),
          ...(options.visibility ? { 'x-visibility': options.visibility } : {}),
          'x-owner-user-id': ownerUserId,
        },
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

  /**
   * Where an agent is reachable from (ADR 0044): `{ anywhere: true }`, or
   * `{ anywhere: false, applicationIds }` for an agent its application confines
   * to its own surfaces — reachable only when the request's verified app
   * assertion (`verifyAppAssertion`, ADR 0045) names a listed application.
   * Coordinator lane (`capabilities:read` + `agency:coordinate`). FAIL CLOSED:
   * anything but a 200 carrying a valid answer throws, so an outage never reads
   * as "anywhere".
   */
  async agentAvailability(
    agentAccountId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentAvailability> {
    if (!agentAccountId || agentAccountId.length > 255 || /\s/.test(agentAccountId))
      throw new Error('An agent account id is required');
    const answer = await lane(this.ctx).request<unknown>(
      'GET',
      `/capabilities/agent-availability/${encodeURIComponent(agentAccountId)}`,
      undefined,
      agencyAuthorityOptions(options.signal),
    );
    const availability = agentAvailabilitySchema.safeParse(answer);
    if (!availability.success) throw new Error('Invalid agent availability');
    return availability.data;
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

  async createTask(
    input: FirstPartyTaskInput,
    options: { requesterToken: string; signal?: AbortSignal },
  ): Promise<FirstPartyTask> {
    if (
      !options.requesterToken ||
      options.requesterToken.length > 16_384 ||
      /\s/.test(options.requesterToken)
    )
      throw new Error('A requester bearer is required');
    const result = await lane(this.ctx).request<{ task: FirstPartyTask }>(
      'POST',
      '/capabilities/tasks',
      { ...firstPartyTaskInputSchema.parse(input), subjectToken: options.requesterToken },
      agencyAuthorityOptions(options.signal),
    );
    return result.task;
  }

  async createTaskExecutionAuthorization(
    taskId: string,
    input: FirstPartyExecutionAuthorizationInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CapabilityExecutionAuthorization> {
    if (!taskId || taskId.length > 128 || /\s/.test(taskId))
      throw new Error('A task id is required');
    const result = await lane(this.ctx).request<{
      authorization: CapabilityExecutionAuthorization;
    }>(
      'POST',
      `/capabilities/tasks/${encodeURIComponent(taskId)}/execution-authorizations`,
      firstPartyExecutionAuthorizationInputSchema.parse(input),
      agencyAuthorityOptions(options.signal),
    );
    return result.authorization;
  }

  async revokeTask(taskId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!taskId || taskId.length > 128 || /\s/.test(taskId))
      throw new Error('A task id is required');
    await lane(this.ctx).request<void>(
      'DELETE',
      `/capabilities/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      agencyAuthorityOptions(options.signal),
    );
  }

  /** Independent service proof plus present requester bearer, sent only to Oxy. */
  async createForegroundExecutionAuthorization(
    input: ForegroundExecutionAuthorizationInput | FirstPartyExecutionAuthorizationInput,
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
        ...('authority' in input
          ? firstPartyExecutionAuthorizationInputSchema
          : foregroundExecutionAuthorizationInputSchema
        ).parse(input),
        subjectToken: options.requesterToken,
      },
      agencyAuthorityOptions(options.signal),
    );
    return result.authorization;
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

/** Whether a commit answer is the 202 of a commit Oxy still runs. */
function isCommitting(answer: unknown): answer is { status: 'committing' } {
  return (
    typeof answer === 'object' &&
    answer !== null &&
    (answer as Record<string, unknown>).status === 'committing'
  );
}

/** `GET /assets/service/references/reconcile/:sessionId`. */
interface ReconcileSessionAnswer {
  sessionId: string;
  entityType: string;
  status: 'open' | 'committing' | 'committed' | 'abandoned';
  result: Omit<ServiceReferenceReconcileResult, 'sessionId' | 'entityType'> | null;
  error: { code: string; message: string } | null;
}

/**
 * Poll a commit Oxy runs in the background until it settles: `committed` (or
 * `open` with a dry run's counts) resolves to the counts; a failed commit
 * rejects with its code (`RECONCILIATION_COMMIT_FAILED`); waiting past
 * {@link SERVICE_RECONCILE_COMMIT_WAIT_MS} rejects with
 * `RECONCILIATION_WAIT_TIMEOUT` — Oxy finishes the commit regardless.
 */
/**
 * Send a reconciliation request, waiting out Oxy's refusals (429): up to
 * {@link SERVICE_RECONCILE_RATE_LIMIT_RETRIES} of them, each for the
 * `retryAfterSeconds` Oxy names (its `Retry-After`), else a doubling fallback,
 * never longer than {@link SERVICE_RECONCILE_RATE_LIMIT_MAX_WAIT_MS}. Any
 * other failure, and the refusal past the last, is thrown as it came.
 */
async function waitingOutRateLimits<T>(send: () => Promise<T>): Promise<T> {
  for (let refusals = 0; ; refusals += 1) {
    try {
      return await send();
    } catch (error: unknown) {
      if (extractErrorStatus(error) !== 429 || refusals >= SERVICE_RECONCILE_RATE_LIMIT_RETRIES) {
        throw error;
      }
      await sleep(rateLimitWaitMs(error, refusals));
    }
  }
}

/** How long to wait after a refusal: what Oxy said, else the doubling fallback; capped. */
function rateLimitWaitMs(error: unknown, refusals: number): number {
  const said = retryAfterSeconds(error);
  const wait =
    said !== undefined ? said * 1000 : SERVICE_RECONCILE_RATE_LIMIT_FALLBACK_MS * 2 ** refusals;
  return Math.min(wait, SERVICE_RECONCILE_RATE_LIMIT_MAX_WAIT_MS);
}

/** `details.retryAfterSeconds` of a refusal (`RateLimitedError` on the server), if any. */
function retryAfterSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidates = [
    (error as { details?: { retryAfterSeconds?: unknown } }).details,
    (error as { response?: { data?: { details?: { retryAfterSeconds?: unknown } } } }).response
      ?.data?.details,
  ];
  for (const details of candidates) {
    const seconds = details?.retryAfterSeconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return undefined;
}

async function waitForCommit(
  service: ServiceLane,
  path: string,
  sessionId: string,
): Promise<ServiceReferenceReconcileResult> {
  const deadline = Date.now() + SERVICE_RECONCILE_COMMIT_WAIT_MS;
  let interval = ASSET_JOB_POLL_INITIAL_MS;
  for (;;) {
    if (Date.now() + interval > deadline) {
      throw new OxyApiError('Oxy is still committing the reconciliation', {
        status: 0,
        code: 'RECONCILIATION_WAIT_TIMEOUT',
        details: { sessionId },
        timeout: true,
      });
    }
    await sleep(interval);
    interval = nextPollInterval(interval);
    const state = await waitingOutRateLimits(() =>
      service.request<ReconcileSessionAnswer>('GET', path, undefined, { cache: false }),
    );
    if (state.status === 'committing') continue;
    if (state.error) {
      throw new OxyApiError(state.error.message, {
        status: 500,
        code: state.error.code,
        details: { sessionId },
      });
    }
    if (state.result) {
      return { sessionId: state.sessionId, entityType: state.entityType, ...state.result };
    }
    throw new OxyApiError(`The reconciliation ended ${state.status} without a result`, {
      status: 409,
      code: 'RECONCILIATION_NOT_OPEN',
      details: { sessionId },
    });
  }
}
