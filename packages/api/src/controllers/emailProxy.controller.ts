/**
 * Email Proxy Controller
 *
 * Proxies external images and fonts for email content to bypass CORS restrictions
 * and provide tracking protection for users.
 */

import type { Request, Response as ExpressResponse } from 'express';
import { readResponseBody, safeFetch, SsrfRejection } from '@oxy.so/core/server';
import { BadRequestError } from '../utils/error';
import { logger } from '../utils/logger';
import crypto from 'crypto';

// ─── Configuration ────────────────────────────────────────────────

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT = 10000; // 10 seconds
const BODY_TIMEOUT_MS = 10_000; // a 10 MB image at ≥ 1 MB/s; the fetch's own budget
const MAX_REDIRECTS = 3;
const TRACKING_PIXEL_THRESHOLD = 100; // bytes
const FONT_EXTENSIONS = /\.(ttf|otf|woff2?|eot)(\?|$)/i;
const FONT_MIME: Record<string, string> = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.eot': 'application/vnd.ms-fontobject',
};

// Transparent 1x1 GIF for blocked tracking pixels
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

// ─── URL validation ───────────────────────────────────────────────

function parseProxyUrl(urlString: string): string {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new BadRequestError('Invalid URL format');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestError('Only HTTP(S) URLs are allowed');
  }

  return url.href;
}

// ─── Tracking Protection ──────────────────────────────────────────

const TRACKING_PATTERNS = [
  /mailtrack\./i,
  /getnotify\./i,
  /readnotify\./i,
  /yesware\./i,
  /bananatag\./i,
  /\.doubleclick\./i,
  /\/track(ing)?[/?]/i,
  /\/pixel[/?]/i,
  /\/beacon[/?]/i,
  /\/wf\/open/i,
  /\/[to]\.gif$/i,
];

function isTrackingUrl(url: URL): boolean {
  const fullUrl = url.href;
  return TRACKING_PATTERNS.some((p) => p.test(fullUrl));
}

// ─── Caching ──────────────────────────────────────────────────────

interface CacheEntry {
  buffer: Buffer;
  contentType: string;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 500 * 1024 * 1024; // 500 MB
let maxCacheSize = MAX_CACHE_SIZE;
let currentCacheSize = 0;

/**
 * Resources that could not be served, answered again without fetching for a
 * while: a mail is opened and re-rendered many times, and a dead tracker or a
 * gone host costs a full fetch timeout on each. Bounded by count; the oldest
 * goes first.
 */
const failures = new Map<string, { outcome: WithheldOutcome; expiresAt: number }>();
const FAILURE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_FAILURES = 5000;

/** The fetch of each resource now in progress, which every request for it awaits. */
const inFlight = new Map<string, Promise<ProxyOutcome>>();

function getCacheKey(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function getFromCache(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.timestamp > CACHE_TTL) {
    currentCacheSize -= entry.buffer.length;
    cache.delete(key);
    return undefined;
  }

  // Least recently USED goes first: a hit moves the entry to the back of the
  // Map's insertion order, which is what eviction walks.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function addToCache(key: string, buffer: Buffer, contentType: string): void {
  if (buffer.length > maxCacheSize / 10) return;

  while (currentCacheSize + buffer.length > maxCacheSize && cache.size > 0) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      const oldEntry = cache.get(oldestKey);
      if (oldEntry) {
        currentCacheSize -= oldEntry.buffer.length;
        cache.delete(oldestKey);
      }
    }
  }

  cache.set(key, { buffer, contentType, timestamp: Date.now() });
  currentCacheSize += buffer.length;
}

function getFailure(key: string): WithheldOutcome | undefined {
  const entry = failures.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    failures.delete(key);
    return undefined;
  }
  return entry.outcome;
}

function addFailure(key: string, outcome: WithheldOutcome): void {
  failures.delete(key);
  while (failures.size >= MAX_FAILURES) {
    const oldestKey = failures.keys().next().value;
    if (oldestKey === undefined) break;
    failures.delete(oldestKey);
  }
  failures.set(key, { outcome, expiresAt: Date.now() + FAILURE_TTL });
}

// Periodic cache cleanup
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
      if (now - entry.timestamp > CACHE_TTL) {
        currentCacheSize -= entry.buffer.length;
        cache.delete(key);
      }
    }
    for (const [key, entry] of failures.entries()) {
      if (now >= entry.expiresAt) failures.delete(key);
    }
  },
  60 * 60 * 1000,
).unref();

/** Empty every cache, and set the byte budget (the real one when omitted). */
export function resetProxyCacheForTests(maxBytes = MAX_CACHE_SIZE): void {
  cache.clear();
  failures.clear();
  inFlight.clear();
  currentCacheSize = 0;
  maxCacheSize = maxBytes;
}

// ─── Response Helpers ─────────────────────────────────────────────

/** Empty 404 for a resource the upstream does not have. */
function sendNotFound(res: ExpressResponse, cacheTime = 86400): void {
  res.setHeader('Cache-Control', `public, max-age=${cacheTime}`);
  res.status(404).end();
}

function sendTransparentGif(res: ExpressResponse, cacheTime = 86400): void {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', `public, max-age=${cacheTime}`);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(TRANSPARENT_GIF);
}

function sendProxiedResponse(
  res: ExpressResponse,
  buffer: Buffer,
  contentType: string,
  cacheHit: boolean,
): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Cache', cacheHit ? 'HIT' : 'MISS');
  res.send(buffer);
}

// ─── Fetching ─────────────────────────────────────────────────────

/**
 * What fetching a resource came to: everything a response is written from,
 * so one fetch answers every request that waited on it, and a resource that
 * could not be served is answered again, identically, without a fetch.
 */
type ProxyOutcome = { kind: 'served'; buffer: Buffer; contentType: string } | WithheldOutcome;

type WithheldOutcome =
  /** The upstream does not have it. */
  | { kind: 'not_found' }
  /** A tracking pixel, or a fetch that never completed. */
  | { kind: 'withheld' }
  /** Answered 400 with this message. */
  | { kind: 'refused'; message: string };

async function fetchResource(normalizedUrl: string, decodedUrl: string): Promise<ProxyOutcome> {
  try {
    const result = await safeFetch(normalizedUrl, {
      headers: {
        'User-Agent': 'OxyMail/1.0 (Image Proxy)',
        Accept: 'image/*,font/*,*/*',
      },
      maxRedirects: MAX_REDIRECTS,
      headersTimeoutMs: FETCH_TIMEOUT,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    const { response, status, headers, finalUrl } = result;

    try {
      if (status < 200 || status >= 300) {
        // The upstream does not have this resource. Answering with the
        // transparent GIF would be a successful-looking image, which is how a
        // sender avatar whose /favicon.ico 404s ends up as an invisible pixel
        // painted over the initials placeholder — the caller never learns the
        // fetch failed. The GIF stays reserved for what it is for: a tracking
        // pixel we deliberately blocked.
        return { kind: 'not_found' };
      }

      const contentTypeHeader = headers['content-type'];
      const contentType =
        (Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader) ||
        'application/octet-stream';
      const finalParsed = new URL(finalUrl);

      // Validate content type — allow octet-stream for font files (many servers
      // serve .ttf/.woff as application/octet-stream instead of font/*)
      const isAllowedType = /^(image\/|font\/|application\/(font|x-font))/i.test(contentType);
      const isFontByExtension =
        contentType === 'application/octet-stream' && FONT_EXTENSIONS.test(finalParsed.pathname);
      if (!isAllowedType && !isFontByExtension) {
        return { kind: 'refused', message: 'Only images and fonts allowed' };
      }

      const body = await readResponseBody(response, {
        maxBytes: MAX_IMAGE_SIZE,
        timeoutMs: BODY_TIMEOUT_MS,
      });
      if (body.kind === 'too_large') {
        return { kind: 'refused', message: 'Resource too large' };
      }
      // A body that stalled or broke off is answered as any other failed fetch, below.
      if (body.kind === 'timeout') throw new Error('Upstream body timed out');
      if (body.kind === 'error') throw body.error;
      const buffer = body.body;

      // Block tracking pixels (very small images)
      if (buffer.length < TRACKING_PIXEL_THRESHOLD) {
        logger.debug('Blocked tracking pixel', { url: decodedUrl, size: buffer.length });
        return { kind: 'withheld' };
      }

      // Use correct MIME when upstream sends generic octet-stream for fonts
      let resolvedType = contentType;
      if (isFontByExtension) {
        const ext = finalParsed.pathname.match(/\.\w+/)?.[0]?.toLowerCase();
        if (ext && FONT_MIME[ext]) resolvedType = FONT_MIME[ext];
      }

      return { kind: 'served', buffer, contentType: resolvedType };
    } finally {
      response.destroy();
    }
  } catch (error) {
    if (error instanceof SsrfRejection) {
      return { kind: 'refused', message: 'Private network URLs are not allowed' };
    }

    // Remote images and fonts in mail fail routinely — trackers that are down,
    // hosts that are gone — and the reader gets the withheld answer either
    // way. That is a warning, not an error to page on.
    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn('Proxy request timeout', { url: decodedUrl });
    } else {
      logger.warn('Proxy request failed', {
        url: decodedUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { kind: 'withheld' };
  }
}

/** The fetch of this resource: the one in progress if there is one, else a new one. */
function fetchOnce(cacheKey: string, normalizedUrl: string, decodedUrl: string) {
  const pending = inFlight.get(cacheKey);
  if (pending) return pending;

  const fetched = fetchResource(normalizedUrl, decodedUrl)
    .then((outcome) => {
      if (outcome.kind === 'served') addToCache(cacheKey, outcome.buffer, outcome.contentType);
      else addFailure(cacheKey, outcome);
      return outcome;
    })
    .finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, fetched);
  return fetched;
}

// ─── Controller ───────────────────────────────────────────────────

export async function proxyResource(req: Request, res: ExpressResponse): Promise<void> {
  const { url: encodedUrl } = req.query;

  if (!encodedUrl || typeof encodedUrl !== 'string') {
    throw new BadRequestError('URL parameter is required');
  }

  // Decode URL (support both base64 and URI encoding)
  let decodedUrl: string;
  try {
    const base64Decoded = Buffer.from(encodedUrl, 'base64').toString('utf-8');
    decodedUrl = base64Decoded.startsWith('http') ? base64Decoded : decodeURIComponent(encodedUrl);
  } catch {
    decodedUrl = decodeURIComponent(encodedUrl);
  }

  const normalizedUrl = parseProxyUrl(decodedUrl);
  const url = new URL(normalizedUrl);

  // What to answer when the resource is deliberately withheld — a blocked
  // tracker, or a fetch that never completed. An image gets the transparent
  // GIF so the mail's layout survives; a font must get nothing at all, because
  // a browser handed a GIF for a `@font-face` src decodes it as a font and
  // reports `OTS parsing error: invalid sfntVersion` (0x47494638 — the literal
  // bytes "GIF8"). With no body it drops that @font-face and falls back to the
  // next family.
  const wantsFont = FONT_EXTENSIONS.test(url.pathname);
  const sendWithheld = (cacheTime?: number): void =>
    wantsFont ? sendNotFound(res, cacheTime) : sendTransparentGif(res, cacheTime);

  // Block tracking URLs
  if (isTrackingUrl(url)) {
    logger.debug('Blocked tracking URL', { url: decodedUrl });
    return sendWithheld();
  }

  // Check cache
  const cacheKey = getCacheKey(decodedUrl);
  const cached = getFromCache(cacheKey);
  if (cached) {
    return sendProxiedResponse(res, cached.buffer, cached.contentType, true);
  }

  const outcome = getFailure(cacheKey) ?? (await fetchOnce(cacheKey, normalizedUrl, decodedUrl));
  switch (outcome.kind) {
    case 'served':
      return sendProxiedResponse(res, outcome.buffer, outcome.contentType, false);
    case 'not_found':
      return sendNotFound(res, 3600);
    case 'withheld':
      return sendWithheld();
    case 'refused':
      throw new BadRequestError(outcome.message);
  }
}
