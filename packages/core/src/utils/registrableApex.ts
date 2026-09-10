/**
 * Registrable-apex (eTLD+1) host kernel.
 *
 * The client FAPI auto-detection helper was removed in the device-first cutover
 * (which is why this file is now named for what it actually is, not the old
 * `fapiAutoDetect`). What survives is the pure registrable-domain kernel, still
 * used by the `@oxy.so/core/server` CORS layer (the `*.oxy.so` same-apex trust
 * check) and its re-export surface.
 */

import { getDomain } from 'tldts';

/**
 * Compute the bare registrable apex (eTLD+1) of a hostname using the Public
 * Suffix List, including private hosted suffixes.
 *
 * Performs NO protocol handling and builds NO URL — it only answers "what is
 * the registrable domain of this host, or is that undefinable?".
 *
 * Returns `null` (apex undefinable) for:
 *   - empty input;
 *   - IPv4 literals (`192.168.1.10`);
 *   - IPv6 literals or any host carrying a port (`[::1]`, anything with `:`);
 *   - single-label hosts (`intranet`, `localhost`);
 *   - public suffixes without a registrable label (e.g. `co.uk`, `github.io`).
 *
 * @param hostname - A bare hostname (no scheme), e.g. `www.mention.earth`.
 * @returns The eTLD+1 (`mention.earth`), or `null` when undefinable.
 */
export function registrableApex(hostname: string): string | null {
  if (!hostname) return null;
  const host = hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  // IPv6 literals are bracketed; any remaining ':' implies a port — neither
  // yields a registrable apex.
  if (host.startsWith('[') || host.includes(':')) return null;
  // The Public Suffix List (private suffixes included) is the source of truth
  // for what an attacker can register. A multi-part public suffix like `co.uk`
  // or a hosted suffix like `github.io` returns no registrable domain.
  return getDomain(host, { allowPrivateDomains: true });
}
