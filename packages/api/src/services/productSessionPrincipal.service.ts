/**
 * The `product_session` lane of the grant API (ADR 0050): a person's own Oxy
 * session, forwarded by Kaana verbatim, as the credential of a one-shot
 * inference request on `kaana.ai/v1`.
 *
 * ## What it proves, and from where
 *
 * The session is verified by the one session verification every authenticated
 * Oxy route uses (`sessionService.validateSession`): signature and expiry, a
 * live session row, the managed-account and supervision checks, and the v2
 * binding of every claim (`sid`, subject, actor, `azp`, device context) against
 * that row. A supervised account is refused there, as on every other lane.
 *
 * The APPLICATION is, in this order:
 *
 *  - the session ROW's (`sessions.application_id` and the credential it was
 *    minted for, `sessions.client_id`) when the row names one. A presented
 *    client id must then be that same one;
 *  - for a SHARED device session (ADR 0029: no application on its row), the
 *    application whose registered public client id the caller presented
 *    beside it, resolved from the live public credential row — and only when
 *    that application's reviewed terms are a `product_session` relationship
 *    with a per-person bound that accepts it (`sharedSessionAttribution`,
 *    ADR 0050 option b). The public id names an application; it proves
 *    nothing, so the terms' caps are the bound, as they would be for any
 *    desktop client.
 *
 * The payer is that application's owner, read live. The person is the
 * session's subject account and is attribution only (ADR 0007).
 *
 * ## How a client presents it
 *
 * Kaana forwards the bearer and nothing else of the caller's credentials, so
 * the client id travels inside it: `oxy_session:<public client id>:<access
 * token>`. A bare access token is accepted for an application-bound session.
 *
 * Only the grant API calls this. The old edge (`api.oxy.so/v1`) keeps refusing
 * sessions: it is deleted in Kaana ADR 0002's phase 5.
 */

import type { GrantOperation } from '@kaana.ai/contracts/internal';
import { and, eq } from 'drizzle-orm';
import { resolveEconomicTreatment } from '../config/inferenceEconomicPolicy';
import { getDb } from '../config/postgres';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { isCredentialUsable } from '../utils/credentialUsability';
import { isTrustedApplication } from '../utils/trustedApplication';
import type { EdgePrincipal } from './inferenceEdge.service';
import sessionService from './session.service';
import { isSupervised } from './supervisionPolicy.service';

/** The bearer prefix of a session presented with its application's public client id. */
export const PRESENTED_SESSION_PREFIX = 'oxy_session:';

const PUBLIC_CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

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

export function isPresentedSession(credential: string): boolean {
  return credential.startsWith(PRESENTED_SESSION_PREFIX);
}

type Presented =
  | { readonly ok: true; readonly clientId: string | undefined; readonly token: string }
  | { readonly ok: false };

function parsePresented(credential: string): Presented {
  if (!isPresentedSession(credential)) return { ok: true, clientId: undefined, token: credential };
  const rest = credential.slice(PRESENTED_SESSION_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return { ok: false };
  const clientId = rest.slice(0, separator);
  const token = rest.slice(separator + 1);
  return PUBLIC_CLIENT_ID.test(clientId) && token.length > 0
    ? { ok: true, clientId, token }
    : { ok: false };
}

const unattributable = (reason: string): ProductSessionAuthentication => ({
  ok: false,
  refusal: 'unattributable',
  reason,
});

export async function authenticateProductSession(
  credential: string,
  operation?: GrantOperation,
): Promise<ProductSessionAuthentication> {
  const presented = parsePresented(credential);
  if (!presented.ok) {
    return { ok: false, refusal: 'authentication', reason: 'session_malformed' };
  }
  const validation = await sessionService.validateSession(presented.token);
  if (validation === null) {
    return { ok: false, refusal: 'authentication', reason: 'session_invalid' };
  }
  const identity = validation.token;

  const shared = identity.applicationId === null;
  if (shared && presented.clientId === undefined) return unattributable('session_unbound');
  if (!shared && identity.clientId === null) return unattributable('session_unbound');
  if (!shared && presented.clientId !== undefined && presented.clientId !== identity.clientId) {
    return unattributable('session_client_mismatch');
  }
  const clientId = shared ? presented.clientId : identity.clientId;
  if (clientId === undefined || clientId === null) return unattributable('session_unbound');

  const [row] = await getDb()
    .select({
      applicationId: applications.id,
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
        eq(applicationCredentials.publicKey, clientId),
        ...(identity.applicationId === null
          ? []
          : [eq(applicationCredentials.applicationId, identity.applicationId)]),
      ),
    )
    .limit(1);
  if (
    row === undefined ||
    row.applicationStatus !== 'active' ||
    (shared
      ? row.credentialType !== 'public'
      : row.credentialType !== 'public' && row.credentialType !== 'confidential') ||
    !isCredentialUsable({ status: row.credentialStatus, expiresAt: row.credentialExpiresAt })
  ) {
    return unattributable('session_application_unavailable');
  }

  const facts = {
    lane: 'product_session' as const,
    applicationId: row.applicationId,
    environment: row.environment,
    applicationType: row.type,
    applicationIsInternal: row.isInternal,
  };
  if (shared && !acceptsSharedSession(facts, operation)) {
    return unattributable('shared_session_not_accepted');
  }
  if (await isSupervised(row.ownerAccountId)) {
    return { ok: false, refusal: 'authentication', reason: 'supervised_inference_unsupported' };
  }

  const identityFields = {
    ...facts,
    credentialId: row.credentialId,
    ownerAccountId: row.ownerAccountId,
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

/**
 * Whether the application's reviewed terms accept a shared session presented
 * with its public client id: the same decision the grant makes, on the same
 * live facts, and a per-person bound in it.
 */
function acceptsSharedSession(
  facts: Parameters<typeof resolveEconomicTreatment>[0],
  operation: GrantOperation | undefined,
): boolean {
  if (operation === undefined) return false;
  const economics = resolveEconomicTreatment(facts, operation);
  return (
    economics.treatment === 'internal_metered' &&
    economics.relationship.lane === 'product_session' &&
    economics.relationship.sharedSessionAttribution === 'public_client_id' &&
    economics.relationship.capacity.maxRequestsPerUserPerUtcDay !== undefined
  );
}
