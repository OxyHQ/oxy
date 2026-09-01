/**
 * Asset CDN configuration and key-placement rules.
 *
 * Hard contract: NO raw AWS S3 (`*.amazonaws.com`) URL may ever reach a client.
 * Public media is served through Oxy's own CloudFront CDN (`cloud.oxy.so`);
 * private/access-controlled media is streamed through our own origin
 * (`api.oxy.so`). This module owns the single source of truth for:
 *
 *  1. The CDN base URL (`ASSET_CDN_URL`, default `https://cloud.oxy.so`).
 *  2. The S3 key prefix that decides whether an object is reachable by the CDN.
 *  3. The mapping between an S3 storage key and the CDN-relative path.
 *
 * CloudFront wiring (managed in `oxy-infra/terraform-uswest2`): the
 * `cloud.oxy.so` distribution points at the media bucket with
 * `origin_path = /public`. CloudFront PREPENDS that origin path to every
 * request, so a request for `cloud.oxy.so/content/..` fetches the S3 object
 * `public/content/..`. Therefore:
 *
 *   stored S3 key  =  public/content/{y}/{m}/..       (objects under the prefix)
 *   CDN URL path   =  content/{y}/{m}/..              (prefix stripped)
 *   CDN URL        =  https://cloud.oxy.so/content/{y}/{m}/..
 *
 * Only objects physically stored under `PUBLIC_KEY_PREFIX` are reachable via the
 * CDN. Public-visibility assets are written there; private/unlisted assets are
 * NOT, so they can never leak through the public CDN.
 */

import { getEnvVar } from './env';
import type { FileVisibility } from '../db/schema/files';

/**
 * Default CDN origin. Overridable via the `ASSET_CDN_URL` env var (set on the
 * ECS task from SSM). Never hardcode this elsewhere — read it through
 * {@link getAssetCdnUrl} / {@link buildCdnUrl}.
 */
export const DEFAULT_ASSET_CDN_URL = 'https://cloud.oxy.so';

/**
 * S3 key prefix under which all CDN-reachable (public) objects live. Must match
 * the CloudFront distribution's `origin_path` (without the leading slash). The
 * trailing slash makes prefix tests and stripping unambiguous.
 */
export const PUBLIC_KEY_PREFIX = 'public/';

/**
 * Cache lifetime (seconds) for a public-asset CDN redirect (the `302` emitted by
 * `GET /assets/:id/stream` and `GET /cdn/:id`). The redirect TARGET is
 * content-addressed and stable, so clients/edge caches may safely reuse the 302
 * rather than re-running the S3 existence probe on every request.
 */
export const CDN_REDIRECT_MAX_AGE_SECONDS = 3600;

/**
 * Resolve the configured CDN base URL with no trailing slash.
 *
 * Read at call time (not module-load) so tests and one-shot scripts that set
 * `process.env.ASSET_CDN_URL` after import still observe the override.
 */
export function getAssetCdnUrl(): string {
  const raw = getEnvVar('ASSET_CDN_URL', DEFAULT_ASSET_CDN_URL).trim() || DEFAULT_ASSET_CDN_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Whether a stored S3 key lives under the public (CDN-reachable) prefix.
 */
export function isPublicKey(storageKey: string): boolean {
  return storageKey.startsWith(PUBLIC_KEY_PREFIX);
}

/**
 * Prepend the public prefix to a content-addressed key, idempotently. Used at
 * write time when an asset's visibility is known to be `public`.
 */
export function applyPublicPrefix(storageKey: string): string {
  return isPublicKey(storageKey) ? storageKey : `${PUBLIC_KEY_PREFIX}${storageKey}`;
}

/**
 * Remove the public prefix from a stored key, yielding the CDN-relative path
 * (the path component CloudFront expects, since `origin_path` re-adds the
 * prefix). Idempotent for keys that are not prefixed.
 */
export function stripPublicPrefix(storageKey: string): string {
  return isPublicKey(storageKey) ? storageKey.slice(PUBLIC_KEY_PREFIX.length) : storageKey;
}

/**
 * Decide the storage-key prefix for a NEW object from its visibility. Public
 * objects are placed under {@link PUBLIC_KEY_PREFIX} so CloudFront can serve
 * them; everything else stays private to S3 and is only reachable through the
 * access-gated origin stream route.
 *
 * This is the single, explicit public-vs-private placement decision. Do not
 * scatter prefix concatenation elsewhere — call this when generating keys.
 */
export function storageKeyForVisibility(baseKey: string, visibility: FileVisibility): string {
  return visibility === 'public' ? applyPublicPrefix(baseKey) : baseKey;
}

/**
 * Build a fully-qualified CDN URL from a CDN-relative key (a key with the
 * public prefix already stripped). Tolerates leading slashes on the input and
 * never produces double slashes.
 */
export function buildCdnUrl(cdnRelativeKey: string): string {
  const normalizedKey = cdnRelativeKey.replace(/^\/+/, '');
  return `${getAssetCdnUrl()}/${normalizedKey}`;
}

/**
 * Build the CDN URL for an object given its raw stored S3 key. The key MUST be
 * under the public prefix (callers verify the object's visibility/placement
 * first); the prefix is stripped to form the CloudFront path.
 */
export function cdnUrlForStorageKey(storageKey: string): string {
  return buildCdnUrl(stripPublicPrefix(storageKey));
}
