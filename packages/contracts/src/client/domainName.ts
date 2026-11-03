/**
 * A web domain someone proves they control (`POST /identity/domains`), without Zod.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 * The API normalizes with this same function, so a name the domains screen
 * accepts is one the server accepts.
 */

/** Longest domain name (RFC 1035), and the field's `maxLength`. */
export const DOMAIN_NAME_MAX_LENGTH = 253;

/**
 * RFC 1035 hostname: dot-separated labels of 1-63 letters, digits and hyphens,
 * never starting or ending in a hyphen, at least two labels. Written without
 * lookbehind and without `\p{…}`, so it is linear and safe on Hermes.
 */
const DOMAIN_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The stored, lower-cased form of a typed domain, or `null` when it is not one. */
export function normalizeDomainName(raw: string): string | null {
  const domain = raw.trim().toLowerCase();
  if (domain.length === 0 || domain.length > DOMAIN_NAME_MAX_LENGTH) return null;
  return DOMAIN_NAME_PATTERN.test(domain) ? domain : null;
}
