/**
 * Handle parsing for external identities: fediverse accts, atproto DIDs and
 * handles, and the bridge transports an external account is reached through.
 */

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
 * The acct an external account is reached through: X via bird.makeup,
 * Instagram via kilogram.makeup, anything else as itself.
 */
export function transportHandleForExternalAccount(handle: string): string {
  const at = handle.lastIndexOf('@');
  const local = handle.slice(0, at);
  const domain = handle.slice(at + 1);
  return domain === 'x.com'
    ? `${local}@bird.makeup`
    : domain === 'instagram.com'
      ? `${local}@kilogram.makeup`
      : handle;
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
