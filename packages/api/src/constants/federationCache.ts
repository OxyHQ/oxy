/**
 * Federation media-cache constants.
 *
 * These pin down a single, reserved namespace for assets created via the
 * service-token cache endpoints (`POST /assets/service/cache`,
 * `DELETE /assets/service/cache/:id`). Backend services (e.g. the Mention
 * backend, which holds an Oxy service token via `OxyServer`) use
 * those endpoints to cache federated/remote media to Oxy S3.
 *
 * Scoping rationale: a leaked or abused service token must NEVER be able to
 * read or delete user-owned media. Every asset created through the cache path
 * is forced onto the `__federation_media_cache__` system owner
 * (`files.system_owner`, one of `FILE_SYSTEM_OWNERS`) AND tagged with
 * {@link FEDERATION_MEDIA_CACHE_PURPOSE}. The delete endpoint re-loads the asset
 * and rejects anything that is not in this namespace, so the blast radius of the
 * service token is bounded to cache objects only.
 *
 * The owner id used to live here as `FEDERATION_CACHE_OWNER_ID`, a sentinel
 * STRING written into the same column that holds real user ids. It is now a
 * value of its own `system_owner` column, declared once in `schema/files.ts`.
 * Its doc comment claimed the sentinel was safe "because the media-privacy block
 * checks short-circuit it" — that short-circuit was the fail-open guard in
 * `mediaPrivacyService`, which skipped block and restrict enforcement for ANY id
 * that was not 24-hex, not just this one. Both are gone.
 */

/**
 * `purpose` tag stamped onto every File created via the cache path. The delete
 * endpoint requires this value before it will touch an asset.
 */
export const FEDERATION_MEDIA_CACHE_PURPOSE = 'federation-media-cache';

/**
 * Maximum size (bytes) accepted by the cache upload endpoint. 256 MiB leaves
 * head-room for federated video while still bounding S3 write cost and the
 * work an abused token could trigger.
 */
export const FEDERATION_CACHE_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Maximum size (bytes) for service-token user-media uploads (MCP / compose
 * intent-media). Tighter than the federation cache cap because Mention buffers
 * the body in memory before streaming to Oxy.
 */
export const USER_MEDIA_MAX_BYTES = 40 * 1024 * 1024;

/**
 * Content-type prefixes the cache endpoint will accept. Federated media is
 * always image / video / audio; anything else (documents, archives,
 * executables) is rejected to keep the cache a pure media surface.
 */
export const FEDERATION_CACHE_ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'] as const;

/**
 * Content-type prefixes that are explicitly REJECTED even when they match an
 * allowed prefix: every SVG spelling but `image/svg+xml`. An SVG is an active
 * document (it can embed `<script>`), so it is stored only as the output of
 * `utils/svgSanitizer.ts` — which every upload and import path runs on
 * `image/svg+xml` (ADR 0042 stage 4c) — and never under another spelling.
 */
export const DISALLOWED_CACHE_MIME_PREFIXES = ['image/svg'] as const;

/** The one SVG type accepted — sanitized before it is stored. */
export const SANITIZED_SVG_MIME = 'image/svg+xml';

/**
 * True when `mime` is an SVG content-type (`image/svg+xml`, `image/svg`, …).
 */
export function isSvgMime(mime: string): boolean {
  return DISALLOWED_CACHE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

/**
 * True when `mime` is one of the allowed media families AND not an explicitly
 * disallowed type. `image/svg+xml` is allowed: the upload pipeline sanitizes it
 * before anything is stored; any other SVG spelling is refused.
 */
export function isAllowedCacheMime(mime: string): boolean {
  if (isSvgMime(mime)) {
    return mime === SANITIZED_SVG_MIME;
  }
  return FEDERATION_CACHE_ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}
