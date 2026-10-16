/**
 * Import by URL (ADR 0042 D7): Oxy fetches a source once, stores it through
 * the ordinary upload pipeline, and remembers where it came from.
 *
 * ## The fetch
 *
 * `safeFetch` (`@oxy.so/core/server`) for every hop: the host is resolved once
 * and the connection pinned to an address checked against the private,
 * loopback, link-local and metadata ranges, so neither a DNS answer nor a
 * redirect can reach inside. On top of it this module requires `https` on
 * EVERY hop (safeFetch alone would follow a redirect to plain http), follows at
 * most {@link IMPORT_MAX_REDIRECTS}, sends no credentials or cookies (a URL
 * carrying `user:pass@` is refused), asks for identity encoding, and bounds
 * time (headers {@link IMPORT_HEADERS_TIMEOUT_MS}, whole transfer
 * {@link IMPORT_TOTAL_TIMEOUT_MS}) and bytes (the upload pipeline's own cap,
 * {@link USER_MEDIA_MAX_BYTES}). The type policy is the upload's: an image or
 * video type `isAllowedCacheMime` admits.
 *
 * ## Once
 *
 * `file_sources` keys (owner, SHA-256 of the normalized URL). A repeat import
 * of the same URL by the same owner answers the existing ACTIVE file without
 * any request (`existing`). `revalidate: true` sends a conditional GET with the
 * stored `ETag` / `Last-Modified`: a 304 answers the same file
 * (`not_modified`); new bytes are stored as a file of their own (deduplicated
 * by content hash per owner, like any upload) and the source row moves to it
 * (`downloaded`). The previous file loses nothing: its references decide.
 * A source whose file was trashed or deleted is downloaded again.
 *
 * ## A reference in the same request
 *
 * `reference` registers the calling application's use of the imported file
 * right after it is stored, under the same rule as `POST
 * /assets/service/references` (`mayApplicationReference`), so a caller that
 * crashes after the import never leaves an unused application file behind.
 */

import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { safeFetch, SsrfRejection, UpstreamError } from '@oxy.so/core/server';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { USER_MEDIA_MAX_BYTES, isAllowedCacheMime } from '../constants/federationCache';
import { fileSources, type FileSourceRow } from '../db/schema/fileSources';
import { files } from '../db/schema/files';
import type { FileRecord, FileVisibility } from '../types/file.types';
import { ApiError } from '../utils/error';
import { logger } from '../utils/logger';
import { openSecret, sealSecret } from '../utils/secretBox';
import type { AssetService } from './assetService';
import { mayApplicationReference } from './fileReference.service';

export const IMPORT_MAX_REDIRECTS = 5;
export const IMPORT_HEADERS_TIMEOUT_MS = 15_000;
export const IMPORT_TOTAL_TIMEOUT_MS = 60_000;
const MAX_SOURCE_URL_LENGTH = 2048;
const IMPORT_USER_AGENT = 'OxyFiles-Import/1.0 (+https://oxy.so)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Who the imported file belongs to. */
export type ImportOwner =
  | { kind: 'application'; applicationId: string }
  | { kind: 'account'; userId: string };

export interface ImportRequest {
  sourceUrl: string;
  visibility: FileVisibility;
  /** Ask the source again (conditionally) even when this owner already imported the URL. */
  revalidate?: boolean;
  /** Register the calling application's use of the file in the same request. */
  reference?: { entityType: string; entityId: string };
}

/**
 * - `downloaded`: bytes were fetched (a first import, a changed source, or a
 *   source whose file was no longer active). `deduplicated` says whether the
 *   owner already held those bytes.
 * - `existing`: this owner imported this URL before; nothing was fetched.
 * - `not_modified`: revalidated; the source answered 304.
 */
export type ImportOutcome = 'downloaded' | 'existing' | 'not_modified';

export interface ImportResult {
  file: FileRecord;
  outcome: ImportOutcome;
  deduplicated: boolean;
  source: {
    host: string;
    fetchedAt: Date;
    etag: string | null;
    lastModified: string | null;
  };
  /** Present when the request asked for a reference. */
  reference?: 'created' | 'exists' | 'not_found';
}

/** A normalized, accepted source URL and its key. */
export interface NormalizedSourceUrl {
  url: string;
  host: string;
  sha256: string;
}

/**
 * Parse and normalize a source URL, refusing what can never be imported:
 * anything but `https`, embedded credentials, an over-long URL. The fragment is
 * dropped — it is never sent — so `…/a.png#x` and `…/a.png` are one source.
 */
export function normalizeSourceUrl(raw: string): NormalizedSourceUrl {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SOURCE_URL_LENGTH) {
    throw new ApiError(400, 'sourceUrl must be an https URL', 'INVALID_SOURCE_URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ApiError(400, 'sourceUrl must be an https URL', 'INVALID_SOURCE_URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new ApiError(400, 'sourceUrl must be an https URL', 'INVALID_SOURCE_URL');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ApiError(400, 'sourceUrl must not carry credentials', 'INVALID_SOURCE_URL');
  }
  parsed.hash = '';
  const url = parsed.toString();
  return {
    url,
    host: parsed.host.toLowerCase(),
    sha256: crypto.createHash('sha256').update(url).digest('hex'),
  };
}

function ownerKey(owner: ImportOwner): string {
  return owner.kind === 'application' ? `app:${owner.applicationId}` : `user:${owner.userId}`;
}

function sourceContext(owner: ImportOwner, sha256: string): string {
  return `file-source|${ownerKey(owner)}|${sha256}`;
}

/** The sealed source URL of a row, for its owner only. */
export function openSourceUrl(owner: ImportOwner, row: FileSourceRow): string {
  return openSecret(row.sourceUrlCiphertext, sourceContext(owner, row.sourceUrlSha256));
}

function ownerColumns(owner: ImportOwner) {
  return owner.kind === 'application'
    ? { ownerUserId: null, ownerApplicationId: owner.applicationId }
    : { ownerUserId: owner.userId, ownerApplicationId: null };
}

function ownerPredicate(owner: ImportOwner) {
  return owner.kind === 'application'
    ? eq(fileSources.ownerApplicationId, owner.applicationId)
    : eq(fileSources.ownerUserId, owner.userId);
}

function header(response: IncomingMessage, name: string): string | null {
  const value = response.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && single.length > 0 ? single : null;
}

/** The last path segment, as a file name; the server names it otherwise. */
function nameFromUrl(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1);
    if (!segment) return 'imported-file';
    const decoded = decodeURIComponent(segment).trim();
    return decoded.length > 0 ? decoded.slice(0, 255) : 'imported-file';
  } catch {
    return 'imported-file';
  }
}

type FetchedSource =
  | { kind: 'not_modified' }
  | {
      kind: 'body';
      response: IncomingMessage;
      status: number;
      mime: string;
      etag: string | null;
      lastModified: string | null;
      finalUrl: string;
    };

/**
 * GET the source, hop by hop, each through `safeFetch` and each `https`.
 * `conditional` adds `If-None-Match` / `If-Modified-Since`. The caller owns the
 * returned response stream.
 */
async function fetchSource(
  url: string,
  signal: AbortSignal,
  conditional?: { etag: string | null; lastModified: string | null },
): Promise<FetchedSource> {
  const headers: Record<string, string> = {
    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,video/*;q=0.7',
    'Accept-Encoding': 'identity',
    'User-Agent': IMPORT_USER_AGENT,
  };
  if (conditional?.etag) headers['If-None-Match'] = conditional.etag;
  if (conditional?.lastModified) headers['If-Modified-Since'] = conditional.lastModified;

  let current = url;
  for (let hop = 0; hop <= IMPORT_MAX_REDIRECTS; hop++) {
    if (new URL(current).protocol !== 'https:') {
      throw new ApiError(422, 'The source redirected to a non-https URL', 'SOURCE_URL_REFUSED');
    }
    let result: Awaited<ReturnType<typeof safeFetch>>;
    try {
      result = await safeFetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        headersTimeoutMs: IMPORT_HEADERS_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if (error instanceof SsrfRejection) {
        throw new ApiError(
          422,
          'The source URL does not resolve to a public address Oxy may fetch',
          'SOURCE_URL_REFUSED',
        );
      }
      if (signal.aborted || (error instanceof UpstreamError && /timeout/i.test(error.message))) {
        throw new ApiError(504, 'The source did not answer in time', 'SOURCE_FETCH_TIMEOUT');
      }
      throw new ApiError(502, 'The source could not be fetched', 'SOURCE_FETCH_FAILED');
    }

    const { response, status } = result;
    if (REDIRECT_STATUSES.has(status)) {
      const location = header(response, 'location');
      response.destroy();
      if (!location) {
        throw new ApiError(502, 'The source redirected without a location', 'SOURCE_FETCH_FAILED');
      }
      current = new URL(location, current).toString();
      continue;
    }
    if (status === 304 && conditional) {
      response.destroy();
      return { kind: 'not_modified' };
    }
    if (status < 200 || status >= 300) {
      response.destroy();
      throw new ApiError(502, `The source answered HTTP ${status}`, 'SOURCE_FETCH_FAILED', {
        sourceStatus: status,
      });
    }
    const encoding = header(response, 'content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      response.destroy();
      throw new ApiError(502, 'The source sent an encoded body', 'SOURCE_FETCH_FAILED');
    }
    const mime = (header(response, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!(mime.startsWith('image/') || mime.startsWith('video/')) || !isAllowedCacheMime(mime)) {
      response.destroy();
      throw new ApiError(
        415,
        'The source is not a supported image or video',
        'UNSUPPORTED_MEDIA_TYPE',
      );
    }
    const declared = Number(header(response, 'content-length'));
    if (Number.isFinite(declared) && declared > USER_MEDIA_MAX_BYTES) {
      response.destroy();
      throw new ApiError(413, 'The source exceeds the maximum file size', 'PAYLOAD_TOO_LARGE');
    }
    return {
      kind: 'body',
      response,
      status,
      mime,
      etag: header(response, 'etag'),
      lastModified: header(response, 'last-modified'),
      finalUrl: current,
    };
  }
  throw new ApiError(502, 'The source redirected too many times', 'SOURCE_FETCH_FAILED');
}

/** The upload pipeline's refusals, said as an import's. */
function importUploadError(error: unknown, owner: ImportOwner, signal: AbortSignal): unknown {
  if (
    error instanceof Error &&
    (error.name === 'CacheMediaTooLargeError' ||
      (error instanceof ApiError && error.code === 'STORAGE_STREAM_TOO_LARGE'))
  ) {
    return new ApiError(413, 'The source exceeds the maximum file size', 'PAYLOAD_TOO_LARGE');
  }
  if (error instanceof ApiError && error.code === 'STORAGE_QUOTA_EXCEEDED') {
    return owner.kind === 'application'
      ? new ApiError(
          413,
          "This application's files count toward its developer account's storage plan, which is full. Existing files are still served.",
          'STORAGE_QUOTA_EXCEEDED',
        )
      : error;
  }
  if (error instanceof ApiError) return error;
  if (signal.aborted) {
    return new ApiError(504, 'The source did not finish in time', 'SOURCE_FETCH_TIMEOUT');
  }
  return new ApiError(502, 'The source could not be read', 'SOURCE_FETCH_FAILED');
}

export class FileImportService {
  constructor(private readonly assets: AssetService) {}

  /**
   * Import `request.sourceUrl` for `owner` (see the module header).
   * `referencingApplicationId` is the calling application — the one a
   * `reference` is registered for.
   */
  async importFromUrl(
    owner: ImportOwner,
    request: ImportRequest,
    referencingApplicationId: string,
  ): Promise<ImportResult> {
    const source = normalizeSourceUrl(request.sourceUrl);
    const db = getDb();

    const [known] = await db
      .select({ row: fileSources, fileStatus: files.status })
      .from(fileSources)
      .innerJoin(files, eq(files.id, fileSources.fileId))
      .where(and(ownerPredicate(owner), eq(fileSources.sourceUrlSha256, source.sha256)))
      .limit(1);

    const reusable = known?.fileStatus === 'active' ? known.row : undefined;
    let result: Omit<ImportResult, 'reference'>;

    if (reusable && !request.revalidate) {
      const file = await this.assets.getFile(reusable.fileId);
      if (!file) throw new ApiError(409, 'The imported file changed; retry', 'IMPORT_RACED');
      result = {
        file,
        outcome: 'existing',
        deduplicated: true,
        source: {
          host: reusable.sourceHost,
          fetchedAt: reusable.fetchedAt,
          etag: reusable.etag,
          lastModified: reusable.lastModified,
        },
      };
    } else {
      result = await this.download(owner, source, request, reusable);
    }

    const reference = request.reference
      ? await this.addReference(result.file, request.reference, referencingApplicationId)
      : undefined;
    if (reference && result.file.id) {
      const refreshed = await this.assets.getFile(result.file.id);
      if (refreshed) result.file = refreshed;
    }

    logger.info('File imported by URL', {
      owner: ownerKey(owner),
      sourceHost: source.host,
      fileId: result.file.id,
      outcome: result.outcome,
      deduplicated: result.deduplicated,
      reference,
    });
    return reference ? { ...result, reference } : result;
  }

  private async download(
    owner: ImportOwner,
    source: NormalizedSourceUrl,
    request: ImportRequest,
    reusable: FileSourceRow | undefined,
  ): Promise<Omit<ImportResult, 'reference'>> {
    const signal = AbortSignal.timeout(IMPORT_TOTAL_TIMEOUT_MS);
    const fetched = await fetchSource(
      source.url,
      signal,
      reusable ? { etag: reusable.etag, lastModified: reusable.lastModified } : undefined,
    );
    const fetchedAt = new Date();

    if (fetched.kind === 'not_modified' && reusable) {
      const [updated] = await getDb()
        .update(fileSources)
        .set({ fetchedAt, lastStatus: 304 })
        .where(eq(fileSources.id, reusable.id))
        .returning();
      const file = await this.assets.getFile(reusable.fileId);
      if (!file) throw new ApiError(409, 'The imported file changed; retry', 'IMPORT_RACED');
      return {
        file,
        outcome: 'not_modified',
        deduplicated: true,
        source: {
          host: source.host,
          fetchedAt,
          etag: (updated ?? reusable).etag,
          lastModified: (updated ?? reusable).lastModified,
        },
      };
    }
    if (fetched.kind !== 'body') {
      // A 304 to a request that sent no validators is not a valid answer.
      throw new ApiError(502, 'The source answered HTTP 304', 'SOURCE_FETCH_FAILED');
    }

    const originalName = nameFromUrl(fetched.finalUrl);
    const metadata = { source: 'import', sourceHost: source.host };
    let stored: { file: FileRecord; deduplicated: boolean };
    try {
      stored =
        owner.kind === 'application'
          ? await this.assets.uploadApplicationFileStream(
              fetched.response,
              fetched.mime,
              originalName,
              USER_MEDIA_MAX_BYTES,
              owner.applicationId,
              request.visibility,
              metadata,
            )
          : await this.assets.uploadUserMediaStreamDetailed(
              fetched.response,
              fetched.mime,
              originalName,
              USER_MEDIA_MAX_BYTES,
              owner.userId,
              request.visibility,
              metadata,
            );
    } catch (error) {
      fetched.response.destroy();
      throw importUploadError(error, owner, signal);
    }

    const values = {
      ...ownerColumns(owner),
      sourceUrlSha256: source.sha256,
      sourceHost: source.host,
      sourceUrlCiphertext: sealSecret(source.url, sourceContext(owner, source.sha256)),
      fileId: stored.file.id,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      contentSha256: stored.file.sha256,
      fetchedAt,
      lastStatus: fetched.status,
    };
    const ownerColumn =
      owner.kind === 'application' ? fileSources.ownerApplicationId : fileSources.ownerUserId;
    await getDb()
      .insert(fileSources)
      .values(values)
      .onConflictDoUpdate({
        target: [ownerColumn, fileSources.sourceUrlSha256],
        targetWhere:
          owner.kind === 'application'
            ? sql`${fileSources.ownerApplicationId} is not null`
            : sql`${fileSources.ownerUserId} is not null`,
        set: {
          sourceHost: values.sourceHost,
          sourceUrlCiphertext: values.sourceUrlCiphertext,
          fileId: values.fileId,
          etag: values.etag,
          lastModified: values.lastModified,
          contentSha256: values.contentSha256,
          fetchedAt: values.fetchedAt,
          lastStatus: values.lastStatus,
        },
      });

    return {
      file: stored.file,
      outcome: 'downloaded',
      deduplicated: stored.deduplicated,
      source: {
        host: source.host,
        fetchedAt,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
      },
    };
  }

  /** `POST /assets/service/references`' rule, for one reference, right after the import. */
  private async addReference(
    file: FileRecord,
    reference: { entityType: string; entityId: string },
    applicationId: string,
  ): Promise<'created' | 'exists' | 'not_found'> {
    if (!mayApplicationReference(file, applicationId)) return 'not_found';
    const { created } = await this.assets.linkFile(file.id, {
      applicationId,
      entityType: reference.entityType,
      entityId: reference.entityId,
      createdByUserId: null,
    });
    return created ? 'created' : 'exists';
  }
}
