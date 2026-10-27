/**
 * The `product_session` lane of the grant API (ADR 0050): a person's own Oxy
 * session, forwarded by Kaana verbatim, as the credential of a one-shot
 * inference request on `kaana.ai/v1`.
 *
 * ## What it proves, and from where
 *
 * The bearer is verified by the one session verification every authenticated
 * Oxy route uses (`sessionService.validateSession`): signature and expiry, a
 * live session row, the managed-account and supervision checks, and the v2
 * binding of every claim (`sid`, subject, actor, `azp`, device context) against
 * that row. A supervised account is refused there, as on every other lane.
 *
 * The APPLICATION comes from the session ROW (`sessions.application_id` and the
 * credential it was minted for, `sessions.client_id`), never from a claim, a
 * header or a body field. A session the row binds to no application — the
 * ADR 0029 device session every official app shares — names no application,
 * and is refused as `session_unbound`: nothing a request carries could say
 * which app it is without being a claim anyone can make (ADR 0045).
 *
 * The payer is that application's owner, read live. The person is the
 * session's subject account and is attribution only (ADR 0007).
 *
 * Only the grant API calls this. The old edge (`api.oxy.so/v1`) keeps refusing
 * sessions: it is deleted in Kaana ADR 0002's phase 5.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { isCredentialUsable } from '../utils/credentialUsability';
import { isTrustedApplication } from '../utils/trustedApplication';
import type { EdgePrincipal } from './inferenceEdge.service';
import sessionService from './session.service';
import { isSupervised } from './supervisionPolicy.service';

/**
 * `authentication`: the bearer is not a live session (answered
 * `authentication_failed`). `unattributable`: a live session that names no
 * application this lane can charge (answered `permission_denied`).
 */
export type ProductSessionAuthentication =
  | {
      readonly ok: true;
      readonly principal: EdgePrincipal & { readonly lane: 'product_session' };
      /** The session's subject account: the request's attributed user. */
      readonly sessionUserId: string;
    }
  | {
      readonly ok: false;
      readonly refusal: 'authentication' | 'unattributable';
      readonly reason: string;
    };

export async function authenticateProductSession(
  token: string,
): Promise<ProductSessionAuthentication> {
  const validation = await sessionService.validateSession(token);
  if (validation === null) {
    return { ok: false, refusal: 'authentication', reason: 'session_invalid' };
  }
  const identity = validation.token;
  if (identity.applicationId === null || identity.clientId === null) {
    return { ok: false, refusal: 'unattributable', reason: 'session_unbound' };
  }

  const [row] = await getDb()
    .select({
      credentialId: applicationCredentials.id,
      credentialType: applicationCredentials.type,
      credentialStatus: applicationCredentials.status,
      credentialExpiresAt: applicationCredentials.expiresAt,
      environment: applicationCredentials.environment,
      applicationStatus: applications.status,
      ownerAccountId: applications.ownerAccountId,
      type: applications.type,
      isOfficial: applications.isOfficial,
      isInternal: applications.isInternal,
    })
    .from(applicationCredentials)
    .innerJoin(applications, eq(applications.id, applicationCredentials.applicationId))
    .where(
      and(
        eq(applicationCredentials.publicKey, identity.clientId),
        eq(applicationCredentials.applicationId, identity.applicationId),
      ),
    )
    .limit(1);
  if (
    row === undefined ||
    row.applicationStatus !== 'active' ||
    (row.credentialType !== 'public' && row.credentialType !== 'confidential') ||
    !isCredentialUsable({ status: row.credentialStatus, expiresAt: row.credentialExpiresAt })
  ) {
    return { ok: false, refusal: 'unattributable', reason: 'session_application_unavailable' };
  }
  if (await isSupervised(row.ownerAccountId)) {
    return { ok: false, refusal: 'authentication', reason: 'supervised_inference_unsupported' };
  }

  const identityFields = {
    lane: 'product_session' as const,
    applicationId: identity.applicationId,
    credentialId: row.credentialId,
    ownerAccountId: row.ownerAccountId,
    environment: row.environment,
    applicationType: row.type,
    applicationIsInternal: row.isInternal,
  };
  return {
    ok: true,
    sessionUserId: identity.subjectAccountId,
    // A session carries no inference scope: an own application's session is
    // admitted by its reviewed relationship, and an external one holds none.
    principal: isTrustedApplication({
      isOfficial: row.isOfficial,
      isInternal: row.isInternal,
      type: row.type,
    })
      ? { ...identityFields, authority: 'first_party' }
      : { ...identityFields, authority: 'external', scopes: [] },
  };
}
