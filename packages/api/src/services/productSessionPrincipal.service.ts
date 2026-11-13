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
 *    desktop client;
 *  - for an APPLICATION TOKEN a platform minted (ADR 0058), its `azp`, which
 *    validation re-checked against the registry and the platform credential —
 *    only when the terms accept `'platform'`. A presented client id must be
 *    that same one.
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
import {
  resolveEconomicTreatment,
  type SharedSessionAttribution,
} from '../config/inferenceEconomicPolicy';
import type { EdgePrincipal } from './inferenceCallerIdentity.service';
import { verifyProductSessionIdentity } from './productSessionIdentity.service';
import { isSupervised } from './supervisionPolicy.service';

export { PRESENTED_SESSION_PREFIX, isPresentedSession } from './productSessionIdentity.service';

export type ProductSessionAuthentication =
  | {
      readonly ok: true;
      readonly principal: EdgePrincipal & { readonly lane: 'product_session' };
      readonly sessionUserId: string;
    }
  | {
      readonly ok: false;
      readonly refusal: 'authentication' | 'unattributable';
      readonly reason: string;
    };

export async function authenticateProductSession(
  credential: string,
  operation?: GrantOperation,
): Promise<ProductSessionAuthentication> {
  // Keep the legacy grant's validation/cache and financial-policy behavior.
  const verified = await verifyProductSessionIdentity(credential, { liveSession: false });
  if (!verified.ok) return verified;
  const { identity } = verified;
  const facts = {
    lane: 'product_session' as const,
    applicationId: identity.applicationId,
    environment: identity.environment,
    applicationType: identity.applicationClass,
    applicationIsInternal: identity.applicationIsInternal,
  };
  if (
    identity.applicationBinding !== 'session' &&
    !acceptsSharedSession(
      facts,
      operation,
      identity.applicationBinding === 'platform' ? 'platform' : 'public_client_id',
    )
  ) {
    return { ok: false, refusal: 'unattributable', reason: 'shared_session_not_accepted' };
  }
  if (await isSupervised(identity.applicationOwnerAccountId)) {
    return { ok: false, refusal: 'authentication', reason: 'supervised_inference_unsupported' };
  }
  const identityFields = {
    ...facts,
    credentialId: identity.credentialId,
    ownerAccountId: identity.applicationOwnerAccountId,
  };
  return {
    ok: true,
    sessionUserId: identity.verifiedRequester.subjectAccountId,
    principal: verified.applicationTrusted
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
  via: SharedSessionAttribution,
): boolean {
  if (operation === undefined) return false;
  const economics = resolveEconomicTreatment(facts, operation);
  return (
    economics.treatment === 'internal_metered' &&
    economics.relationship.lane === 'product_session' &&
    (economics.relationship.sharedSessionAttribution ?? []).includes(via) &&
    economics.relationship.capacity.maxRequestsPerUserPerUtcDay !== undefined
  );
}
