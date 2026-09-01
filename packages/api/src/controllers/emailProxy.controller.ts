/**
 * Email Proxy Controller
 *
 * Proxies external images and fonts for email content to bypass CORS restrictions
 * and provide tracking protection for users.
 */

import type { IncomingMessage } from 'node:http';
import type { Request, Response as ExpressResponse } from 'express';
import { safeFetch, SsrfRejection } from '@oxyhq/core/server';
import { BadRequestError } from '../utils/error';
import { logger } from '../utils/logger';
import crypto from 'crypto';

// ─── Configuration ────────────────────────────────────────────────

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const FETCH_TIMEOUT = 10000; // 10 seconds
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
  'base64'
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

function readBodyLimited(response: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    response.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        response.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => finish(Buffer.concat(chunks, total)));
    response.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    response.on('close', () => finish(null));
  });
}

// ─── Tracking Protection ──────────────────────────────────────────

const TRACKING_PATTERNS = [
  /mailtrack\./i,
  /getnotify\./i,
  /readnotify\./i,
  /yesware\./i,
  /bananatag\./i,
  /\.doubleclick\./i,
  /\/track(ing)?[\/\?]/i,
  /\/pixel[\/\?]/i,
  /\/beacon[\/\?]/i,
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
let currentCacheSize = 0;

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

  return entry;
}

function addToCache(key: string, buffer: Buffer, contentType: string): void {
  if (buffer.length > MAX_CACHE_SIZE / 10) return;

  while (currentCacheSize + buffer.length > MAX_CACHE_SIZE && cache.size > 0) {
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

// Periodic cache cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      currentCacheSize -= entry.buffer.length;
      cache.delete(key);
    }
  }
}, 60 * 60 * 1000).unref();

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
  cacheHit: boolean
): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Cache', cacheHit ? 'HIT' : 'MISS');
  res.send(buffer);
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
        return sendNotFound(res, 3600);
      }

      const contentTypeHeader = headers['content-type'];
      const contentType = (Array.isArray(contentTypeHeader)
        ? contentTypeHeader[0]
        : contentTypeHeader) || 'application/octet-stream';
      const finalParsed = new URL(finalUrl);

      // Validate content type — allow octet-stream for font files (many servers
      // serve .ttf/.woff as application/octet-stream instead of font/*)
      const isAllowedType = /^(image\/|font\/|application\/(font|x-font))/i.test(contentType);
      const isFontByExtension = contentType === 'application/octet-stream'
        && FONT_EXTENSIONS.test(finalParsed.pathname);
      if (!isAllowedType && !isFontByExtension) {
        throw new BadRequestError('Only images and fonts allowed');
      }

      const buffer = await readBodyLimited(response, MAX_IMAGE_SIZE);
      if (!buffer) {
        throw new BadRequestError('Resource too large');
      }

      // Block tracking pixels (very small images)
      if (buffer.length < TRACKING_PIXEL_THRESHOLD) {
        logger.debug('Blocked tracking pixel', { url: decodedUrl, size: buffer.length });
        return sendWithheld();
      }

      // Use correct MIME when upstream sends generic octet-stream for fonts
      let resolvedType = contentType;
      if (isFontByExtension) {
        const ext = finalParsed.pathname.match(/\.\w+/)?.[0]?.toLowerCase();
        if (ext && FONT_MIME[ext]) resolvedType = FONT_MIME[ext];
      }

      addToCache(cacheKey, buffer, resolvedType);
      sendProxiedResponse(res, buffer, resolvedType, false);
    } finally {
      response.destroy();
    }
  } catch (error) {
    if (error instanceof SsrfRejection) {
      throw new BadRequestError('Private network URLs are not allowed');
    }

    if (error instanceof BadRequestError) throw error;

    if (error instanceof Error && error.name === 'AbortError') {
      logger.warn('Proxy request timeout', { url: decodedUrl });
    } else {
      logger.error('Proxy request failed', { url: decodedUrl, error });
    }

    sendWithheld();
  }
}
