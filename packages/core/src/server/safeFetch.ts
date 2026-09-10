/**
 * SSRF-safe upstream HTTP fetch for Oxy backends.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every Oxy backend that contacts a caller-influenced URL — media proxies,
 * the website MCP image upload/debug tools, federated fetches, link
 * unfurlers — needs the exact same Server-Side Request Forgery (SSRF)
 * defence. Apps were re-implementing it (or worse, omitting it), so the
 * gold-standard primitive (originally `packages/backend/src/utils` in
 * Mention) lives here ONCE.
 *
 * THE CONTRACT
 * ------------
 *  - Every URL — including each redirect hop — is validated by
 *    {@link assertSafePublicUrl}: a real DNS resolution plus a denylist of
 *    private/reserved/metadata ranges (10/8, 127/8, 169.254.169.254, ::1, …).
 *  - The TCP connection is PINNED to the validated IP via a custom `lookup`,
 *    closing the DNS-rebind TOCTOU window — DNS is NOT re-resolved at connect
 *    time, so the address we validated is exactly the address Node connects to.
 *  - Redirects are followed manually (bounded) so every hop is re-validated and
 *    redirect bodies (potentially unbounded) are destroyed, not drained.
 *
 * Node-only: this module imports `node:http`/`node:https`/`node:dns` and is
 * exported solely from `@oxy.so/core/server`. It MUST NOT be reachable from the
 * browser `@oxy.so/core` entry.
 */

import http, { type IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { URL } from 'node:url';

/** Maximum accepted length of an input URL (DoS guard). */
export const MAX_URL_LENGTH = 2048;

/** The only network ports a safe fetch is allowed to reach upstream. */
export const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** Protocols a safe fetch is allowed to contact. */
export const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Time-to-first-byte deadline: how long to wait for the upstream to establish
 * the connection and send its RESPONSE HEADERS before aborting. Enforced via
 * `req.setTimeout` on the `ClientRequest`; once headers arrive, the caller owns
 * the (longer) streaming lifetime of the response body.
 */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 8_000;

/** Maximum number of HTTP redirects to follow; each hop is re-validated. */
export const MAX_REDIRECTS = 5;

/** Default User-Agent presented to upstreams when the caller does not set one. */
export const DEFAULT_USER_AGENT = 'OxyServices/1.0 (+https://oxy.so)';

/** HTTP status codes that indicate a redirect we should follow. */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Matches hosts composed exclusively of characters that appear in numeric IP
 * notations — decimal/hex digits, dots, colons and the hex marker `x`. A real
 * DNS hostname always carries at least one alphabetic label character outside
 * this set. Used to reject ambiguous partial/mixed numeric forms (`127.1`,
 * `0x7f.1`, `0177.0.0.1`, `2130706433`) that `isIP()` does not accept as a
 * literal but that the OS resolver may canonicalize into a loopback/internal
 * address — and inconsistently so across glibc vs. musl (prod is Alpine/musl).
 */
const AMBIGUOUS_NUMERIC_HOST = /^[0-9a-fx.:]+$/i;

/** Hostnames that must never be resolved or contacted, regardless of DNS. */
export const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/**
 * IPv4 CIDR denylist (network, prefix-length) covering loopback, RFC1918
 * private, link-local (incl. cloud metadata 169.254.169.254), shared CGNAT,
 * "this host", multicast and reserved/broadcast space.
 */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // RFC6598 CGNAT / shared address space
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud instance metadata 169.254.169.254)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2 (documentation)
  ['203.0.113.0', 24], // TEST-NET-3 (documentation)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved / future use (incl. 255.255.255.255 broadcast)
];

/**
 * IPv6 prefix denylist (prefix, prefix-length) covering loopback, unspecified,
 * unique-local (fc00::/7), link-local (fe80::/10), multicast and documentation.
 * IPv4-mapped/embedded addresses are unwrapped to IPv4 before reaching here.
 */
const BLOCKED_IPV6_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['::1', 128], // loopback
  ['::', 128], // unspecified
  ['fc00::', 7], // unique local address
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentation
  ['64:ff9b::', 96], // NAT64 (maps to IPv4 — IPv4 denylist still applies after unwrap)
];

/** Number of bits in each IPv4 octet. */
const IPV4_OCTET_BITS = 8;
/** Number of octets in an IPv4 address. */
const IPV4_OCTETS = 4;
/** Number of bits in each IPv6 16-bit group. */
const IPV6_GROUP_BITS = 16;
/** Number of 16-bit groups in an IPv6 address. */
const IPV6_GROUPS = 8;

export interface SsrfCheckOk {
  ok: true;
  /** The validated literal IP the caller MUST connect to. */
  ip: string;
  /** IP family of the validated address (4 or 6). */
  family: 4 | 6;
}

export interface SsrfCheckFail {
  ok: false;
  /** Human-readable, non-sensitive reason (safe to log; not echoed to clients). */
  reason: string;
}

export type SsrfCheckResult = SsrfCheckOk | SsrfCheckFail;

/** Convert a dotted-quad IPv4 string into its unsigned 32-bit integer value. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== IPV4_OCTETS) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  // Force unsigned 32-bit.
  return value >>> 0;
}

/** Test whether an IPv4 address falls inside a CIDR block. */
function ipv4InCidr(ip: string, network: string, prefix: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(network);
  if (ipInt === null || netInt === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (IPV4_OCTET_BITS * IPV4_OCTETS - prefix)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/** Expand an IPv6 address (possibly using `::`) into its 8 group values. */
function ipv6ToGroups(ip: string): number[] | null {
  // Strip a zone index (e.g. "fe80::1%eth0") — not relevant for range checks.
  const zoneless = ip.split('%')[0];

  // An IPv4-mapped/embedded tail (e.g. "::ffff:1.2.3.4") is handled by the
  // caller, which unwraps to IPv4 before calling this. Reject here to be safe.
  if (zoneless.includes('.')) return null;

  const halves = zoneless.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === '') return [];
    const groups: number[] = [];
    for (const part of segment.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === IPV6_GROUPS ? head : null;
  }

  const tail = parseGroups(halves[1]);
  if (tail === null) return null;

  const missing = IPV6_GROUPS - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** Test whether an IPv6 address falls inside a prefix block. */
function ipv6InCidr(ip: string, network: string, prefix: number): boolean {
  const ipGroups = ipv6ToGroups(ip);
  const netGroups = ipv6ToGroups(network);
  if (ipGroups === null || netGroups === null) return false;

  let bitsRemaining = prefix;
  for (let i = 0; i < IPV6_GROUPS; i++) {
    if (bitsRemaining <= 0) break;
    const groupBits = Math.min(IPV6_GROUP_BITS, bitsRemaining);
    const mask = (0xffff << (IPV6_GROUP_BITS - groupBits)) & 0xffff;
    if ((ipGroups[i] & mask) !== (netGroups[i] & mask)) return false;
    bitsRemaining -= groupBits;
  }
  return true;
}

/**
 * Unwrap an IPv4-mapped/compatible/NAT64 IPv6 address to its embedded IPv4
 * dotted-quad form, so the IPv4 denylist applies. Returns null if not embedded.
 */
function extractEmbeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  // Forms like "::ffff:1.2.3.4" already carry dotted-quad notation.
  const dotted = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted && (lower.startsWith('::ffff:') || lower.startsWith('::'))) {
    return dotted[1];
  }
  // Hex form "::ffff:0102:0304" → 1.2.3.4
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1], 16);
    const lo = Number.parseInt(hexMapped[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/**
 * Return true if a literal IP address is private/loopback/link-local/reserved/
 * multicast/metadata and therefore must NOT be contacted.
 */
export function isBlockedIp(rawIp: string): boolean {
  const family = isIP(rawIp);
  if (family === 0) {
    // Not a valid IP literal — treat as blocked (fail closed).
    return true;
  }

  if (family === 4) {
    return BLOCKED_IPV4_CIDRS.some(([net, prefix]) => ipv4InCidr(rawIp, net, prefix));
  }

  // IPv6: first unwrap any embedded IPv4 and apply the IPv4 denylist.
  const embedded = extractEmbeddedIpv4(rawIp);
  if (embedded !== null) {
    return BLOCKED_IPV4_CIDRS.some(([net, prefix]) => ipv4InCidr(embedded, net, prefix));
  }
  return BLOCKED_IPV6_CIDRS.some(([net, prefix]) => ipv6InCidr(rawIp, net, prefix));
}

/**
 * Validate that a URL is syntactically a public http(s) URL and that its
 * hostname resolves ONLY to non-blocked, public IP addresses.
 *
 * On success, returns the single validated IP (the first allowed record) that
 * the HTTP client MUST pin its connection to. Every resolved address is checked;
 * if ANY resolves into a blocked range the URL is rejected (an attacker
 * controlling a multi-record DNS response cannot smuggle one internal IP past
 * the check).
 *
 * Re-run this on EVERY redirect hop so a public hostname cannot redirect (or
 * DNS-rebind) into an internal address.
 */
export async function assertSafePublicUrl(rawUrl: string): Promise<SsrfCheckResult> {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return { ok: false, reason: 'missing url' };
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'url too long' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'malformed url' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, reason: `disallowed protocol ${parsed.protocol}` };
  }

  // Reject embedded credentials (user:pass@host) — never appropriate here.
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'credentials in url not allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname.length === 0) {
    return { ok: false, reason: 'empty hostname' };
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: 'blocked hostname' };
  }

  // Enforce the standard-port allowlist. An empty `port` means the protocol
  // default (80/443), which is allowed.
  if (parsed.port !== '') {
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || !ALLOWED_PORTS.has(port)) {
      return { ok: false, reason: `disallowed port ${parsed.port}` };
    }
  }

  // If the hostname is already a literal IP, validate it directly (IPv6 hosts
  // arrive bracket-wrapped from the URL parser; strip the brackets).
  const literalHost =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const literalFamily = isIP(literalHost);
  if (literalFamily !== 0) {
    if (isBlockedIp(literalHost)) {
      return { ok: false, reason: 'literal ip in blocked range' };
    }
    return { ok: true, ip: literalHost, family: literalFamily === 4 ? 4 : 6 };
  }

  // Reject ambiguous numeric host forms BEFORE touching the resolver. `isIP`
  // returned 0 (not a canonical IP literal), yet the host is made entirely of
  // numeric/hex notation characters — e.g. `127.1`, `0x7f.1`, `0177.0.0.1`,
  // `2130706433`. The OS resolver might still canonicalize these into a
  // loopback/internal address (musl vs. glibc differ), so we never hand them to
  // DNS. Genuine hostnames always include a non-numeric/non-hex label.
  if (AMBIGUOUS_NUMERIC_HOST.test(literalHost)) {
    return { ok: false, reason: 'ambiguous numeric host' };
  }

  // Resolve the hostname. `all: true` returns every A/AAAA record so we can
  // reject if ANY of them is internal.
  let records: Array<{ address: string; family: number }>;
  try {
    records = await dnsLookup(literalHost, { all: true });
  } catch {
    return { ok: false, reason: 'dns resolution failed' };
  }

  if (records.length === 0) {
    return { ok: false, reason: 'no dns records' };
  }

  for (const record of records) {
    if (isBlockedIp(record.address)) {
      return { ok: false, reason: 'hostname resolves to blocked range' };
    }
  }

  // All records are public. Pin the connection to the first one.
  const chosen = records[0];
  return {
    ok: true,
    ip: chosen.address,
    family: chosen.family === 4 ? 4 : 6,
  };
}

/** Marker error for a blocked SSRF target (map to 403 at the route layer). */
export class SsrfRejection extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SsrfRejection';
  }
}

/** Marker error for a generic upstream failure (map to 502 at the route layer). */
export class UpstreamError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UpstreamError';
  }
}

/** Options for {@link safeFetch}. */
export interface SafeFetchOptions {
  /** HTTP method. Defaults to `GET`. */
  method?: string;
  /** Extra request headers. A `User-Agent` is added if none is provided. */
  headers?: Record<string, string>;
  /** Request body for POST/PUT/PATCH. */
  body?: string | Buffer;
  /**
   * Maximum number of redirects to follow (each re-validated). Defaults to
   * {@link MAX_REDIRECTS}. Set to `0` to disallow redirects.
   */
  maxRedirects?: number;
  /**
   * Time-to-first-byte deadline in milliseconds (connect + response headers).
   * Defaults to {@link UPSTREAM_HEADERS_TIMEOUT_MS}.
   */
  headersTimeoutMs?: number;
  /**
   * Optional external abort signal. When it fires the in-flight request is
   * destroyed.
   */
  signal?: AbortSignal;
}

/** The validated, non-redirect response returned by {@link safeFetch}. */
export interface SafeFetchResult {
  /**
   * The first non-redirect response. The caller OWNS draining/destroying this
   * stream (stream it to the client, or buffer a bounded prefix, then destroy).
   */
  response: IncomingMessage;
  /** The HTTP status code of the response. */
  status: number;
  /** Response headers. */
  headers: IncomingHttpHeaders;
  /** The final, post-redirect URL that produced the response. */
  finalUrl: string;
}

/**
 * Build the request options for a single hop, pinning the TCP connection to the
 * already-validated IP via a custom `lookup`. This closes the DNS-rebind TOCTOU
 * window: the address we validated is exactly the address Node connects to.
 */
function buildRequestOptions(
  target: URL,
  pinnedIp: string,
  pinnedFamily: 4 | 6,
  method: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): https.RequestOptions {
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method,
    headers,
    ...(signal ? { signal } : {}),
    // Pin the connection to the validated IP — DNS is NOT re-resolved here.
    //
    // CRITICAL (Bun gotcha): the runtime — notably Bun's HTTP client — may
    // invoke a custom lookup with `{ all: true }` and then sort the result
    // internally (`results.sort(...)`). When `all` is requested we MUST return
    // an ARRAY of `{ address, family }`; returning a single value makes that
    // internal sort throw `results.sort is not a function`. Node (non-`all`)
    // expects the `(err, address, family)` triple. Handle both.
    lookup: ((
      _hostname: string,
      options: number | LookupOneOptions | LookupAllOptions,
      callback: (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ): void => {
      const wantsAll = typeof options === 'object' && options !== null && options.all === true;
      if (wantsAll) {
        callback(null, [{ address: pinnedIp, family: pinnedFamily }]);
      } else {
        callback(null, pinnedIp, pinnedFamily);
      }
    }) as unknown as LookupFunction,
  };
}

/** Perform a single upstream request (no auto-redirect). */
function fetchOnce(
  options: https.RequestOptions,
  isHttps: boolean,
  headersTimeoutMs: number,
  body?: string | Buffer,
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => resolve(res));

    req.setTimeout(headersTimeoutMs, () => {
      req.destroy(new UpstreamError('upstream headers timeout'));
    });
    req.on('error', (err) => reject(err));
    req.end(body);
  });
}

/**
 * SSRF-safe HTTP(S) fetch. Validates the URL (and every redirect hop) against
 * the private/metadata-range denylist, pins the connection to the validated IP,
 * follows a bounded number of redirects (destroying redirect bodies), and
 * returns the first non-redirect response.
 *
 * The caller owns the returned response stream — drain or destroy it.
 *
 * @throws {SsrfRejection} when any hop targets a blocked address/host/port.
 * @throws {UpstreamError} on redirect-loop / malformed-redirect / timeout.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const {
    method = 'GET',
    headers: callerHeaders,
    body,
    maxRedirects = MAX_REDIRECTS,
    headersTimeoutMs = UPSTREAM_HEADERS_TIMEOUT_MS,
    signal,
  } = options;

  // Normalize a case-insensitive header map and ensure a User-Agent default.
  const baseHeaders: Record<string, string> = {};
  if (callerHeaders) {
    for (const [k, v] of Object.entries(callerHeaders)) {
      baseHeaders[k] = v;
    }
  }
  const hasUserAgent = Object.keys(baseHeaders).some((k) => k.toLowerCase() === 'user-agent');
  if (!hasUserAgent) {
    baseHeaders['User-Agent'] = DEFAULT_USER_AGENT;
  }

  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (signal?.aborted) {
      throw new UpstreamError('request aborted');
    }

    const guard = await assertSafePublicUrl(currentUrl);
    if (!guard.ok) {
      throw new SsrfRejection(guard.reason);
    }

    const target = new URL(currentUrl);
    const requestOptions = buildRequestOptions(
      target,
      guard.ip,
      guard.family,
      method,
      baseHeaders,
      signal,
    );
    const response = await fetchOnce(
      requestOptions,
      target.protocol === 'https:',
      headersTimeoutMs,
      body,
    );

    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUS_CODES.has(status)) {
      const location = response.headers.location;
      // We only need the Location header. Destroy immediately rather than
      // draining the (potentially unbounded) redirect body.
      response.destroy();

      if (hop === maxRedirects) {
        throw new UpstreamError('too many redirects');
      }
      if (!location || typeof location !== 'string') {
        throw new UpstreamError('redirect without location');
      }
      // Resolve relative redirects against the current URL.
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return {
      response,
      status,
      headers: response.headers,
      finalUrl: currentUrl,
    };
  }

  // Unreachable: the loop either returns a response or throws.
  throw new UpstreamError('redirect loop exhausted');
}
