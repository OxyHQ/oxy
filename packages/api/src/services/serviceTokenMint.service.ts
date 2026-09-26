import type { OxyServiceEnvironment } from '@oxy.so/core/server';

import { signServiceTokenEd25519 } from '../config/serviceTokenSigning';
import type { ServiceTier } from '../middleware/serviceToken';

/**
 * Signing a service token — the one place a `type: 'service'` JWT is produced.
 *
 * Extracted from `POST /auth/service-token` when the workload-identity mint
 * arrived, so the two ways of PROVING who you are (a credential secret, or an
 * attestation from the infrastructure you run on) produce a byte-identical
 * claim set. A second signer would be a second answer to "what is in an Oxy
 * service token", and the copy that drifted would be discovered by a verifier
 * rejecting real traffic.
 *
 * What is deliberately NOT here: resolving the application, deciding the
 * scopes, or checking that the caller may mint at all. Those differ between the
 * two paths and belong to them.
 */

/** One hour. Matches what `/auth/service-token` has always issued. */
export const SERVICE_TOKEN_EXPIRY = 3600;

export interface ServiceTokenClaims {
  appId: string;
  appName: string;
  /**
   * What minted the token. An `ApplicationCredential` id on the credential
   * path, and an attestation handle (`wl_…`) on the workload path — the two are
   * distinguishable by prefix on purpose, so an audit trail never reads a
   * workload mint as a credential that ought to be revocable.
   */
  credentialId: string;
  ownerAccountId: string;
  environment: OxyServiceEnvironment;
  /** Internal (one of Oxy's own applications) or external; see `ServiceTier`. */
  tier: ServiceTier;
  scopes: string[];
}

/**
 * Signs the claims with the Ed25519 service-token key (ADR 0012). There is no
 * symmetric fallback: a process that cannot sign EdDSA did not boot in
 * production, and outside production signs with a per-process ephemeral key.
 */
export function mintServiceToken(claims: ServiceTokenClaims): string {
  const now = Math.floor(Date.now() / 1_000);
  return signServiceTokenEd25519({
    type: 'service' as const,
    ...claims,
    iat: now,
    exp: now + SERVICE_TOKEN_EXPIRY,
    iss: 'oxy-auth',
    aud: 'oxy-api',
  });
}
