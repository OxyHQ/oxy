/**
 * Where a finished linking flow may send the browser.
 *
 * The callback redirects with `?linked=<id>` or `?error=<code>`, so an
 * unvalidated `returnTo` would be an open redirect on Oxy's own API host. The
 * rule is the OAuth one: `returnTo` must be a redirect URI REGISTERED on the
 * calling application, compared with the single authority for that question
 * (`isAllowedRedirectUri` — exact match; only a bare `https://host/` folds to
 * its origin). The application is named by its public `clientId`, resolved
 * through the same usable-credential rule as `/auth/oauth/authorize`.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { isAllowedRedirectUri } from '../../utils/oauthRedirect';
import { resolveApplicationIdFromClientId } from '../../utils/resolveApplicationFromClientId';

export type ReturnToResolution =
  | { ok: true; clientApplicationId: string | null; returnTo: string | null }
  | { ok: false; reason: string };

export async function resolveReturnTo(clientId: string | undefined, returnTo: string | undefined): Promise<ReturnToResolution> {
  if (returnTo === undefined) return { ok: true, clientApplicationId: null, returnTo: null };
  if (!clientId) return { ok: false, reason: 'returnTo requires clientId' };
  const applicationId = await resolveApplicationIdFromClientId(clientId);
  if (!applicationId) return { ok: false, reason: 'Invalid client' };
  const [app] = await getDb()
    .select({ redirectUris: applications.redirectUris })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app || !isAllowedRedirectUri({ redirectUris: app.redirectUris }, returnTo)) {
    return { ok: false, reason: 'returnTo is not a redirect URI registered for this client' };
  }
  return { ok: true, clientApplicationId: applicationId, returnTo };
}

/** `returnTo` with one query parameter added (existing query kept). */
export function withQueryParam(returnTo: string, key: string, value: string): string {
  const url = new URL(returnTo);
  url.searchParams.set(key, value);
  return url.toString();
}
