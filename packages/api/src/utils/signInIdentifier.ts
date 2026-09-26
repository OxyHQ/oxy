/**
 * One normalisation of a sign-in identifier (a username or an email), used for
 * BOTH the database match and the lockout key, so one account can never be
 * named in two ways that fall into two lockout buckets.
 *
 * NFKC first (full-width `ＡＬＩＣＥ` is `ALICE`), then only printable ASCII is
 * accepted — usernames are ASCII by policy (`USERNAME_PATTERN_SOURCE` in
 * `@oxy.so/contracts`) and addresses are matched in the same charset — and
 * then an ASCII lower-case, which is exactly what Postgres `lower()` does to
 * ASCII in every locale. Anything else (e.g. `ALİCE`, whose dotted `İ`
 * JavaScript and Postgres lower-case differently) names no account: the caller
 * answers it like an unknown name, before any lookup.
 */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const MAX_IDENTIFIER_LENGTH = 254;

export function normalizeSignInIdentifier(raw: string): string | null {
  const value = raw.normalize('NFKC').trim();
  if (!value || value.length > MAX_IDENTIFIER_LENGTH || !PRINTABLE_ASCII.test(value)) return null;
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}
