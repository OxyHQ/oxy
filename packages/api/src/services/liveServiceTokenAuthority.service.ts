import type { ServiceTokenPayload } from '../middleware/serviceToken';
import {
  resolveLiveAgencyServicePrincipal,
  resolveLiveExternalServicePrincipal,
} from './agencyServicePrincipal.service';
import { hasOrganizationOperatingAuthority } from './organizationAuthority.service';

/** Signature verification precedes this live authority check on every service lane. */
export async function resolveLiveServiceTokenAuthority(token: ServiceTokenPayload) {
  const principal =
    token.authority === 'first_party'
      ? await resolveLiveAgencyServicePrincipal(token)
      : await resolveLiveExternalServicePrincipal(token);
  if (!principal || !(await hasOrganizationOperatingAuthority(token.ownerAccountId))) return null;
  const payload: ServiceTokenPayload =
    token.authority === 'first_party'
      ? token
      : {
          ...token,
          authority: 'external',
          tier: 'external',
          scopes: [...(principal.scopes ?? [])],
        };
  return { principal, payload };
}
