/**
 * What `cloud.oxy.so` does to a response, by path (ADR 0047). Each rule here is
 * the Worker form of one CloudFront cache behavior it replaced (oxy-infra
 * `terraform-uswest2/cdn.tf`, removed with the distribution), in the order
 * CloudFront evaluated them: the first match wins.
 *
 *   `*.m3u8`        object; CORS; the origin's Cache-Control only (a master
 *                   playlist is rewritten in place, so never the immutable year)
 *   `/content/*`    object; CORS; immutable year when the object carries none
 *   `/variants/*`   same as `/content/*`
 *   `/oxy-website/*` object, from the website's own legacy bucket; CORS
 *   anything else   the by-id resolver: oxy-api `GET /cdn/<path>?variant=`
 *
 * An object path is ALWAYS read under `public/`. That prefix is the whole
 * privacy boundary: oxy-api writes a file under it only while the file is
 * public and active (`config/cdn.ts` `isServedPublicly`), so a private file's
 * key can never be named from here, whatever the path says.
 */

export type ObjectRoute = {
  kind: 'object';
  /**
   * Which bucket: Oxy Files', or the website's legacy images (`/oxy-website/`),
   * which the website still deletes itself and so live in a bucket of their own
   * whose token reaches nothing else (ADR 0047).
   */
  bucket: 'files' | 'website';
  /** The R2 key: always `public/` + the path. */
  key: string;
  /** Cache-Control for an object stored without one; null keeps it absent. */
  defaultCacheControl: string | null;
};

export type ResolverRoute = { kind: 'resolver' };

export type Route = ObjectRoute | ResolverRoute;

export const PUBLIC_KEY_PREFIX = 'public/';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * How long Cloudflare keeps an object that carries no Cache-Control of its own
 * (a playlist without one, a legacy website image). CloudFront's managed
 * CachingOptimized policy kept them for its one-day default TTL; the same day
 * is now stated on the response instead of being implied by the edge.
 */
export const DEFAULT_EDGE_CACHE_CONTROL = 'public, max-age=86400';

/** The path as R2 knows it: percent-decoded, as S3 decoded CloudFront's request path. */
function decodedPath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

const VARIANTS_PREFIX = '/variants/';
const DOUBLED_SEPARATOR = '/public/variants/';

/**
 * The canonical path of a rendition requested through a pre-rewrite HLS
 * master, or null for any other path.
 *
 * Until OxyHQ/oxy#1203 a master listed each rendition by its STORAGE KEY,
 * `public/variants/<dir>/hls_360p.m3u8`, as a RELATIVE URI. A player resolves
 * it against the master's own URL (RFC 8216 §4.3.4.2, RFC 3986 §5.2), which is
 * `/variants/<dir>/hls_master.m3u8`, so it asked for
 * `/variants/<dir>/public/variants/<dir>/hls_360p.m3u8` — and every segment
 * that rendition lists resolves under the same doubled directory. The stored
 * masters were rewritten to basenames (`hls_360p.m3u8`), but a copy fetched
 * before that (a player's cache, a crawler's frontier) still produces the
 * doubled path.
 *
 * Only EXACTLY that shape is mapped, to `/variants/<dir>/<name>`: the
 * directory after `/public/variants/` must be the one before it, and the name
 * a single segment. Any other path containing `public/` is left alone, so the
 * mapping can never reach outside the rendition's own directory.
 */
export function canonicalRenditionPath(pathname: string): string | null {
  if (!pathname.startsWith(VARIANTS_PREFIX)) return null;
  const at = pathname.indexOf(DOUBLED_SEPARATOR);
  if (at < 0 || pathname.indexOf(DOUBLED_SEPARATOR, at + 1) >= 0) return null;
  const directory = pathname.slice(VARIANTS_PREFIX.length, at);
  const rest = pathname.slice(at + DOUBLED_SEPARATOR.length);
  if (directory.length === 0 || !rest.startsWith(`${directory}/`)) return null;
  const name = rest.slice(directory.length + 1);
  if (name.length === 0 || name.includes('/')) return null;
  return `${VARIANTS_PREFIX}${directory}/${name}`;
}

export function routeFor(pathname: string): Route {
  const path = decodedPath(pathname);
  if (path === null) return { kind: 'resolver' };
  const relative = path.replace(/^\/+/, '');
  if (relative === '') return { kind: 'resolver' };
  const key = `${PUBLIC_KEY_PREFIX}${relative}`;
  if (path.endsWith('.m3u8')) {
    return { kind: 'object', bucket: 'files', key, defaultCacheControl: null };
  }
  if (path.startsWith('/content/') || path.startsWith('/variants/')) {
    return { kind: 'object', bucket: 'files', key, defaultCacheControl: IMMUTABLE_CACHE_CONTROL };
  }
  if (path.startsWith('/oxy-website/')) {
    return { kind: 'object', bucket: 'website', key, defaultCacheControl: null };
  }
  return { kind: 'resolver' };
}

/**
 * Public media is read cross-origin by every Oxy web app, and not only by
 * `<img>`/`<video>`: hls.js FETCHES playlists and segments, and a Lottie
 * sticker is JSON the player fetches. Everything this host serves is already
 * public and credential-free, so the answer is `*` on every response, whatever
 * the request's Origin — which also keeps one cached copy right for every
 * caller (CloudFront's cached 302 used to carry CORS only when the request that
 * filled the cache had sent an Origin).
 */
export function applyCors(headers: Headers): void {
  if (!headers.has('access-control-allow-origin')) {
    headers.set('access-control-allow-origin', '*');
  }
  headers.set(
    'access-control-expose-headers',
    'Content-Length, Content-Range, Accept-Ranges, ETag, Content-Type',
  );
}

export function preflightHeaders(): Headers {
  const headers = new Headers();
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET, HEAD');
  headers.set('access-control-allow-headers', '*');
  headers.set('access-control-max-age', '86400');
  return headers;
}

const INLINE_TYPES = [
  'application/pdf',
  'text/plain',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
];
export const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
export const DOWNLOAD_POLICY = "sandbox; default-src 'none'";

function isInline(type: string): boolean {
  if (type.startsWith('image/svg')) return false;
  return (
    type.startsWith('image/') ||
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    INLINE_TYPES.includes(type)
  );
}

/**
 * A file a browser would RUN is never rendered as cloud.oxy.so (OxyHQ/oxy ADR
 * 0042 stages 4b and 4c). The CloudFront viewer-response function this
 * replaces, line for line:
 *
 *   - inline-safe media (image/* except SVG, video/*, audio/*, application/pdf,
 *     text/plain, HLS playlists): as stored;
 *   - `image/svg+xml`: stored only sanitized (stage 4c), so it renders in an
 *     `<img>`; any stored disposition is dropped, and a navigation to it is a
 *     sandboxed document that can neither run script nor fetch;
 *   - anything else, on a 2xx: `Content-Disposition: attachment` (a stored
 *     `attachment; filename=...` is kept) and a sandboxing CSP;
 *   - always `X-Content-Type-Options: nosniff`.
 *
 * A 304 is untouched: a browser MERGES a 304's headers into its cached copy.
 * Applied on every response, cached or not, so changing it needs no purge.
 */
export function applyDownloadDisposition(headers: Headers, status: number): void {
  if (status === 304) return;
  const type = ((headers.get('content-type') ?? '').toLowerCase().split(';')[0] ?? '').trim();
  if (type === 'image/svg+xml') {
    headers.delete('content-disposition');
    headers.set('content-security-policy', SVG_POLICY);
  } else if (!isInline(type) && status >= 200 && status < 300) {
    const stored = (headers.get('content-disposition') ?? '').toLowerCase();
    if (!stored.startsWith('attachment')) headers.set('content-disposition', 'attachment');
    headers.set('content-security-policy', DOWNLOAD_POLICY);
  }
  headers.set('x-content-type-options', 'nosniff');
}
