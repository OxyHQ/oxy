/**
 * Redirect-uri helpers. Official-app reconciliation may seed an empty
 * allowlist, but must never broaden an explicitly configured allowlist.
 */

/** Union preserving order: existing entries first, then additions, de-duplicated. */
export function unionRedirectUris(
  current: readonly string[] | null | undefined,
  additions: readonly string[],
): string[] {
  return Array.from(new Set([...(current ?? []), ...additions]));
}

/** Exact-match helper — redirect URIs are compared literally, not by prefix. */
export function includesRedirectUri(
  allowlist: readonly string[] | null | undefined,
  uri: string,
): boolean {
  if (!allowlist?.length) return false;
  return allowlist.some((entry) => entry === uri);
}

export function originOfWebsiteUrl(websiteUrl: string): string | null {
  try {
    return new URL(websiteUrl.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Seed an empty trusted-app allowlist from its `websiteUrl` origin. Existing
 * entries are security-sensitive exact callback URIs and must never be changed
 * or supplemented by this background repair.
 */
export function computeOfficialRedirectUriRepair(
  redirectUris: readonly string[] | null | undefined,
  websiteUrl: string | null | undefined,
): string[] | null {
  if (redirectUris?.length) return null;

  const trimmed = websiteUrl?.trim();
  if (!trimmed) return null;

  const origin = originOfWebsiteUrl(trimmed);
  if (!origin) return null;
  return [origin];
}
