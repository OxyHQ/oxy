/**
 * Tunable constants for the ecosystem link-preview (URL unfurl) service.
 *
 * Every value is overridable via an env var (read at module load) so the ECS
 * task can re-tune timeouts/TTLs/byte-caps without a code change. The defaults
 * are mirrored from the battle-tested Mention implementation this service was
 * ported from.
 */

import { getEnvNumber } from '../../config/env';

/**
 * Resolver version stamped onto every stored preview. Bump when the extractor /
 * provider / re-host logic changes in a way that should force previously stored
 * previews to be re-resolved on their next read (a stored doc whose `version` is
 * below this is treated as stale and refreshed in the background).
 *
 * v2 — the resolver now whitespace-normalizes title/description/siteName (a
 * multi-line `<title>` used to be stored verbatim and rendered with a blank line
 * + indent by clients) and prefers `og:` over the document `<title>` / `<meta
 * name="description">`. Both change stored text, so v1 docs must be re-resolved.
 */
export const LINK_PREVIEW_RESOLVER_VERSION = 2;

/**
 * Age (seconds) after which a stored `resolved` / `empty` preview is considered
 * stale and re-resolved in the background. Link metadata changes rarely; a week
 * balances freshness against re-fetch cost. Default 7 days.
 */
export const LINK_PREVIEW_REFRESH_TTL_SECONDS = getEnvNumber(
  'LINK_PREVIEW_REFRESH_TTL_SECONDS',
  7 * 24 * 60 * 60,
);

/**
 * Redis hot-cache TTL for a serialized preview DTO. Postgres is the durable
 * source of truth; the hot cache only short-circuits the Postgres read on the
 * response path. Default 1 hour.
 */
export const LINK_PREVIEW_HOT_TTL_SECONDS = getEnvNumber('LINK_PREVIEW_HOT_TTL_SECONDS', 60 * 60);

/**
 * Redis negative-marker TTL for a URL that yielded no usable preview or failed
 * to resolve. Kept short so a transiently-unreachable site (or one that later
 * gains OG tags) recovers without operator action. Default 10 minutes.
 */
export const LINK_PREVIEW_NEG_TTL_SECONDS = getEnvNumber('LINK_PREVIEW_NEG_TTL_SECONDS', 10 * 60);

/**
 * Time-to-first-byte deadline for every outbound resolve fetch (remote HTML
 * page, provider oEmbed endpoint, image download). Default 6 s.
 */
export const LINK_PREVIEW_TIMEOUT_MS = getEnvNumber('LINK_PREVIEW_TIMEOUT_MS', 6000);

/**
 * Hard ceiling on bytes read from a remote HTML page during metadata
 * extraction. The streaming read early-terminates at `</head>`, so a normal
 * page reads only a few KB; this bounds the worst case for a page whose head
 * close never arrives. Default 1 MiB.
 */
export const LINK_PREVIEW_HTML_MAX_BYTES = getEnvNumber(
  'LINK_PREVIEW_HTML_MAX_BYTES',
  1024 * 1024,
);

/**
 * Maximum bytes accepted when re-hosting a remote OG / oEmbed image onto Oxy
 * media. An image larger than this is skipped (no image that round; retried on
 * next warm). Default 8 MiB.
 */
export const LINK_PREVIEW_IMAGE_MAX_BYTES = getEnvNumber(
  'LINK_PREVIEW_IMAGE_MAX_BYTES',
  8 * 1024 * 1024,
);

/**
 * Single-flight lock TTL (seconds) held while a URL is being resolved, so two
 * instances/jobs never resolve and re-host the same URL concurrently. Default
 * 30 s — comfortably longer than a bounded resolve. No-op without Redis (the
 * in-process warm queue's pending set provides dedup in that mode).
 */
export const LINK_PREVIEW_LOCK_TTL_SECONDS = getEnvNumber('LINK_PREVIEW_LOCK_TTL_SECONDS', 30);

/**
 * Server-wide ceiling on CONCURRENT synchronous (`wait=1`) resolves. The
 * `wait=1` path runs a bounded resolve inline on the request, bypassing the
 * background warm worker — so without a global cap, distributed callers (many
 * IPs, each within its own per-principal rate limit) could pin an unbounded
 * number of slow server-side resolves + outbound sockets open (DoS
 * amplification). When this ceiling is saturated, a `wait=1` request degrades
 * gracefully: it enqueues a background warm and returns the current best
 * (stale doc or a `pending` placeholder) immediately. Default 8.
 */
export const LINK_PREVIEW_SYNC_MAX_CONCURRENCY = getEnvNumber(
  'LINK_PREVIEW_SYNC_MAX_CONCURRENCY',
  8,
);

/**
 * Hard upper bound on an accepted URL length (DoS guard). Shared by the resolver
 * (single-URL normalize) and the batch path's cheap per-element pre-check, so an
 * oversized element is dropped before any normalize / fetch work.
 */
export const LINK_PREVIEW_MAX_URL_LENGTH = 2048;

/**
 * Number of warm jobs the BullMQ worker processes CONCURRENTLY per instance.
 * BullMQ defaults to 1 (fully serial), which drains a large first-seen / backfill
 * backlog far too slowly (≈1 URL at a time per instance). Each job is bounded
 * (fetch timeouts, SSRF guard, negative cache, `isUsablePreview`) and the oEmbed
 * hosts (YouTube/Vimeo/Spotify) are not anti-bot-walled, while generic-scrape
 * failures degrade gracefully — so a modest fan-out is safe. Default 12,
 * env-tunable.
 */
export const LINK_PREVIEW_WARM_CONCURRENCY = getEnvNumber('LINK_PREVIEW_WARM_CONCURRENCY', 12);

/**
 * Per-principal rate-limit ceiling (requests / 60s window) for the single-URL
 * `GET /links/preview`. Every app calls the read endpoints with ONE shared
 * service token, so an entire app's feed hydration shares a single principal's
 * budget — these must be generous because cached reads are cheap. Default 600,
 * env-tunable.
 */
export const LINK_PREVIEW_PREVIEW_RATE_MAX = getEnvNumber('LINK_PREVIEW_PREVIEW_RATE_MAX', 600);

/**
 * Per-principal rate-limit ceiling (requests / 60s window) for the batch
 * `POST /links/previews` — the feed-hydration path. Same shared-service-token
 * rationale as {@link LINK_PREVIEW_PREVIEW_RATE_MAX}. Default 600, env-tunable.
 */
export const LINK_PREVIEW_BATCH_RATE_MAX = getEnvNumber('LINK_PREVIEW_BATCH_RATE_MAX', 600);

/**
 * The reserved owner of every re-hosted link-preview image is
 * `__link_preview_cache__`, one of `FILE_SYSTEM_OWNERS` in `schema/files.ts`. It
 * used to be declared here as `LINK_PREVIEW_OWNER_ID`, a sentinel string stored
 * in the user-id column; it is now a value of `files.system_owner`, so the
 * namespace is a real column rather than a naming convention.
 */
