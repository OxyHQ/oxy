/**
 * Where a finished linking flow may send the browser.
 *
 * The callback redirects with `?link_code=<code>` or `?link_error=<code>`, so an
 * unvalidated `returnTo` would be an open redirect on Oxy's own API host. The
 * rule is the OAuth one: `returnTo` must be a redirect URI REGISTERED on the
 * calling application, compared with the single authority for that question
 * (`isAllowedRedirectUri` — exact match; only a bare `https://host/` folds to
 * its origin). The application is named by its public `clientId`, resolved
 * through the same usable-credential rule as `/auth/oauth/authorize`.
 *
 * The application must also be TRUSTED (staff-controlled first-party). The
 * one-time `link_code` lands at `returnTo`, and the flow is only safe if it
 * lands in the browser of whoever approved at the other network: a
 * self-registered app would let an attacker start a flow with their own
 * `returnTo`, have a victim approve it, and complete the link as themselves.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { isAllowedRedirectUri } from '../../utils/oauthRedirect';
import { isTrustedApplication } from '../../utils/trustedApplication';
import { resolveApplicationIdFromClientId } from '../../utils/resolveApplicationFromClientId';

export type ReturnToResolution =
  | { ok: true; clientApplicationId: string; returnTo: string }
  | { ok: false; reason: string };

export async function resolveReturnTo(clientId: string, returnTo: string): Promise<ReturnToResolution> {
  const applicationId = await resolveApplicationIdFromClientId(clientId);
  if (!applicationId) return { ok: false, reason: 'Invalid client' };
  const [app] = await getDb()
    .select({
      redirectUris: applications.redirectUris,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!app || !isTrustedApplication(app)) return { ok: false, reason: 'Linking accounts is only available to Oxy applications' };
  if (!isAllowedRedirectUri({ redirectUris: app.redirectUris }, returnTo)) {
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
