/** Original operation context forwarded by its verified recipient to Oxy. */
import type { CapabilityTicketClaims, CatalogTool } from '@oxy.so/contracts';
import { verifyCapabilityTicket } from '@oxy.so/core/server';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { capabilityTicketSigningConfig } from '../config/capabilityTicketSigning';
import { capabilityExecutionAuthorizations } from '../db/schema/agency';
import { ForbiddenError } from '../utils/error';
import type { LiveAgencyServicePrincipal } from './agencyServicePrincipal.service';
import { listActiveCapabilityCatalogs } from './capabilityCatalog.service';
import { reauthorizeCapabilityTicket } from './capabilityAuthority.service';
import type { ForegroundRequesterBinding } from './foregroundCapabilityRequester.service';

export interface CapabilityRequesterOperation {
  readonly claims: CapabilityTicketClaims;
  readonly receiverApplicationId: string;
  readonly effect: CatalogTool['effect'];
}

export async function resolveCapabilityRequester(
  ticket: string,
  presenter: LiveAgencyServicePrincipal,
): Promise<ForegroundRequesterBinding | null> {
  if (presenter.authority !== 'first_party' || !ticket || ticket.length > 16384) return null;
  const signing = capabilityTicketSigningConfig();
  const registrations = (await listActiveCapabilityCatalogs()).filter(
    (registration) =>
      registration.source === 'first_party' &&
      registration.registeredByApplicationId === presenter.applicationId,
  );
  let claims: CapabilityTicketClaims | undefined;
  let effect: CatalogTool['effect'] | undefined;
  for (const registration of registrations) {
    try {
      const candidate = verifyCapabilityTicket(ticket, {
        audience: registration.audience,
        issuer: process.env.OXY_API_URL ?? 'https://api.oxy.so',
        resolvePublicKey: (keyId) => (keyId === signing.keyId ? signing.publicKey : undefined),
      });
      if (
        candidate.authority !== 'first_party' ||
        candidate.catalog?.registrationId !== registration.id ||
        candidate.catalog.version !== registration.version ||
        candidate.catalog.digest !== registration.digest ||
        candidate.resource.appId !== registration.appSlug
      )
        continue;
      const tool = registration.catalog.tools.find((entry) => entry.name === candidate.tool);
      if (!tool) continue;
      effect = tool.effect;
      claims = candidate;
      break;
    } catch {
      // An invalid signature or another recipient's audience supplies no context.
    }
  }
  if (!claims || !effect || !(await reauthorizeCapabilityTicket(claims)).allowed) return null;
  const [execution] = await getDb()
    .select({
      authority: capabilityExecutionAuthorizations.authority,
      requesterSessionId: capabilityExecutionAuthorizations.requesterSessionId,
      requesterSessionBindingDigest:
        capabilityExecutionAuthorizations.requesterSessionBindingDigest,
      expiresAt: capabilityExecutionAuthorizations.expiresAt,
    })
    .from(capabilityExecutionAuthorizations)
    .where(eq(capabilityExecutionAuthorizations.id, claims.executionAuthorization.id))
    .limit(1);
  if (
    execution?.authority !== 'first_party' ||
    !execution.requesterSessionId ||
    !execution.requesterSessionBindingDigest
  )
    return null;
  return {
    sessionId: execution.requesterSessionId,
    digest: execution.requesterSessionBindingDigest,
    principalAccountId: claims.requesterAccountId,
    subjectAccountId: claims.resource.effectiveAccountId,
    expiresAt: new Date(Math.min(execution.expiresAt.getTime(), claims.exp * 1000)),
    operation: { claims, receiverApplicationId: presenter.applicationId, effect },
  };
}

/** Operation policy stays attached to nested reads and effects; it is not an app grant. */
export function requireRequesterEffect(
  requester: ForegroundRequesterBinding | undefined,
  effect: 'read' | 'write',
): void {
  if (
    effect === 'write' &&
    requester?.operation &&
    (requester.operation.effect === 'read' || requester.operation.claims.autonomy === 'read_only')
  )
    throw new ForbiddenError('The original operation is read-only.');
}
