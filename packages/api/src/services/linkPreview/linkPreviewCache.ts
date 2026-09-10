import { createHash } from 'node:crypto';
import { type LinkPreview, linkPreviewSchema } from '@oxy.so/contracts';
import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';
import { hostnameOf } from './url';
import {
  LINK_PREVIEW_HOT_TTL_SECONDS,
  LINK_PREVIEW_LOCK_TTL_SECONDS,
  LINK_PREVIEW_NEG_TTL_SECONDS,
} from './constants';

/**
 * Redis (Valkey) hot cache + negative cache + single-flight lock for the
 * link-preview service. Mirrors Mention's `linkPreviewCache` / `negativeCache`:
 *
 *  - Uses the shared {@link getRedisClient} singleton — never opens a socket.
 *  - Degrades to a NO-OP whenever Redis is unavailable (`REDIS_URL` unset or the
 *    server is down): reads miss, writes are dropped, the lock is granted. Mongo
 *    remains the durable source of truth, so the service still works without
 *    Redis (just without the hot-path short-circuit).
 *  - Stores already-SERIALIZED client DTOs, so a value read back is safe to
 *    return verbatim (it can never contain a server-only origin URL).
 */

/** Positive entry (serialized `LinkPreview` DTO). */
const HOT_PREFIX = 'linkpreview:meta:';
/** Negative marker (URL resolved to no usable preview / failed). */
const NEG_PREFIX = 'linkpreview:neg:';
/** Single-flight resolve lock. */
const LOCK_PREFIX = 'linkpreview:lock:';

/** SHA-256 the URL so the key length is bounded and a raw URL is not stored verbatim. */
function keyFor(prefix: string, url: string): string {
  return `${prefix}${createHash('sha256').update(url).digest('hex')}`;
}

/** A connected, ready ioredis client, or `null` when Redis is unavailable. */
function readyClient(): ReturnType<typeof getRedisClient> {
  const redis = getRedisClient();
  if (!redis || redis.status !== 'ready') return null;
  return redis;
}

/**
 * Whether a resolved preview is worth caching as a POSITIVE entry (ported from
 * Mention). A preview with no image, no description, and a title that is just
 * the raw URL / bare hostname is NOT a usable preview — it renders as a bare
 * link yet would stick for the full positive TTL, blocking re-resolution. Such
 * hollow results are marked NEGATIVE (short TTL → auto-recovers) instead.
 */
export function isUsablePreview(p: {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
}): boolean {
  if (p.image && p.image.trim().length > 0) return true;
  if (p.description && p.description.trim().length > 0) return true;

  const title = p.title?.trim();
  if (!title) return false;

  // A title that is itself a URL (or starts like one) is not a usable preview.
  if (/^(https?:\/\/|www\.)/i.test(title)) return false;

  // A title equal to the URL's host is the hostname fallback, not real metadata.
  // (An unparseable url yields no host → the title is non-URL text, treat as usable.)
  if (p.url) {
    const host = hostnameOf(p.url)?.toLowerCase();
    if (host) {
      const titleLower = title.toLowerCase();
      if (titleLower === host || titleLower === host.replace(/^www\./, '')) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Parse + contract-validate a raw stored hot entry.
 *
 * A cache read is the one consumer-facing value that does NOT pass through the
 * serializer, so an entry written by an older/buggy deploy (e.g. one missing
 * `status`) would otherwise be returned verbatim and 500 the route's output
 * validation. Returns `null` for a corrupt-JSON OR contract-invalid entry — the
 * caller treats it as a MISS so it is re-resolved and overwritten (the cache
 * self-heals).
 */
function parseHotEntry(raw: string): LinkPreview | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const validated = linkPreviewSchema.safeParse(parsed);
  if (!validated.success) {
    logger.debug('[linkPreviewCache] discarding invalid cached preview (re-warming)');
    return null;
  }
  return validated.data;
}

/**
 * Read a single cached preview (the single-URL GET path):
 *  - a `LinkPreview` on a positive (validated) hit,
 *  - `'negative'` when the URL is known to have no usable preview,
 *  - `null` on a miss (caller should warm in the background).
 *
 * A hot hit takes precedence over a negative marker; an invalid hot entry is a
 * miss (it ignores the negative marker and is re-resolved).
 */
export async function readHotPreview(url: string): Promise<LinkPreview | 'negative' | null> {
  const redis = readyClient();
  if (!redis) return null;
  try {
    const [hit, neg] = await Promise.all([
      redis.get(keyFor(HOT_PREFIX, url)),
      redis.exists(keyFor(NEG_PREFIX, url)),
    ]);
    if (hit) {
      return parseHotEntry(hit);
    }
    if (neg === 1) return 'negative';
    return null;
  } catch (error) {
    logger.debug('[linkPreviewCache] hot read failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Batch-read previews for many URLs in TWO `MGET`s (one for the hot keys, one
 * for the negative-marker keys) instead of a per-URL `GET`+`EXISTS` fan-out.
 *
 * Returns:
 *  - `previews`: URL → DTO for positive (validated) hits AND for negatives
 *    (negatives map to a `status:'empty'` DTO so the batch always answers every
 *    URL without re-warming a known-dead URL),
 *  - `misses`: URLs that are true cache MISSES — the caller resolves these from
 *    Mongo and/or warms them.
 *
 * Per-URL semantics match {@link readHotPreview}: a hot hit wins; an invalid hot
 * entry is a miss; otherwise a present negative marker → empty; otherwise a miss.
 * Without Redis (or on a Redis error) every URL degrades to a miss.
 */
export async function readHotPreviews(
  urls: string[],
): Promise<{ previews: Map<string, LinkPreview>; misses: string[] }> {
  const previews = new Map<string, LinkPreview>();
  if (urls.length === 0) return { previews, misses: [] };

  const redis = readyClient();
  if (!redis) return { previews, misses: [...urls] };

  try {
    const [hotVals, negVals] = await Promise.all([
      redis.mget(urls.map((u) => keyFor(HOT_PREFIX, u))),
      redis.mget(urls.map((u) => keyFor(NEG_PREFIX, u))),
    ]);

    const misses: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const hotRaw = hotVals[i];
      if (hotRaw != null) {
        const dto = parseHotEntry(hotRaw);
        if (dto) previews.set(url, dto);
        else misses.push(url);
        continue;
      }
      if (negVals[i] != null) {
        previews.set(url, { url, status: 'empty' });
        continue;
      }
      misses.push(url);
    }
    return { previews, misses };
  } catch (error) {
    logger.debug('[linkPreviewCache] batch hot read failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return { previews: new Map(), misses: [...urls] };
  }
}

/** Store a resolved preview DTO with the hot TTL. A failure is a logged no-op. */
export async function storeHotPreview(url: string, preview: LinkPreview): Promise<void> {
  const redis = readyClient();
  if (!redis) return;
  try {
    await redis.set(
      keyFor(HOT_PREFIX, url),
      JSON.stringify(preview),
      'EX',
      LINK_PREVIEW_HOT_TTL_SECONDS,
    );
  } catch (error) {
    logger.debug('[linkPreviewCache] hot store failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Record that a URL has no usable preview / failed to resolve. Logged no-op on failure. */
export async function markNegative(url: string): Promise<void> {
  const redis = readyClient();
  if (!redis) return;
  try {
    await redis.set(keyFor(NEG_PREFIX, url), '1', 'EX', LINK_PREVIEW_NEG_TTL_SECONDS);
  } catch (error) {
    logger.debug('[linkPreviewCache] negative marker write failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Acquire the single-flight resolve lock for a URL. Returns `true` when this
 * caller may proceed to resolve, `false` when another caller already holds it.
 * Without Redis the lock is always granted (the in-process warm queue's pending
 * set provides dedup in that mode).
 */
export async function acquireResolveLock(url: string): Promise<boolean> {
  const redis = readyClient();
  if (!redis) return true;
  try {
    const result = await redis.set(
      keyFor(LOCK_PREFIX, url),
      '1',
      'EX',
      LINK_PREVIEW_LOCK_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  } catch (error) {
    logger.debug('[linkPreviewCache] lock acquire failed; proceeding', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

/** Release the single-flight resolve lock. Logged no-op on failure. */
export async function releaseResolveLock(url: string): Promise<void> {
  const redis = readyClient();
  if (!redis) return;
  try {
    await redis.del(keyFor(LOCK_PREFIX, url));
  } catch (error) {
    logger.debug('[linkPreviewCache] lock release failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
