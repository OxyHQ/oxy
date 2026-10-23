/**
 * Who a service token is FOR (`aud`), and who may mint one for each audience.
 *
 * Until Kaana ADR 0002 every service token named one audience, `oxy-api`:
 * Oxy's own API was the only resource server that accepted them. The ADR adds
 * two, both minted by the same two mints (`POST /auth/service-token` and the
 * ADR 0026 workload mint) and both refused everywhere else:
 *
 *  - {@link KAANA_PUBLIC_AUDIENCE} — a service's credential for
 *    `https://kaana.ai/v1` (decision 6). Kaana never interprets it: it forwards
 *    it, verbatim, to Oxy's grant API, which verifies it for THIS audience
 *    only. Kaana refuses `oxy-api`, and Oxy's API refuses `kaana.ai`, so a
 *    token stolen from one surface is not a key to the other.
 *  - {@link KAANA_CONTROL_AUDIENCE} — Kaana's own workload token for
 *    `/internal/kaana/v1/*` (grants and settlements). Only the Kaana
 *    application may mint it, so no other first-party service holding a valid
 *    `oxy-api` token can ask for a grant or deliver a settlement.
 *
 * The audience is chosen at mint time and is the only thing a caller chooses:
 * the claims, scopes and lifetime are decided exactly as before.
 */

import { KAANA_APPLICATION_ID } from '../scripts/seedOxyApplicationsSpecs';

/** Oxy's own API — every service token minted before Kaana ADR 0002. */
export const OXY_API_AUDIENCE = 'oxy-api';

/** `https://kaana.ai/v1`, verified by Oxy's grant API on Kaana's behalf. */
export const KAANA_PUBLIC_AUDIENCE = 'kaana.ai';

/** Kaana's workload calling `/internal/kaana/v1/*`. */
export const KAANA_CONTROL_AUDIENCE = 'oxy-api:kaana-control';

export const SERVICE_TOKEN_AUDIENCES = [
  OXY_API_AUDIENCE,
  KAANA_PUBLIC_AUDIENCE,
  KAANA_CONTROL_AUDIENCE,
] as const;

export type ServiceTokenAudience =
  | (typeof SERVICE_TOKEN_AUDIENCES)[number]
  | `oxy-service:${string}`;

/** A receiving application is registered by its immutable Oxy id, never its hostname. */
export function serviceAudienceApplicationId(audience: string): string | null {
  const match =
    /^oxy-service:([a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(
      audience,
    );
  return match?.[1] ?? null;
}

/** The application that alone may mint {@link KAANA_CONTROL_AUDIENCE}. Pinned, never by name. */
export const KAANA_CONTROL_APPLICATION_ID = KAANA_APPLICATION_ID;

export type AudienceRefusal = 'kaana_control_reserved' | 'kaana_requires_inference_scope';

/**
 * Whether `applicationId`, about to be minted `scopes`, may hold a token for
 * `audience`. `undefined` admits; otherwise the reason it does not.
 *
 * `kaana.ai` needs `inference:invoke` among the MINTED scopes (credential ∩
 * application, or binding ∩ application): a token that can never pass the grant
 * API's scope check is refused at the mint, where the caller can fix it.
 */
export function audienceRefusal(
  audience: ServiceTokenAudience,
  applicationId: string,
  scopes: readonly string[],
): AudienceRefusal | undefined {
  if (audience === KAANA_CONTROL_AUDIENCE && applicationId !== KAANA_CONTROL_APPLICATION_ID) {
    return 'kaana_control_reserved';
  }
  if (audience === KAANA_PUBLIC_AUDIENCE && !scopes.includes('inference:invoke')) {
    return 'kaana_requires_inference_scope';
  }
  return undefined;
}
