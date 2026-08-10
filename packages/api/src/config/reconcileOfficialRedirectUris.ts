/**
 * Seed official Application redirect URIs when their allowlist is empty.
 *
 * Production drift blocks `POST /auth/oauth/authorize` with
 * "redirect_uri is not registered for this client", breaking password sign-in
 * hand-offs from every first-party app. Explicitly configured allowlists are
 * never modified because each exact callback URI is a security boundary.
 */

import { eq } from 'drizzle-orm';
import { getDb } from './postgres';
import { isDatabaseConnected } from '../utils/dbConnection';
import { applications } from '../db/schema/applications';
import { computeOfficialRedirectUriRepair } from '../utils/redirectUris';
import { logger } from '../utils/logger';
import { isTrustedApplication } from '../utils/trustedApplication';

/**
 * The columns the repair decision reads plus the id it writes back by.
 *
 * Named explicitly rather than `select()`-ing the table, for the same reason
 * the origin registry does: this job decides on six fields and has no business
 * loading the rest of an application row.
 */
const REPAIR_COLUMNS = {
  id: applications.id,
  name: applications.name,
  type: applications.type,
  isOfficial: applications.isOfficial,
  isInternal: applications.isInternal,
  websiteUrl: applications.websiteUrl,
  redirectUris: applications.redirectUris,
} as const;

export async function reconcileOfficialRedirectUris(): Promise<number> {
  // Runs from startup and from `refreshOriginRegistry`, both of which can fire
  // before the pool is open. `getDb()` throws when called early, so the
  // synchronous check is the guard.
  if (!isDatabaseConnected()) {
    return 0;
  }

  const db = getDb();
  const apps = await db
    .select(REPAIR_COLUMNS)
    .from(applications)
    .where(eq(applications.status, 'active'));

  let repaired = 0;
  for (const app of apps) {
    if (!isTrustedApplication(app)) continue;

    // `websiteUrl` is NULL in Postgres where Mongo left it absent. Both mean "no
    // canonical redirect surface declared" and the repair already accepts
    // either, so the NULL travels rather than being laundered into `undefined`.
    const repairedUris = computeOfficialRedirectUriRepair(app.redirectUris, app.websiteUrl);
    if (!repairedUris) continue;

    // A targeted column update replaces Mongoose's load-mutate-`save()`: the
    // document round trip existed only because Mongoose needed a hydrated doc
    // to write one field.
    await db
      .update(applications)
      .set({ redirectUris: repairedUris })
      .where(eq(applications.id, app.id));
    repaired += 1;
    logger.info('[reconcileOfficialRedirectUris] restored redirectUris', {
      name: app.name,
      redirectUris: repairedUris,
    });
  }

  return repaired;
}
