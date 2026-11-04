/**
 * Oxy's own federation domain(s): the apex its actors live on, and the set a
 * handle is checked against so an own-domain handle never resolves as remote.
 */

import { canonicalFederationHost } from '@oxy.so/federation';

/** Oxy's federation apex: its actors, keyIds and WebFinger links are on this host. */
export const AP_DOMAIN = process.env.FEDERATION_DOMAIN || 'oxy.so';

/**
 * Oxy's OWN federation apex domain(s). The fediverse treats `oxy.so` as a
 * remote ActivityPub origin, but it is in fact our own apex: a handle like
 * `nate@oxy.so` denotes the LOCAL user `nate`, NOT a remote actor. Resolving
 * such a handle must never WebFinger our own apex nor mint a `type:'federated'`
 * shadow row — that duplicates the real local user and shadows it in search.
 *
 * The set is the configured {@link AP_DOMAIN} plus any extra aliases supplied
 * via the optional comma-separated `FEDERATION_OWN_DOMAINS` env (e.g. a legacy
 * apex). Entries are trimmed, lowercased, and de-duplicated.
 *
 * This is the SINGLE source of truth for the own-domain set; consumers
 * (`routes/users.ts`, the dedupe script) import {@link isOwnFederationDomain}
 * or {@link OWN_FEDERATION_DOMAINS} (through `federation.service`) rather than
 * copying the constant.
 */
export const OWN_FEDERATION_DOMAINS: ReadonlySet<string> = new Set(
  [AP_DOMAIN, ...(process.env.FEDERATION_OWN_DOMAINS ?? '').split(',')]
    .map((domain) => canonicalFederationHost(domain))
    .filter((domain) => domain.length > 0),
);

/**
 * True when `domain` is one of Oxy's own federation domains (case-insensitive).
 * Strips a leading `www.` so `www.oxy.so` matches the apex entry.
 * Callers short-circuit resolution for own-domain handles (return null / reject
 * 400) so they never mint a `type:'federated'` shadow row.
 */
export function isOwnFederationDomain(domain: string): boolean {
  return OWN_FEDERATION_DOMAINS.has(canonicalFederationHost(domain));
}
