/**
 * Handle parsing for external identities: fediverse accts, atproto DIDs and
 * handles, and the bridge transports an external account is reached through.
 */

import { BSKY_NETWORK_DOMAIN, blueskyUsernameFromHandle } from '@oxy.so/federation';

const FEDIVERSE_HANDLE_REGEX = /^@?[\w.-]+@[\w.-]+\.\w+$/;

/**
 * Check if a string looks like a fediverse handle (@user@domain or user@domain).
 */
export function isFediverseHandle(query: string): boolean {
  return FEDIVERSE_HANDLE_REGEX.test(query.trim());
}

export function normalizeFediverseHandle(handle: string): string | null {
  const cleaned = handle
    .trim()
    .replace(/^acct:/i, '')
    .replace(/^@/, '');
  const atIndex = cleaned.indexOf('@');
  if (atIndex <= 0 || atIndex === cleaned.length - 1) return null;

  const localPart = cleaned.substring(0, atIndex).toLowerCase();
  const domain = cleaned.substring(atIndex + 1).toLowerCase();
  if (!localPart || !domain) return null;

  return `${localPart}@${domain}`;
}

export const ATPROTO_DID_RE = /^did:(plc|web):[^\s/?#]+$/;
/** An atproto handle is a DNS name: at least two labels and an alphabetic TLD. */
export const ATPROTO_HANDLE_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * The Oxy username of the Bluesky account an atproto handle names, or null when
 * `value` is not a handle. One leading `@` is allowed (`@alice.bsky.social` is how
 * Bluesky writes one). A default handle drops its `.bsky.social` suffix:
 * `alice.bsky.social` → `alice@bsky.social`, `example.com` → `example.com@bsky.social`.
 */
export function blueskyAcctFromHandle(value: string): string | null {
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  if (!ATPROTO_HANDLE_RE.test(handle)) return null;
  return `${blueskyUsernameFromHandle(handle)}@${BSKY_NETWORK_DOMAIN}`;
}

export function domainFromHandle(handle: string): string | null {
  const atIndex = handle.indexOf('@');
  if (atIndex === -1 || atIndex === handle.length - 1) return null;
  return handle.substring(atIndex + 1).toLowerCase();
}

/**
 * Bridges whose actor endpoint answers 404 intermittently for live mirrors. On
 * bird.makeup the same actor alternates 200/404 within seconds (measured
 * 2026-09-28 against cosmic_yolo_bot, t3chfalcon, melonfur_rim, leixida_sccl),
 * so one 404 there is not evidence the mirror is gone. It is retried before it
 * counts; a mirror that is really gone still fails, only later. For the same
 * reason a failed discovery through such a host is never remembered as an
 * unresolvable handle (`missIsInconclusive`).
 */
export const TRANSIENT_NOT_FOUND_HOSTS = new Set(['bird.makeup']);
export const TRANSIENT_NOT_FOUND_RETRY_DELAYS_MS = [500, 1_500];

/**
 * The bridge Oxy reaches each bridged network through. Its posts carry the
 * network's own post id (a tweet id, an Instagram shortcode), which is what lets
 * an app store each upstream post once whichever transport delivered it; another
 * bridge of the same network (mastox.eu for X) may also be registered, but is
 * never the one an account is routed through.
 */
const ROUTED_BRIDGES: Readonly<Record<string, string>> = {
  'x.com': 'bird.makeup',
  'instagram.com': 'kilogram.makeup',
};

/**
 * The acct an external account is reached through: X via bird.makeup,
 * Instagram via kilogram.makeup, anything else as itself.
 */
export function transportHandleForExternalAccount(handle: string): string {
  const at = handle.lastIndexOf('@');
  const bridge = ROUTED_BRIDGES[handle.slice(at + 1)];
  return bridge ? `${handle.slice(0, at)}@${bridge}` : handle;
}

/**
 * Whether `canonicalAcct`'s registered transports (`actors`) lack the one Oxy
 * routes its network through. False for a network that routes through nothing
 * but the account itself.
 *
 * Bluesky's routed transport is the account itself, read natively over atproto:
 * an account known only through Bridgy Fed lacks it.
 */
export function lacksRoutedTransport(
  canonicalAcct: string,
  actors: ReadonlyArray<{ transportAcct: string; protocol: string }>,
): boolean {
  const domain = domainFromHandle(canonicalAcct);
  if (domain === BSKY_NETWORK_DOMAIN) return !actors.some((actor) => actor.protocol === 'atproto');
  if (!domain || !Object.hasOwn(ROUTED_BRIDGES, domain)) return false;
  const routed = transportHandleForExternalAccount(canonicalAcct);
  return !actors.some((actor) => actor.transportAcct === routed);
}

/**
 * Whether a failed discovery of this handle says nothing about whether the
 * account exists: its source is a host whose 404 is intermittent
 * ({@link TRANSIENT_NOT_FOUND_HOSTS}).
 */
export function missIsInconclusive(handle: string): boolean {
  const transportHost = domainFromHandle(transportHandleForExternalAccount(handle));
  return transportHost !== null && TRANSIENT_NOT_FOUND_HOSTS.has(transportHost);
}
