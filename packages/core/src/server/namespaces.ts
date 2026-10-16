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
  ApplicationFileAdoption,
  AssetLiveStatus,
  ApplicationFileImport,
  ApplicationFileImportBatchResult,
  ApplicationFilePage,
  ApplicationFileUpload,
  FileImportOptions,
  FileVisibility,
  Notification,
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
/** Server-side cap of `POST`/`DELETE /assets/service/references`. */
const SERVICE_REFERENCES_CHUNK_SIZE = 100;
/** Server-side cap of `POST /assets/service/app/import/batch`. */
const SERVICE_IMPORT_BATCH_SIZE = 50;
/** An import fetches a remote source (up to 60 s server-side): a longer per-attempt timeout. */
const SERVICE_IMPORT_TIMEOUT_MS = 90_000;
/** Server-side cap of one `PUT /assets/service/references/reconcile/:sessionId` page. */
const SERVICE_RECONCILE_PAGE_SIZE = 1000;
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
   * The calling application's own uses of files (`file_references`, ADR 0041
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
     * real inventory (ADR 0041 D6) — the safety net for a reference a crash or
     * an old bug never registered, and how existing data first enters the
     * model. `items` is every `{ fileId, entityId }` the application uses for
     * `entityType` (an array or any (async) iterable — stream a large table);
     * it is sent in pages of 1,000 and committed: Oxy adds the missing
     * references it may hold, removes the stale ones created before the
     * reconciliation began (never trashing a file), and returns the counts.
     * `dryRun` returns the counts and changes nothing. One reconciliation per
     * entity type at a time (409 `RECONCILIATION_IN_PROGRESS`); if sending the
     * inventory fails, the session is released before the error is rethrown.
     */
    reconcile: (
      entityType: string,
      items: Iterable<ServiceReferenceInventoryItem> | AsyncIterable<ServiceReferenceInventoryItem>,
      options: { dryRun?: boolean } = {},
    ): Promise<ServiceReferenceReconcileResult> =>
      this.reconcileReferences(entityType, items, options),
  };

  private async reconcileReferences(
    entityType: string,
    items: Iterable<ServiceReferenceInventoryItem> | AsyncIterable<ServiceReferenceInventoryItem>,
    options: { dryRun?: boolean },
  ): Promise<ServiceReferenceReconcileResult> {
    const service = lane(this.ctx);
    const { sessionId } = await service.request<{ sessionId: string }>(
      'POST',
      '/assets/service/references/reconcile',
      { entityType },
      // Not retried: a lost answer to a begin that succeeded would make the
      // retry a 409 against its own session.
      { cache: false, retry: false },
    );
    const path = `/assets/service/references/reconcile/${encodeURIComponent(sessionId)}`;
    try {
      let page: ServiceReferenceInventoryItem[] = [];
      const flush = async () => {
        if (page.length === 0) return;
        const items = page;
        page = [];
        await service.request('PUT', path, { items }, { cache: false });
      };
      for await (const { fileId, entityId } of items) {
        page.push({ fileId, entityId });
        if (page.length === SERVICE_RECONCILE_PAGE_SIZE) await flush();
      }
      await flush();
      return await service.request<ServiceReferenceReconcileResult>(
        'POST',
        `${path}/commit`,
        { dryRun: options.dryRun === true },
        { cache: false, retry: false },
      );
    } catch (error) {
      // Release the slot so the next attempt need not wait for it to expire.
      // Best effort: a commit that failed part-way left it open, and an
      // already-committed or expired session answers 404, which is fine.
      await service.request('DELETE', path, undefined, { cache: false }).catch(() => undefined);
      throw error;
    }
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
   * `files:app:write`, ADR 0041) — content no person owns. The owner is
   * always the calling application. A third-party application's bytes count
   * toward its developer account's storage plan (over it: 413
   * `STORAGE_QUOTA_EXCEEDED`); Oxy's own applications are not metered. Image
   * or video only, at most 40 MiB. Bytes taken down after a content claim are
   * refused for every owner (451 `CONTENT_BLOCKED`, ADR 0041 D10) — here, by
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
   * resumable multipart upload (`/assets/service/app/uploads`, ADR 0041 stage
   * 4b; `files:app:write`, plus `files:references:write` for `reference`).
   * The source is hashed first (8 MiB at a time; pass `sha256` to skip it),
   * then its parts go straight to storage on presigned URLs,
   * `partConcurrency` at a time, each retried — no byte passes through the
   * API — and Oxy hashes the assembled file before it is one: bytes that do
   * not match are refused (422 `CHECKSUM_MISMATCH`). Calling again for the
   * same bytes after a crash RESUMES: only the parts storage lacks are sent.
   * Bytes this application already holds answer at once (`deduplicated`).
   * Refused: executables and active documents such as HTML or SVG (415), more
   * than 8 GiB (413), taken-down bytes (451 `CONTENT_BLOCKED`), a full plan
   * for a third-party application (413 `STORAGE_QUOTA_EXCEEDED`). Non-media
   * types are served as downloads. Renditions are made for images (up to
   * 100 MiB) and videos only.
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
   * account owns the file; public unless `visibility` says otherwise.
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
   * again (`POST /assets/service/app/adopt`, `files:app:write`, ADR 0041 stage
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
   * (`POST /assets/service/app/import`, `files:app:write`, ADR 0041 D7). Oxy
   * fetches `sourceUrl` itself — `https` only, public addresses only, bounded
   * redirects, size and time — and stores it like {@link uploadAppFile}.
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
    const { signal, ...rest } = options;
    return lane(this.ctx).request<ApplicationFileImport>(
      'POST',
      '/assets/service/app/import',
      { sourceUrl, ...rest },
      {
        cache: false,
        retry: false,
        timeout: SERVICE_IMPORT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
    );
  }

  /**
   * Import many files by URL for THIS application
   * (`POST /assets/service/app/import/batch`), 50 per request, in order. Each
   * item answers on its own — `{ ok: true, file, outcome, … }` or
   * `{ ok: false, error: { status, code, message } }` — with `index` into the
   * array given here.
   */
  async importAppFiles(
    items: Array<FileImportOptions & { sourceUrl: string; visibility: FileVisibility }>,
  ): Promise<ApplicationFileImportBatchResult[]> {
    const results: ApplicationFileImportBatchResult[] = [];
    for (let start = 0; start < items.length; start += SERVICE_IMPORT_BATCH_SIZE) {
      const part = items
        .slice(start, start + SERVICE_IMPORT_BATCH_SIZE)
        .map(({ sourceUrl, visibility, reference, revalidate }) => ({
          sourceUrl,
          visibility,
          ...(reference ? { reference } : {}),
          ...(revalidate !== undefined ? { revalidate } : {}),
        }));
      const res = await lane(this.ctx).request<{ results: ApplicationFileImportBatchResult[] }>(
        'POST',
        '/assets/service/app/import/batch',
        { items: part },
        { cache: false, retry: false, timeout: SERVICE_IMPORT_TIMEOUT_MS * 2 },
      );
      results.push(...res.results.map((result) => ({ ...result, index: result.index + start })));
    }
    return results;
  }

  /**
   * Import a file by URL into an existing local user's files
   * (`POST /assets/service/user-media/import`, the staff-granted scope
   * `files:user-media:write`, ADR 0041 D7) — the account-owned twin of
   * {@link importAppFile}, public unless `visibility` says otherwise. The same
   * URL imported again for the same user answers the existing file.
   */
  async importUserMedia(
    ownerUserId: string,
    sourceUrl: string,
    options: FileImportOptions & { visibility?: FileVisibility; signal?: AbortSignal } = {},
  ): Promise<ServiceUserMediaImport> {
    const { signal, ...rest } = options;
    return lane(this.ctx).request<ServiceUserMediaImport>(
      'POST',
      '/assets/service/user-media/import',
      { sourceUrl, ...rest },
      {
        headers: { 'x-owner-user-id': ownerUserId },
        cache: false,
        retry: false,
        timeout: SERVICE_IMPORT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      },
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
