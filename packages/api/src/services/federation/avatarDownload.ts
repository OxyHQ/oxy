/**
 * Mirroring a federated account's picture into Oxy Cloud: the download (with
 * per-origin backpressure, conditional requests and re-encoding), the failure
 * classification the repair and retry passes tally, the Instagram Graph
 * fallback picture, and the per-user throttle for background avatar refreshes.
 */

import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { readResponseBody } from '@oxy.so/core/server';
import { getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { externalIdentityActors } from '../../db/schema/externalIdentities';
import { externalIdentityInstagramPins } from '../../db/schema/externalIdentityMetaProofs';
import { AssetService } from '../assetService';
import { s3Service } from '../s3ServiceSingleton';
import { logger } from '../../utils/logger';
import { isAvatarFileId } from '../../utils/federatedAvatar';
import { normalizeAvatarImage } from './avatarImage';
import { avatarSeedColor } from './avatarColor';
import {
  acquireAvatarOriginLease,
  clearAvatarOriginFailures,
  recordAvatarOriginRateLimit,
} from './avatarFetchBackpressure';
import {
  fetchInstagramGraphProfile,
  INSTAGRAM_NETWORK_DOMAIN,
  instagramUsernameFromAcct,
  isInstagramGraphConfigured,
} from './instagramGraph';
import { safeFederationFetch, USER_AGENT } from './transport';

/**
 * Minimum gap between forced avatar re-downloads for the same user. Even when a
 * caller passes `refresh: true` to PUT /users/resolve, we skip re-downloading
 * the avatar if it was fetched within this window. The persisted
 * `federation.lastAvatarFetchedAt` is the authority across restarts; the
 * in-memory {@link _lastAvatarAttemptAt} map coalesces bursts within a process.
 * 5 minutes matches the actor refresh interval (`refreshThrottle`) — a single
 * avatar can't meaningfully change faster than the actor record it belongs to.
 */
export const AVATAR_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Time-to-first-byte deadline for avatar/media downloads. */
const FEDERATION_AVATAR_FETCH_TIMEOUT_MS = 15_000;
/**
 * Whole-body deadline once an avatar's headers are in. It equals the fetch's
 * deadline, which the fetch's `AbortSignal` already holds from the request's
 * start: an avatar is at most 25 MiB, and the avatars peers serve are KBs to a
 * few MB.
 */
const FEDERATION_AVATAR_BODY_TIMEOUT_MS = 15_000;
/** Largest avatar STORED as-is (the historical 5MB limit); larger ones are re-encoded. */
const FEDERATION_MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** Largest avatar DOWNLOADED at all: animated 6–8 MB WebP/GIF avatars are common. */
const FEDERATION_MAX_AVATAR_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Longest a fetch waits for its origin's request gap before it is deferred. */
const AVATAR_ORIGIN_MAX_WAIT_MS = 30_000;

// System user ID for federated avatar ownership
export const FEDERATION_SYSTEM_USER = '__federation__';

/**
 * User ids whose avatar is currently mid-download via
 * `FederationService.scheduleAvatarRefresh`. Prevents two concurrent
 * background avatar downloads for the same user (e.g. a burst of PUT
 * /users/resolve calls).
 */
const _avatarRefreshInFlight = new Set<string>();

/**
 * Last time an avatar download was *attempted* for a given user id, used with
 * {@link AVATAR_REFRESH_MIN_INTERVAL_MS} to coalesce in-process bursts. The
 * persisted `federation.lastAvatarFetchedAt` remains the cross-restart authority.
 */
const _lastAvatarAttemptAt = new Map<string, number>();

/**
 * Take the background avatar-download slot for `userId`: false while one is in
 * flight or one was attempted within {@link AVATAR_REFRESH_MIN_INTERVAL_MS}.
 * The caller releases it with {@link releaseAvatarRefreshSlot} when its job settles.
 */
export function claimAvatarRefreshSlot(userId: string): boolean {
  if (_avatarRefreshInFlight.has(userId)) return false;

  const lastAttempt = _lastAvatarAttemptAt.get(userId);
  if (lastAttempt !== undefined && Date.now() - lastAttempt < AVATAR_REFRESH_MIN_INTERVAL_MS) {
    return false;
  }

  _avatarRefreshInFlight.add(userId);
  _lastAvatarAttemptAt.set(userId, Date.now());
  return true;
}

/** Release the slot {@link claimAvatarRefreshSlot} took. */
export function releaseAvatarRefreshSlot(userId: string): void {
  _avatarRefreshInFlight.delete(userId);
}

let _assetService: AssetService | null = null;

/**
 * The asset service federation uses for stored avatars, on the process's one
 * object store (`s3ServiceSingleton`), created on first use.
 */
export function getAssetService(): AssetService {
  if (!_assetService) {
    _assetService = new AssetService(s3Service);
  }
  return _assetService;
}

/**
 * The stored avatar READ AS A FILE ID, or `undefined` when it is not one.
 *
 * A federated `users.avatar` is an Oxy Cloud file id or NULL. Rows written
 * before the registry stopped seeding the source picture URL (and some older
 * local rows) can still hold a remote URL, which is NOT a file id — and
 * the download path treats this argument as one: it DELETES what it names when a
 * new image replaces it.
 *
 * EXPORTED, and module-level rather than a method, because the readers are not
 * all in this file: `routes/users.ts` reads the column too. A private helper
 * would have left that one deriving the rule by hand, which is exactly how it is
 * written today and exactly the failure this is meant to end.
 */
export function storedAvatarFileId(avatar: string | null | undefined): string | undefined {
  return isAvatarFileId(avatar) ? avatar : undefined;
}

/** Meta's CDN hosts, whose picture URLs are signed and carry their own expiry. */
const META_SIGNED_CDN_HOST = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i;

/**
 * Whether a Meta CDN picture URL is past the expiry it is signed with.
 *
 * Instagram/Facebook CDN URLs carry `oe=<hex unix seconds>`; after that instant
 * the CDN answers 403 (URL signature expired). A bridge that caches a profile
 * keeps serving such a URL long after it died — kilogram served one for
 * ibaillanos@instagram.com with `oe=6869EA02`, i.e. 2025-07-06. Fetching it can
 * only fail, so it is classified as a permanent failure without a request.
 */
export function isExpiredSignedAvatarUrl(url: string, now: number = Date.now()): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!META_SIGNED_CDN_HOST.test(parsed.hostname)) return false;
  const oe = parsed.searchParams.get('oe');
  if (!oe || !/^[0-9a-f]{1,12}$/i.test(oe)) return false;
  return Number.parseInt(oe, 16) * 1000 <= now;
}

/**
 * Why a mirror attempt produced no file. `permanent`: this URL will not yield an
 * image however often it is retried (4xx, expired signature, not an image, over
 * the cap). `transient`: worth retrying later (transport, 5xx, 429, backpressure).
 */
export type AvatarMirrorFailure = 'transient' | 'permanent';

/** Why a mirror produced no file — tallied by the repair and retry passes. */
export type AvatarFailureReason =
  | 'not_https'
  | 'expired_signature'
  | 'origin_cooldown'
  | 'transport'
  | 'rate_limited'
  | 'http_4xx'
  | 'http_5xx'
  | 'not_modified_without_file'
  | 'too_large'
  | 'empty_body'
  | 'not_an_image'
  | 'undecodable'
  | 'upload_failed'
  | 'unexpected'
  | 'source_unavailable'
  | 'graph_refused';

export interface AvatarDownloadResult {
  fileId: string | null;
  etag?: string;
  lastModified?: string;
  notModified: boolean;
  failure?: AvatarMirrorFailure;
  reason?: AvatarFailureReason;
  httpStatus?: number;
  /** Which picture was mirrored when the result carries a new file id. */
  source?: 'remote' | 'instagram_graph';
  /** The mirrored picture's seed colour (`#rrggbb`), when it has one. */
  color?: string;
}

function avatarFailure(
  failure: AvatarMirrorFailure,
  reason: AvatarFailureReason,
  httpStatus?: number,
): AvatarDownloadResult {
  return {
    fileId: null,
    notModified: false,
    failure,
    reason,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function storedAvatarExists(fileId: unknown): Promise<boolean> {
  const stored = storedAvatarFileId(typeof fileId === 'string' ? fileId : undefined);
  if (stored === undefined) {
    return false;
  }

  try {
    return await getAssetService().fileContentExists(stored);
  } catch (err) {
    logger.warn(
      `Failed checking stored federated avatar ${fileId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Download a remote avatar image, upload it to Oxy Cloud, and return the file
 * ID along with the validators the host advertised.
 *
 * Conditional requests: when `conditional.etag` / `conditional.lastModified`
 * are supplied (from a previous fetch), they are replayed as `If-None-Match` /
 * `If-Modified-Since`. A `304 Not Modified` response means the stored file is
 * still current — we skip the download+upload round-trip entirely and signal
 * `notModified: true` so the caller can still advance its throttle clock.
 *
 * If the user already has an avatar file, the old one is deleted before the
 * new upload (only when we actually downloaded a new image).
 *
 * @param avatarUrl              - Remote avatar URL to fetch.
 * @param existingAvatarFileId   - Current stored file id (deleted on replace).
 * @param conditional            - Stored validators to replay as conditional headers.
 */
export async function fetchAndStoreAvatar(
  avatarUrl: string,
  existingAvatarFileId?: string,
  conditional?: { etag?: string; lastModified?: string },
  ownerUserId = FEDERATION_SYSTEM_USER,
): Promise<AvatarDownloadResult> {
  if (!avatarUrl.startsWith('https://')) {
    // safeFederationFetch refuses anything else; no retry changes the scheme.
    logger.warn('Federated avatar skipped: not an https URL');
    return avatarFailure('permanent', 'not_https');
  }
  if (isExpiredSignedAvatarUrl(avatarUrl)) {
    logger.warn('Federated avatar skipped: signed CDN URL has expired', {
      origin: new URL(avatarUrl).origin,
    });
    return avatarFailure('permanent', 'expired_signature');
  }
  try {
    // WAIT for the per-origin request gap instead of treating it as a failure:
    // a refused gap used to be reported as a transient failure, and a bulk pass
    // over a shared CDN lost every avatar but one per gap. Only a long cooldown
    // (a recorded 429) defers the fetch.
    const deadline = Date.now() + AVATAR_ORIGIN_MAX_WAIT_MS;
    for (;;) {
      const waitMs = await acquireAvatarOriginLease(avatarUrl);
      if (waitMs <= 0) break;
      if (waitMs > AVATAR_ORIGIN_MAX_WAIT_MS || Date.now() + waitMs > deadline) {
        logger.info('Federated avatar fetch deferred by origin backpressure', {
          origin: new URL(avatarUrl).origin,
          retryAfterMs: waitMs,
        });
        return avatarFailure('transient', 'origin_cooldown');
      }
      await sleep(waitMs + Math.floor(Math.random() * 250));
    }

    return await downloadAndStoreAvatarWithLease(
      avatarUrl,
      existingAvatarFileId,
      conditional,
      ownerUserId,
    );
  } catch (err) {
    logger.warn(`Failed to download/store federated avatar: ${err}`);
    return avatarFailure('transient', 'unexpected');
  }
}

async function downloadAndStoreAvatarWithLease(
  avatarUrl: string,
  existingAvatarFileId?: string,
  conditional?: { etag?: string; lastModified?: string },
  ownerUserId = FEDERATION_SYSTEM_USER,
): Promise<AvatarDownloadResult> {
  try {
    const requestHeaders: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'image/*,*/*;q=0.8',
    };
    if (conditional?.etag) {
      requestHeaders['If-None-Match'] = conditional.etag;
    }
    if (conditional?.lastModified) {
      requestHeaders['If-Modified-Since'] = conditional.lastModified;
    }

    const res = await safeFederationFetch(avatarUrl, {
      headers: requestHeaders,
      timeoutMs: FEDERATION_AVATAR_FETCH_TIMEOUT_MS,
    });
    if (!res) {
      return avatarFailure('transient', 'transport');
    }

    const headerValue = (name: string): string | undefined => {
      const value = res.headers[name];
      return Array.isArray(value) ? value[0] : value || undefined;
    };

    if (res.status === 429) {
      res.response.destroy();
      const retryAfterMs = await recordAvatarOriginRateLimit(avatarUrl, headerValue('retry-after'));
      logger.warn('Federated avatar origin rate limited the download', {
        origin: new URL(avatarUrl).origin,
        retryAfterMs,
      });
      return avatarFailure('transient', 'rate_limited', 429);
    }

    // 304: the host confirms the remote bytes are unchanged. This only means
    // our local copy is usable if the referenced asset still exists in S3.
    // If the DB record points to a missing object, retry without validators
    // so the remote sends the body and we can repair the stored file id.
    if (res.status === 304) {
      res.response.destroy();
      await clearAvatarOriginFailures(avatarUrl);
      if (await storedAvatarExists(existingAvatarFileId)) {
        return {
          fileId: null,
          etag: conditional?.etag,
          lastModified: conditional?.lastModified,
          notModified: true,
        };
      }

      logger.warn(
        `Remote avatar returned 304 but stored file is missing for ${avatarUrl}; retrying full download`,
      );
      if (conditional?.etag || conditional?.lastModified) {
        return downloadAndStoreAvatarWithLease(
          avatarUrl,
          existingAvatarFileId,
          undefined,
          ownerUserId,
        );
      }

      return {
        ...avatarFailure('transient', 'not_modified_without_file', 304),
        etag: conditional?.etag,
        lastModified: conditional?.lastModified,
      };
    }

    if (res.status < 200 || res.status >= 300) {
      res.response.destroy();
      logger.warn(`Avatar download failed: HTTP ${res.status} for ${avatarUrl}`);
      // A 4xx (403 for an expired signature, 404/410 for a replaced picture)
      // answers the same next time; 408, 5xx and anything else may not.
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408;
      return avatarFailure(
        permanent ? 'permanent' : 'transient',
        permanent ? 'http_4xx' : 'http_5xx',
        res.status,
      );
    }

    await clearAvatarOriginFailures(avatarUrl);

    const etag = headerValue('etag');
    const lastModified = headerValue('last-modified');
    const declaredType = (headerValue('content-type') || '').split(';')[0].trim().toLowerCase();

    // The Content-Type is NOT a gate: hosts serve real pictures as
    // `text/plain`, `binary/octet-stream` or `text/html`. The bytes decide
    // (`normalizeAvatarImage`). The download is bounded by a hard cap well
    // above the stored cap, so an oversized avatar can be re-encoded instead
    // of dropped.
    const advertisedLength = headerValue('content-length');
    if (
      advertisedLength !== undefined &&
      Number(advertisedLength) > FEDERATION_MAX_AVATAR_DOWNLOAD_BYTES
    ) {
      res.response.destroy();
      logger.warn(
        `Avatar download skipped: content-length ${advertisedLength} exceeds cap for ${avatarUrl}`,
      );
      return { ...avatarFailure('permanent', 'too_large'), etag, lastModified };
    }

    const body = await readResponseBody(res.response, {
      maxBytes: FEDERATION_MAX_AVATAR_DOWNLOAD_BYTES,
      timeoutMs: FEDERATION_AVATAR_BODY_TIMEOUT_MS,
    });
    if (body.kind === 'too_large') {
      return { ...avatarFailure('permanent', 'too_large'), etag, lastModified };
    }
    // A body that stalled or broke off says nothing about the picture.
    if (body.kind !== 'ok') {
      return { ...avatarFailure('transient', 'transport'), etag, lastModified };
    }
    const buffer = body.body;
    if (buffer.length === 0) {
      return { ...avatarFailure('transient', 'empty_body'), etag, lastModified };
    }

    const image = await normalizeAvatarImage(buffer, FEDERATION_MAX_AVATAR_BYTES);
    if (!image.ok) {
      logger.warn('Avatar download skipped: bytes are not a usable image', {
        reason: image.reason,
        declaredType: declaredType || 'none',
        origin: new URL(avatarUrl).origin,
      });
      return { ...avatarFailure('permanent', image.reason), etag, lastModified };
    }

    const assetService = getAssetService();

    const extMap: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/avif': 'avif',
    };
    const ext = extMap[image.mime] || 'img';
    const filename = `federated-avatar-${crypto.randomBytes(8).toString('hex')}.${ext}`;

    let file: { id: string };
    try {
      file = await assetService.uploadFileDirect(
        ownerUserId,
        image.buffer,
        image.mime,
        filename,
        'public',
        {
          source: 'federation',
          role: 'avatar',
          remoteUrl: avatarUrl,
          ...(image.reencoded ? { reencoded: true, originalBytes: buffer.length } : {}),
        },
      );
    } catch (err) {
      logger.warn(`Failed to store federated avatar: ${err}`);
      return avatarFailure('transient', 'upload_failed');
    }

    const fileId = file.id;

    // Delete the replaced avatar only after the new durable file is present.
    // If dedupe returned the same file, keep it.
    const priorFileId = storedAvatarFileId(existingAvatarFileId);
    if (priorFileId !== undefined && priorFileId !== fileId) {
      try {
        await assetService.deleteFile(priorFileId, true);
      } catch {
        // Old file may already be gone — not critical
      }
    }

    const color = (await avatarSeedColor(image.buffer)) ?? undefined;
    return { fileId, etag, lastModified, notModified: false, source: 'remote', color };
  } catch (err) {
    logger.warn(`Failed to download/store federated avatar: ${err}`);
    return avatarFailure('transient', 'transport');
  }
}

/**
 * A fresh Business Discovery picture URL for an instagram.com federated user,
 * or null. The Graph account must still be the one the user's handle names:
 * an IG User id already bound to another account, or contradicting the
 * identity's pinned first-party owner, is refused rather than shown.
 */
export async function freshInstagramGraphAvatarUrl(
  userId: string,
  failedUrl: string,
): Promise<string | null> {
  if (!isInstagramGraphConfigured()) return null;
  const [user] = await getDb()
    .select({ username: users.username, domain: users.federationDomain })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user?.domain !== INSTAGRAM_NETWORK_DOMAIN) return null;
  const username = instagramUsernameFromAcct(user.username ?? '');
  if (!username) return null;
  const lookup = await fetchInstagramGraphProfile(username);
  if (!lookup.ok) return null;
  const graphAvatarUrl = lookup.profile.avatarUrl;
  if (!graphAvatarUrl || graphAvatarUrl === failedUrl) return null;
  const acct = lookup.profile.username;
  const [bound] = await getDb()
    .select({ canonicalAcct: externalIdentityActors.canonicalAcct })
    .from(externalIdentityActors)
    .where(eq(externalIdentityActors.actorUri, lookup.profile.actorUri))
    .limit(1);
  const pins = await getDb()
    .select({ instagramGraphId: externalIdentityInstagramPins.instagramGraphId })
    .from(externalIdentityInstagramPins)
    .where(
      and(
        eq(externalIdentityInstagramPins.canonicalAcct, acct),
        eq(externalIdentityInstagramPins.state, 'pinned'),
      ),
    );
  if (
    (bound && bound.canonicalAcct !== acct) ||
    (pins.length > 0 && !pins.some((pin) => pin.instagramGraphId === lookup.igUserId))
  ) {
    logger.warn('Instagram Graph avatar refused', {
      operation: 'instagram_graph_avatar',
      reason: 'graph_id_not_this_account',
      username,
    });
    return null;
  }
  return graphAvatarUrl;
}
