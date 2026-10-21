/**
 * Literal-address CIDR matching shared by the SSRF guard (`safeFetch`) and the
 * client-IP resolution behind the proxy chain (`clientIp`). Pure string math:
 * no DNS, no sockets, so it is safe on any runtime.
 */

/** Number of bits in each IPv4 octet. */
const IPV4_OCTET_BITS = 8;
/** Number of octets in an IPv4 address. */
const IPV4_OCTETS = 4;
/** Number of bits in each IPv6 16-bit group. */
const IPV6_GROUP_BITS = 16;
/** Number of 16-bit groups in an IPv6 address. */
const IPV6_GROUPS = 8;

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
export function ipv4InCidr(ip: string, network: string, prefix: number): boolean {
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
export function ipv6InCidr(ip: string, network: string, prefix: number): boolean {
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
export function extractEmbeddedIpv4(ip: string): string | null {
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
