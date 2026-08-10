/** Redirect-uri helpers for converging official apps to canonical origins. */

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
 * Converge a trusted web app's redirect allowlist to its declared website
 * origin. Redirect URIs are an authorization boundary, so entries which are
 * no longer canonical must be revoked rather than retained indefinitely.
 */
export function computeOfficialRedirectUriRepair(
  redirectUris: readonly string[] | null | undefined,
  websiteUrl: string | null | undefined,
): string[] | null {
  const trimmed = websiteUrl?.trim();
  if (!trimmed) return null;

  const origin = originOfWebsiteUrl(trimmed);
  if (!origin) return null;
  if (redirectUris?.length === 1 && includesRedirectUri(redirectUris, origin)) return null;

  return [origin];
}
