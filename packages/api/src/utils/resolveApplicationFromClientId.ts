/**
 * Resolve an OAuth `clientId` (`ApplicationCredential.publicKey`) to the id of
 * the active `Application` it belongs to. Returns null when the credential is
 * unknown, revoked / out of its rotation grace, or its application is not
 * active.
 *
 * ## What the port changes, and why it is not cosmetic
 *
 * The Mongoose version was two round trips —
 * `ApplicationCredential.findOne({publicKey})` then
 * `Application.findById(credential.applicationId)` — and the second one CAST its
 * argument. `findById` throws a `CastError` on anything that is not 24-char hex,
 * so for an application whose id is the **uuid v7 every row minted after the
 * Postgres cutover carries** (`@oxyhq/db`'s `generatedId()`) this
 * function did not return null: it THREW, out of a helper whose whole contract
 * is "null when it does not resolve". `POST /notifications/push-token` answers
 * that with a 500 instead of its documented 400, and `emailPushDelivery` loses
 * the whole inbox push for that identity.
 *
 * Here both halves are ONE join against `text` ids, so a value that names no
 * application is a value that matches no row — the documented null — in either
 * id shape. `application_credentials.public_key` is UNIQUE, so the join can
 * produce at most one row.
 *
 * The return type is the application id as a **string**, not a
 * `mongoose.Types.ObjectId`: there is no ObjectId left to construct, and the
 * value has to survive being a uuid.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { isCredentialUsable } from './credentialUsability';

export async function resolveApplicationIdFromClientId(
  clientId: string,
): Promise<string | null> {
  const [row] = await getDb()
    .select({
      applicationId: applications.id,
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .where(
      and(
        eq(applicationCredentials.publicKey, clientId),
        eq(applications.status, 'active'),
      ),
    )
    .limit(1);

  // The rotation-grace predicate stays in application code rather than becoming
  // a SQL clause: `utils/credentialUsability.ts` is the single source of truth
  // shared with OAuth authorize, OAuth token and the service-token mint, and a
  // second spelling of it here is exactly how those four drift apart.
  if (!row || !isCredentialUsable(row)) {
    return null;
  }

  return row.applicationId;
}
