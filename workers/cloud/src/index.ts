/**
 * cloud.oxy.so — Oxy Files' public CDN (OxyHQ/oxy ADR 0047).
 *
 * Replaces the CloudFront distribution that served the oxy-api S3 bucket's
 * `public/` prefix. Two kinds of request, as before:
 *
 *   - an object path (`/content/…`, `/variants/…`, `/oxy-website/…`, `*.m3u8`)
 *     is read from the Oxy Files R2 bucket under `public/` and cached at the
 *     edge with the Workers Cache API;
 *   - anything else is a file id (`/<fileId>?variant=…`), resolved by oxy-api's
 *     `GET /cdn/:id`, which answers a cacheable 302 to the object path for a
 *     public, active file and 404 for anything else.
 *
 * Private files are never reachable here: an object path always reads under
 * `public/`, where oxy-api keeps only public, active files (see `policy.ts`).
 * oxy-api purges a deleted object's URL through the Cloudflare purge API.
 */

import {
  type ObjectRoute,
  DEFAULT_EDGE_CACHE_CONTROL,
  applyCors,
  applyDownloadDisposition,
  canonicalRenditionPath,
  preflightHeaders,
  routeFor,
} from './policy';

export interface Env {
  /** Oxy Files' bucket. */
  FILES: R2Bucket;
  /** The website's legacy images, served at `/oxy-website/` (`policy.ts`). */
  WEBSITE_LEGACY: R2Bucket;
  /** oxy-api origin for the by-id resolver, e.g. `https://api.oxy.so`. */
  API_ORIGIN: string;
}

/**
 * Objects up to this size are kept in the edge cache. The Cache API refuses a
 * body over 512 MB on this plan; a larger video is ranged from R2 directly.
 */
export const EDGE_CACHE_MAX_BYTES = 500 * 1024 * 1024;

/** Keys this isolate is already filling in the background, so a burst of ranges fills once. */
const backgroundFills = new Set<string>();

export interface Deps {
  cache: Cache;
  waitUntil(promise: Promise<unknown>): void;
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

function finalize(response: Response, route: ObjectRoute | null): Response {
  const headers = new Headers(response.headers);
  applyCors(headers);
  if (route) applyDownloadDisposition(headers, response.status);
  return new Response(response.body, { status: response.status, headers });
}

function objectHeaders(object: R2Object, route: ObjectRoute): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('cache-control')) {
    headers.set('cache-control', route.defaultCacheControl ?? DEFAULT_EDGE_CACHE_CONTROL);
  }
  headers.set('etag', object.httpEtag);
  headers.set('last-modified', object.uploaded.toUTCString());
  headers.set('accept-ranges', 'bytes');
  return headers;
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: 'NOT_FOUND', message: 'Resource not found' }), {
    status: 404,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A file published a moment later must not stay a cached 404 for long.
      'cache-control': 'public, max-age=60',
    },
  });
}

/**
 * `body`, declared `length` bytes long. An object R2 has not copied yet is
 * streamed through from S3 (Sippy) with no length the runtime knows, and a
 * Response over such a stream drops its Content-Length — and the Cache API then
 * cannot answer a Range from the cached copy (it needs Content-Length), nor can
 * a player know how long the video is. The object's size is always known.
 */
function sized(body: ReadableStream, length: number): ReadableStream {
  if (typeof FixedLengthStream === 'undefined') return body;
  const { readable, writable } = new FixedLengthStream(length);
  void body.pipeTo(writable).catch(() => undefined);
  return readable;
}

function hasBody(object: R2Object | R2ObjectBody | null): object is R2ObjectBody {
  return object !== null && 'body' in object && object.body !== undefined;
}

/** The cache key: the path alone. S3 ignored the query string and so did CloudFront. */
function objectCacheKey(url: URL): Request {
  return new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
}

/** The request to `cache.match`: the key plus the headers the Cache API answers from. */
function cacheLookup(url: URL, request: Request): Request {
  const headers = new Headers();
  for (const name of ['range', 'if-none-match', 'if-modified-since']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request(`${url.origin}${url.pathname}`, { method: 'GET', headers });
}

function rangeOf(object: R2ObjectBody): { start: number; end: number } | null {
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (!range) return null;
  if (range.suffix !== undefined) {
    const length = Math.min(range.suffix, object.size);
    return { start: object.size - length, end: object.size - 1 };
  }
  const start = range.offset ?? 0;
  const length = range.length ?? object.size - start;
  return { start, end: start + length - 1 };
}

async function fillCache(
  env: Env,
  route: ObjectRoute,
  cacheKey: Request,
  deps: Deps,
): Promise<void> {
  const object = await bucketFor(env, route).get(route.key);
  if (!hasBody(object)) return;
  if (object.size > EDGE_CACHE_MAX_BYTES) {
    await object.body.cancel();
    return;
  }
  const headers = objectHeaders(object, route);
  headers.set('content-length', String(object.size));
  await deps.cache.put(
    cacheKey,
    new Response(sized(object.body, object.size), { status: 200, headers }),
  );
}

function bucketFor(env: Env, route: ObjectRoute): R2Bucket {
  return route.bucket === 'website' ? env.WEBSITE_LEGACY : env.FILES;
}

export async function serveObject(
  request: Request,
  url: URL,
  env: Env,
  route: ObjectRoute,
  deps: Deps,
): Promise<Response> {
  const cacheKey = objectCacheKey(url);
  const bucket = bucketFor(env, route);

  if (request.method === 'HEAD') {
    const cached = await deps.cache.match(cacheLookup(url, request));
    if (cached) return finalize(new Response(null, cached), route);
    const object = await bucket.head(route.key);
    if (!object) return finalize(notFound(), null);
    const headers = objectHeaders(object, route);
    headers.set('content-length', String(object.size));
    return finalize(new Response(null, { status: 200, headers }), route);
  }

  const cached = await deps.cache.match(cacheLookup(url, request));
  if (cached) return finalize(cached, route);

  const rangeHeader = request.headers.get('range');
  if (rangeHeader) {
    const head = await bucket.head(route.key);
    if (!head) return finalize(notFound(), null);
    let object: R2ObjectBody | R2Object | null;
    try {
      object = await bucket.get(route.key, { range: request.headers, onlyIf: request.headers });
    } catch {
      // A range R2 cannot satisfy (past the end, or several ranges at once).
      const headers = new Headers({ 'content-range': `bytes */${head.size}` });
      return finalize(new Response(null, { status: 416, headers }), null);
    }
    if (!object) return finalize(notFound(), null);
    const headers = objectHeaders(object, route);
    if (!hasBody(object)) return finalize(new Response(null, { status: 304, headers }), route);
    // Start with the requested bytes, even for small objects. Waiting for the
    // entire file to fill the cache delays the first frame and every cold seek.
    // Invalid and conditional requests never trigger a full-object download.
    const fillKey = `${route.bucket}:${route.key}`;
    if (object.size <= EDGE_CACHE_MAX_BYTES && !backgroundFills.has(fillKey)) {
      backgroundFills.add(fillKey);
      deps.waitUntil(
        fillCache(env, route, cacheKey, deps)
          .catch((error: unknown) => {
            console.error('Media edge cache fill failed', error);
          })
          .finally(() => backgroundFills.delete(fillKey)),
      );
    }
    const range = rangeOf(object);
    if (!range) {
      headers.set('content-length', String(object.size));
      return finalize(
        new Response(sized(object.body, object.size), { status: 200, headers }),
        route,
      );
    }
    const length = range.end - range.start + 1;
    headers.set('content-range', `bytes ${range.start}-${range.end}/${object.size}`);
    headers.set('content-length', String(length));
    return finalize(new Response(sized(object.body, length), { status: 206, headers }), route);
  }

  const object = await bucket.get(route.key, { onlyIf: request.headers });
  if (!object) return finalize(notFound(), null);
  const headers = objectHeaders(object, route);
  if (!hasBody(object)) return finalize(new Response(null, { status: 304, headers }), route);
  headers.set('content-length', String(object.size));
  const response = new Response(sized(object.body, object.size), { status: 200, headers });
  if (object.size <= EDGE_CACHE_MAX_BYTES) {
    deps.waitUntil(deps.cache.put(cacheKey, response.clone()).catch(() => undefined));
  }
  return finalize(response, route);
}

/**
 * The Cache-Tag on every cached answer for one path, whatever its `variant`:
 * `file:<path without the leading slash>`. oxy-api purges a file's resolver
 * answers by this tag when the file stops being served (`services/cdnPurge.ts`).
 */
export function resolverCacheTag(pathname: string): string {
  return `file:${pathname.replace(/^\/+/, '')}`;
}

/**
 * `cloud.oxy.so/<fileId>?variant=<v>` → oxy-api `GET /cdn/<fileId>?variant=<v>`.
 * Only `variant` and the rendition's authoritative ready timestamp (`revision`)
 * are forwarded and key the cache. A new generation bypasses old browser and
 * edge redirects without giving unrelated query parameters new cache entries.
 *
 * A redirect is kept in the Cache API for exactly as long as oxy-api's
 * Cache-Control says (an hour: the window in which a just-privatised file stays
 * resolvable, `config/cdn.ts`). NOT through `fetch`'s own edge cache: that path
 * stamps the zone's Browser Cache TTL (four hours) over the API's header, which
 * would quadruple the window. A 404 is never kept, so a file published a moment
 * after a miss resolves at once.
 */
export async function serveResolver(
  request: Request,
  url: URL,
  env: Env,
  deps: Deps,
): Promise<Response> {
  const variant = url.searchParams.get('variant');
  const revision = url.searchParams.get('revision');
  if (revision !== null) {
    const timestamp = new Date(revision);
    if (
      !variant ||
      url.searchParams.getAll('revision').length !== 1 ||
      revision.length !== 24 ||
      !Number.isFinite(timestamp.getTime()) ||
      timestamp.toISOString() !== revision
    ) {
      return finalize(
        new Response(null, { status: 400, headers: { 'cache-control': 'no-store' } }),
        null,
      );
    }
  }
  const revisionQs = revision === null ? '' : `&revision=${encodeURIComponent(revision)}`;
  const cacheKey = new Request(
    `${url.origin}${url.pathname}${variant === null ? '' : `?variant=${encodeURIComponent(variant)}`}${revisionQs}`,
    { method: 'GET' },
  );
  const cached = await deps.cache.match(cacheKey);
  if (cached) {
    const hit = new Response(null, cached);
    hit.headers.delete('cache-tag');
    return finalize(hit, null);
  }

  const target = new URL(`/cdn${url.pathname}`, env.API_ORIGIN);
  if (variant !== null) target.searchParams.set('variant', variant);
  if (revision !== null) target.searchParams.set('revision', revision);
  const upstream = await deps.fetch(target.toString(), { method: 'GET', redirect: 'manual' });
  const headers = new Headers();
  for (const name of ['location', 'cache-control', 'content-type']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const isRedirect = upstream.status >= 300 && upstream.status < 400;
  if (isRedirect) {
    // A redirect has no bytes to range (`utils/cdnRedirect.ts` in the API).
    headers.set('accept-ranges', 'none');
    await upstream.body?.cancel();
    const redirect = new Response(null, { status: upstream.status, headers });
    if (/\bpublic\b/.test(headers.get('cache-control') ?? '')) {
      // Tagged with the file id, so oxy-api can purge every variant of it at once.
      const stored = new Response(null, redirect);
      stored.headers.set('cache-tag', resolverCacheTag(url.pathname));
      deps.waitUntil(deps.cache.put(cacheKey, stored).catch(() => undefined));
    }
    return finalize(redirect, null);
  }
  const body = request.method === 'HEAD' ? null : upstream.body;
  if (request.method === 'HEAD') await upstream.body?.cancel();
  return finalize(new Response(body, { status: upstream.status, headers }), null);
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: preflightHeaders() });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, OPTIONS' } });
  }
  const url = new URL(request.url);
  // A rendition asked through a pre-rewrite master is served (and cached) as
  // the canonical path it names (`policy.canonicalRenditionPath`). Served in
  // place, not redirected: whichever URL a player keeps as the rendition's
  // base, the segments it lists resolve either to their canonical path or to
  // the same doubled shape, which maps here too.
  const canonical = canonicalRenditionPath(url.pathname);
  if (canonical) url.pathname = canonical;
  const route = routeFor(url.pathname);
  if (route.kind === 'object') {
    const response = await serveObject(request, url, env, route, deps);
    if (canonical) response.headers.set('link', `<${url.origin}${canonical}>; rel="canonical"`);
    return response;
  }
  return serveResolver(request, url, env, deps);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, {
      cache: caches.default,
      waitUntil: (promise) => ctx.waitUntil(promise),
      fetch: (input, init) => fetch(input, init),
    });
  },
} satisfies ExportedHandler<Env>;
