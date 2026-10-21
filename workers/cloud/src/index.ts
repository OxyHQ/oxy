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

/**
 * A ranged miss on an object up to this size fills the cache first and answers
 * from it. A larger one is answered from R2 straight away (a video's first
 * frame must not wait for the whole file) and filled in the background.
 */
export const SYNCHRONOUS_FILL_MAX_BYTES = 16 * 1024 * 1024;

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
): Promise<boolean> {
  const object = await bucketFor(env, route).get(route.key);
  if (!hasBody(object)) return false;
  if (object.size > EDGE_CACHE_MAX_BYTES) {
    await object.body.cancel();
    return false;
  }
  const headers = objectHeaders(object, route);
  headers.set('content-length', String(object.size));
  await deps.cache.put(
    cacheKey,
    new Response(sized(object.body, object.size), { status: 200, headers }),
  );
  return true;
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
    if (head.size <= SYNCHRONOUS_FILL_MAX_BYTES) {
      if (await fillCache(env, route, cacheKey, deps)) {
        const filled = await deps.cache.match(cacheLookup(url, request));
        if (filled) return finalize(filled, route);
      }
    } else if (head.size <= EDGE_CACHE_MAX_BYTES && !backgroundFills.has(route.key)) {
      backgroundFills.add(route.key);
      deps.waitUntil(
        fillCache(env, route, cacheKey, deps)
          .catch(() => false)
          .finally(() => backgroundFills.delete(route.key)),
      );
    }
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
 * Only `variant` is forwarded, and only `variant` keys the cache.
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
  const cacheKey = new Request(
    `${url.origin}${url.pathname}${variant === null ? '' : `?variant=${encodeURIComponent(variant)}`}`,
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
  const route = routeFor(url.pathname);
  if (route.kind === 'object') return serveObject(request, url, env, route, deps);
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
