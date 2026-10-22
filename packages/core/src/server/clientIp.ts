/**
 * The real client address behind Oxy's proxy chain.
 *
 * An Oxy backend sits behind an AWS ALB, and a public hostname may also sit
 * behind the Cloudflare proxy in front of that ALB. The ALB runs in XFF
 * `append` mode, so the request reaching the app carries one of:
 *
 *   grey  (DNS only)   X-Forwarded-For: <client>                 socket: ALB
 *   orange (proxied)   X-Forwarded-For: <client>, <cloudflare>   socket: ALB
 *   internal ALB       X-Forwarded-For: <caller in the VPC>      socket: ALB
 *
 * where everything LEFT of the entries above was written by whoever sent the
 * request and is attacker-controlled. `trust proxy = 1` answers `<client>`
 * for grey and `<cloudflare>` for orange, which is why every rate limit, auth
 * throttle and abuse signal would see Cloudflare's edge as one huge client.
 * Trusting a fixed TWO hops instead would let any grey caller spoof its
 * address with a forged header.
 *
 * {@link oxyTrustProxy} walks the chain from the socket outward and trusts:
 *
 *   hop 0  the socket peer, when it is a private or loopback address (the ALB,
 *          an in-host sidecar, a local dev proxy). A public socket peer means
 *          no proxy is in front at all, so nothing in the header is believed.
 *   hop 1  the address the ALB saw, only when it is one of Cloudflare's
 *          published edge ranges: it cannot be forged (the ALB wrote it from
 *          the TCP peer), and Cloudflare appends exactly the client it saw.
 *
 * Nothing further out is ever trusted, so the answer is the first address
 * neither the ALB nor Cloudflare vouches for — the same rule in all three
 * shapes, and correct both before and after a hostname is proxied.
 *
 * Express: `app.set('trust proxy', oxyTrustProxy)`; `req.ip`/`req.ips` (and so
 * `createOxyRateLimit`, `hashedIpKey`, express-rate-limit) follow. For a raw
 * `IncomingMessage` (a WebSocket upgrade, a socket.io handshake), use
 * {@link resolveClientIp}.
 */
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { extractEmbeddedIpv4, ipv4InCidr, ipv6InCidr } from './ipCidr';

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips/, also
 * `GET https://api.cloudflare.com/client/v4/ips`), as fetched 2026-10-21,
 * etag 38f79d050aa027e3be3865e495dcc9bc. The origin security group in
 * oxy-infra is rendered from the same published list. A range Cloudflare adds
 * later degrades to the old behaviour for traffic through it (the edge
 * address is reported as the client); it never makes a forged header
 * trusted.
 */
export const CLOUDFLARE_IPV4_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];

/** See {@link CLOUDFLARE_IPV4_RANGES}. */
export const CLOUDFLARE_IPV6_RANGES: readonly string[] = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

/** Addresses a proxy in front of the app connects from: private, CGNAT, loopback, link-local, ULA. */
const PRIVATE_IPV4_RANGES: readonly string[] = [
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
];
const PRIVATE_IPV6_RANGES: readonly string[] = ['::1/128', 'fc00::/7', 'fe80::/10'];

function splitCidr(cidr: string): readonly [string, number] {
  const slash = cidr.indexOf('/');
  return [cidr.slice(0, slash), Number(cidr.slice(slash + 1))];
}

const CLOUDFLARE_V4 = CLOUDFLARE_IPV4_RANGES.map(splitCidr);
const CLOUDFLARE_V6 = CLOUDFLARE_IPV6_RANGES.map(splitCidr);
const PRIVATE_V4 = PRIVATE_IPV4_RANGES.map(splitCidr);
const PRIVATE_V6 = PRIVATE_IPV6_RANGES.map(splitCidr);

/** The chain the ALB (and Cloudflare before it) appends to. */
const FORWARDED_FOR = 'x-forwarded-for';

function inRanges(
  rawIp: string,
  v4: ReadonlyArray<readonly [string, number]>,
  v6: ReadonlyArray<readonly [string, number]>,
): boolean {
  const ip = rawIp.trim();
  const family = isIP(ip);
  if (family === 4) {
    return v4.some(([net, prefix]) => ipv4InCidr(ip, net, prefix));
  }
  if (family === 6) {
    const embedded = extractEmbeddedIpv4(ip);
    if (embedded !== null) {
      return v4.some(([net, prefix]) => ipv4InCidr(embedded, net, prefix));
    }
    return v6.some(([net, prefix]) => ipv6InCidr(ip, net, prefix));
  }
  return false;
}

/** True when `ip` is inside one of Cloudflare's published edge ranges. */
export function isCloudflareAddress(ip: string): boolean {
  return inRanges(ip, CLOUDFLARE_V4, CLOUDFLARE_V6);
}

/** True for loopback, RFC 1918, CGNAT, link-local and unique-local addresses. */
export function isPrivateProxyAddress(ip: string): boolean {
  return inRanges(ip, PRIVATE_V4, PRIVATE_V6);
}

/**
 * Express `trust proxy` function (proxy-addr semantics: `hop` 0 is the socket
 * peer, 1 the right-most X-Forwarded-For entry, and so on outward; the first
 * untrusted address is `req.ip`). See the module comment for the chain.
 *
 * proxy-addr reads hop 0 from `req.socket.remoteAddress`, which is `undefined`
 * once the client has disconnected. An address-less hop is never trusted, so
 * `req.ip` is then `undefined`, as {@link resolveClientIp} answers for a closed
 * socket.
 */
export function oxyTrustProxy(address: string | undefined, hop: number): boolean {
  if (address === undefined) {
    return false;
  }
  if (hop === 0) {
    return isPrivateProxyAddress(address);
  }
  if (hop === 1) {
    return isCloudflareAddress(address);
  }
  return false;
}

/**
 * The client address of a raw Node request, by the same rule as
 * {@link oxyTrustProxy}. For code that never sees an Express `req`: a `ws`
 * upgrade, a socket.io handshake (`socket.request`), a bare `http` handler.
 * Returns `undefined` only when the socket has no address (already closed).
 */
export function resolveClientIp(
  request: Pick<IncomingMessage, 'headers'> & {
    socket?: { remoteAddress?: string | undefined } | null;
  },
): string | undefined {
  const socketAddress = request.socket?.remoteAddress;
  if (!socketAddress) {
    return undefined;
  }
  const header = request.headers[FORWARDED_FOR];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  // [socket, right-most XFF, ..., left-most XFF]
  const chain = [socketAddress, ...forwarded.reverse()];
  for (let hop = 0; hop < chain.length - 1; hop += 1) {
    if (!oxyTrustProxy(chain[hop], hop)) {
      return chain[hop];
    }
  }
  return chain[chain.length - 1];
}
