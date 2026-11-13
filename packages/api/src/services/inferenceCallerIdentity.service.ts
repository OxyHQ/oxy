/** Shared caller authentication only; no model, price, pilot or ledger decisions. */
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { isMachineCredentialLaneEnabled } from '../config/rolloutFlags';
import { OXY_API_AUDIENCE, type ServiceTokenAudience } from '../config/serviceTokenAudiences';
import { applications } from '../db/schema/applications';
import { extractTokenFromRequest } from '../middleware/authUtils';
import {
  resolveMachineCredential,
  type MachineCredentialPrincipal,
} from '../middleware/machineCredential';
import { verifyServiceToken } from '../middleware/serviceToken';
import type { ApplicationScope } from '../utils/applicationScopes';
import { machineCredentialTokenPrefix } from '../utils/machineCredentialToken';
import { resolveServiceTokenPrincipal } from './attribution.service';
import { isSupervised } from './supervisionPolicy.service';
import type { InferenceEnvironment } from '@oxy.so/contracts';

/** Live authenticated identity. Only external integrations carry delegated scopes. */
interface EdgePrincipalIdentity {
  readonly applicationId: string;
  readonly credentialId: string;
  readonly ownerAccountId: string;
  readonly environment: InferenceEnvironment;
  readonly applicationType: string | null;
  readonly applicationIsInternal: boolean | null;
}

export type EdgePrincipal = EdgePrincipalIdentity &
  (
    | {
        readonly authority: 'first_party';
        readonly lane: 'service_token' | 'product_session';
        readonly scopes?: never;
      }
    | {
        readonly authority?: 'external';
        readonly lane: 'machine_credential' | 'service_token' | 'product_session';
        readonly scopes: readonly ApplicationScope[];
      }
  );

/** Scope checks apply to external integrations, never authenticated own workloads. */
export function hasInferenceScope(principal: EdgePrincipal, scope: ApplicationScope): boolean {
  return principal.authority === 'first_party' || principal.scopes.includes(scope);
}

export type EdgeAuthentication =
  | {
      readonly ok: true;
      readonly principal: EdgePrincipal;
      /**
       * Present only on the machine lane. Handed back so the router can put it
       * on `req.machineCredential`, which is what the per-credential and
       * per-application limiters of `middleware/machineCredential.ts` key on —
       * those limiters are mounted, not reimplemented.
       */
      readonly machinePrincipal?: MachineCredentialPrincipal;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Authenticate an inference-edge caller.
 *
 * Two lanes, tried in the order that costs least: the machine lane matches on a
 * fixed token shape and refuses anything else without a query, so a service
 * token falls through to `verifyServiceToken` immediately.
 *
 * **A bare `oxy_dk_…` authenticates on neither.** It is an OAuth client id, and
 * the machine lane matches only `token_prefix` — a column no public identifier
 * is ever written to — while the service lane requires a signed JWT. That is not
 * a check that could be forgotten; it is a column it is not in.
 *
 * **The machine lane is closed unless this deployment opens it**
 * (`INFERENCE_MACHINE_CREDENTIAL_AUTH`, `config/rolloutFlags.ts`). The check sits
 * before the lookup rather than after it, so a machine token costs no query while
 * the lane is shut — and it is a lane refusal rather than a fall-through to the
 * service lane, so the log says which lane was closed instead of reporting a
 * malformed JWT.
 *
 * Every refusal is the same answer to the caller. `reason` is for the log.
 */
export async function authenticateEdgeCaller(
  req: Pick<Request, 'headers'>,
): Promise<EdgeAuthentication> {
  const token = extractTokenFromRequest(req);
  if (!token) {
    return { ok: false, reason: 'no_bearer' };
  }
  return authenticateInferenceBearer(token, OXY_API_AUDIENCE);
}

/**
 * The two lanes of {@link authenticateEdgeCaller}, for a bearer already in hand.
 *
 * Shared with the grant API (Kaana ADR 0002), which receives the caller's
 * credential VERBATIM in Kaana's authorization request rather than in a header,
 * and asks for the service-token audience `kaana.ai` where this edge asks for
 * `oxy-api`. Everything else — the machine lane and its rollout flag, the
 * row re-read that makes a revocation immediate — is one implementation, so a
 * credential cannot authenticate on one surface and be refused on the other
 * for any reason but the audience it was minted for.
 */
export async function authenticateInferenceBearer(
  token: string,
  audience: ServiceTokenAudience,
): Promise<EdgeAuthentication> {
  if (machineCredentialTokenPrefix(token) !== null && !isMachineCredentialLaneEnabled()) {
    return { ok: false, reason: 'machine_lane_disabled' };
  }

  const machine = await resolveMachineCredential(token);
  if (machine.ok) {
    if (await isSupervised(machine.principal.ownerAccountId))
      return { ok: false, reason: 'supervised_inference_unsupported' };
    const application = await loadCatalogueApplication(machine.principal.applicationId);
    return {
      ok: true,
      machinePrincipal: machine.principal,
      principal: {
        lane: 'machine_credential',
        authority: 'external',
        applicationId: machine.principal.applicationId,
        credentialId: machine.principal.credentialId,
        ownerAccountId: machine.principal.ownerAccountId,
        environment: machine.principal.environment,
        scopes: machine.principal.scopes,
        applicationType: application?.type ?? null,
        applicationIsInternal: application?.isInternal ?? null,
      },
    };
  }

  if (machine.reason !== 'not_machine_token') {
    return { ok: false, reason: `machine_${machine.reason}` };
  }

  const verification = verifyServiceToken(token, audience);
  if (!verification.ok) {
    return { ok: false, reason: `service_${verification.reason}` };
  }

  // The ROW, not the token's claims, is the authority for the application and
  // owner hop (ADR 0007) — and re-reading it is what makes a revocation
  // effective inside the token's own hour of life. WHICH row depends on which
  // proof minted the token: an `application_credentials` row, or the
  // `application_workload_identities` binding an ADR 0026 attestation selected.
  // `resolveServiceTokenPrincipal` owns that branch for this call site and for
  // the catalogue's, because resolving `credentialId` as a credential id
  // unconditionally answered 401 to every first-party service that had given up
  // its key pair — the edge refusing the exact callers the ADR exists for.
  const resolution = await resolveServiceTokenPrincipal(verification.payload);
  if (resolution.status !== 'resolved') {
    return { ok: false, reason: `service_principal_${resolution.status}` };
  }
  const resolved = resolution.principal;
  const authority =
    resolved.authority === 'first_party'
      ? { authority: 'first_party' as const }
      : resolved.scopes === undefined
        ? null
        : { authority: 'external' as const, scopes: resolved.scopes };
  if (authority === null) {
    return { ok: false, reason: 'service_principal_invalid_external_authority' };
  }

  /**
   * An attested caller reaches the ledger from here, and `credentialId` is the
   * `wl_…` handle the whole way down.
   *
   * It used to stop here: `usage_reservations`, `usage_receipts`,
   * `inference_usage_events` and `inference_usage_daily_rollups` all carry the
   * authenticating identity in `application_credential_id`, `NOT NULL` with a
   * foreign key to `application_credentials.id`, and a handle named no such row —
   * so this function refused `proof === 'workload'` with
   * `workload_attribution_unsupported` to keep a 401 from becoming a 500.
   *
   * The handle now names a real row, materialised from the binding by
   * `services/workloadAttributionIdentity.service.ts` before the token was ever
   * minted. Every foreign key, cascade, join and usage report downstream is
   * unchanged, and nothing on this path needs to know which proof it was — which
   * is the property the single `service_token` lane below already assumed.
   */
  if (await isSupervised(resolved.ownerAccountId))
    return { ok: false, reason: 'supervised_inference_unsupported' };
  const application = await loadCatalogueApplication(resolved.applicationId);

  return {
    ok: true,
    principal: {
      // One lane. An attested token IS a service token — same mint, same
      // signature, same hour — and the proof that selected its row is not a
      // different way of arriving here. Splitting the lane would fork every
      // receipt, limiter key and telemetry row that reads it, to record
      // something `proof` already says.
      lane: 'service_token',
      applicationId: resolved.applicationId,
      credentialId: resolved.credentialId,
      ownerAccountId: resolved.ownerAccountId,
      environment: resolved.environment,
      ...authority,
      applicationType: application?.type ?? null,
      applicationIsInternal: application?.isInternal ?? null,
    },
  };
}

/** The two application columns the catalogue audience is derived from. */
async function loadCatalogueApplication(
  applicationId: string,
): Promise<{ type: string | null; isInternal: boolean | null } | undefined> {
  const [row] = await getDb()
    .select({ type: applications.type, isInternal: applications.isInternal })
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  return row;
}
