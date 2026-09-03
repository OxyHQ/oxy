const SENSITIVE_URL_QUERY_PARAMS = new Set(['token', 'access_token', 'authorization']);

/**
 * Remove credential-bearing query parameters before persisting or returning
 * user-supplied URLs.
 *
 * This intentionally parses only the query string rather than round-tripping
 * through `URL`: application icons historically also accepted relative asset
 * references, and normalising those would either reject them or rewrite their
 * path. The fragment is split first so a harmless `#?token=...` label is not
 * mistaken for an actual query parameter.
 */
export function stripSensitiveUrlQueryParams(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const fragmentIndex = trimmed.indexOf('#');
  const beforeFragment = fragmentIndex === -1 ? trimmed : trimmed.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? '' : trimmed.slice(fragmentIndex);
  const queryIndex = beforeFragment.indexOf('?');
  if (queryIndex === -1) return trimmed;

  const path = beforeFragment.slice(0, queryIndex);
  const query = beforeFragment.slice(queryIndex + 1);
  const parts = query.split('&');
  const safeParts = parts.filter((part) => {
    const rawName = part.split('=', 1)[0] ?? '';
    let name = rawName;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch {
      // An invalid escape cannot be decoded into one of the sensitive names;
      // compare the original bytes and preserve the segment otherwise.
    }
    return !SENSITIVE_URL_QUERY_PARAMS.has(name.toLowerCase());
  });

  if (safeParts.length === parts.length) {
    return trimmed;
  }
  return `${path}${safeParts.length > 0 ? `?${safeParts.join('&')}` : ''}${fragment}`;
}
