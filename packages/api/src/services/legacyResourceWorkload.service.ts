import { isLegacyWorkloadCohort } from '../config/legacyWorkloadTransition';
import type { ServiceTokenPayload } from '../middleware/serviceToken';
import {
  resolveLiveAgencyServicePrincipal,
  resolveLiveAgencyWorkloadByHandle,
} from './agencyServicePrincipal.service';

/** Temporary reader-first bridge. Input must already have passed signature/audience verification. */
export async function resolveLegacyResourceWorkload(token: ServiceTokenPayload) {
  if (token.audience !== 'oxy-api' || token.authority === 'first_party') return null;
  const binding = await resolveLiveAgencyWorkloadByHandle(token.appId, token.credentialId);
  if (
    !binding?.environmentBound ||
    binding.environment !== token.environment ||
    binding.ownerAccountId !== token.ownerAccountId ||
    !isLegacyWorkloadCohort({
      id: binding.bindingId,
      applicationId: binding.applicationId,
      provider: binding.provider,
      subject: binding.subject,
    })
  )
    return null;
  const principal = await resolveLiveAgencyServicePrincipal(token);
  if (!principal) return null;
  return {
    applicationId: principal.applicationId,
    credentialId: principal.credentialId,
    ownerAccountId: principal.ownerAccountId,
    capabilities: principal.capabilities,
    authority: 'first_party' as const,
  };
}
