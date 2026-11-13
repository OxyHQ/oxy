/** Identity assertion only. This module makes no inference or spend decision. */
import {
  IDENTITY_VALIDITY_WINDOW_MS,
  inferenceScopeSchema,
  kaanaIdentityAssertionSchema,
  type KaanaIdentityRequest,
} from '@kaana.ai/contracts/internal';
import type { KaanaDataPlaneConfig } from '../config/kaanaDataPlane';
import { authenticateInferenceBearer, type EdgePrincipal } from './inferenceCallerIdentity.service';
import { KAANA_PUBLIC_AUDIENCE } from '../config/serviceTokenAudiences';
import {
  isPresentedSession,
  verifyProductSessionIdentity,
  type ProductSessionIdentity,
} from './productSessionIdentity.service';
import { sha256Hex, signIdentityBody } from './kaanaGrantSigning';

export type KaanaCallerIdentity = EdgePrincipal | ProductSessionIdentity;

/** Classify by verified credential kind; never fall back after an auth failure. */
export async function authenticateKaanaIdentityCaller(
  credential: string,
): Promise<
  | { readonly ok: true; readonly principal: KaanaCallerIdentity }
  | { readonly ok: false; readonly refusal: 'authentication' | 'unattributable' }
> {
  if (!isPresentedSession(credential)) {
    const bearer = await authenticateInferenceBearer(credential, KAANA_PUBLIC_AUDIENCE);
    if (bearer.ok) return { ok: true, principal: bearer.principal };
    // Only a token positively classified as not a service token may be a bare
    // app-bound session. Revocation, signature, audience and scope failures stop.
    if (bearer.reason !== 'service_not_service') return { ok: false, refusal: 'authentication' };
  }
  const session = await verifyProductSessionIdentity(credential);
  return session.ok ? { ok: true, principal: session.identity } : session;
}

export function createKaanaIdentityAssertion(input: {
  request: KaanaIdentityRequest;
  requestBytes: Buffer;
  principal: KaanaCallerIdentity;
  signing: Pick<KaanaDataPlaneConfig, 'keyId' | 'privateKey'>;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const principal = input.principal;
  let assertedPrincipal: unknown;
  let userId: string | undefined = input.request.onBehalfOfUserId;
  if (principal.authority === 'session') {
    userId = principal.verifiedRequester.subjectAccountId;
    if (input.request.onBehalfOfUserId !== undefined && input.request.onBehalfOfUserId !== userId) {
      throw new Error('Session attribution does not match the verified subject');
    }
    assertedPrincipal = principal;
  } else {
    const identity = {
      ownerAccountId: principal.ownerAccountId,
      applicationId: principal.applicationId,
      credentialId: principal.credentialId,
      environment: principal.environment,
      lane: principal.lane,
      applicationClass: principal.applicationType,
      applicationIsInternal: principal.applicationIsInternal,
    };
    assertedPrincipal =
      principal.authority === 'first_party'
        ? { ...identity, authority: 'first_party' }
        : {
            ...identity,
            authority: 'external',
            // The credential's verified inference scopes, never caller input.
            scopes: principal.scopes.filter(
              (scope) => inferenceScopeSchema.safeParse(scope).success,
            ),
          };
  }
  const assertion = kaanaIdentityAssertionSchema.parse({
    schemaVersion: 1,
    kind: 'identity',
    requestId: input.request.requestId,
    audience: 'kaana.ai',
    requestSha256: sha256Hex(input.requestBytes),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + IDENTITY_VALIDITY_WINDOW_MS).toISOString(),
    principal: assertedPrincipal,
    // Workloads/keys carry attribution; sessions carry their verified subject.
    ...(userId === undefined ? {} : { userId }),
  });
  const body = Buffer.from(JSON.stringify(assertion));
  return { body, headers: signIdentityBody(input.signing, body, now) };
}
