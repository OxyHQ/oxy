/** Identity assertion only. This module makes no inference or spend decision. */
import {
  IDENTITY_VALIDITY_WINDOW_MS,
  inferenceScopeSchema,
  kaanaIdentityAssertionSchema,
  type KaanaIdentityRequest,
} from '@kaana.ai/contracts/internal';
import type { KaanaDataPlaneConfig } from '../config/kaanaDataPlane';
import type { EdgePrincipal } from './inferenceCallerIdentity.service';
import { sha256Hex, signIdentityBody } from './kaanaGrantSigning';

export function createKaanaIdentityAssertion(input: {
  request: KaanaIdentityRequest;
  requestBytes: Buffer;
  principal: EdgePrincipal;
  signing: Pick<KaanaDataPlaneConfig, 'keyId' | 'privateKey'>;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const principal = input.principal;
  const identity = {
    ownerAccountId: principal.ownerAccountId,
    applicationId: principal.applicationId,
    credentialId: principal.credentialId,
    environment: principal.environment,
    lane: principal.lane,
    applicationClass: principal.applicationType,
    applicationIsInternal: principal.applicationIsInternal,
  };
  const assertion = kaanaIdentityAssertionSchema.parse({
    schemaVersion: 1,
    kind: 'identity',
    requestId: input.request.requestId,
    audience: 'kaana.ai',
    requestSha256: sha256Hex(input.requestBytes),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + IDENTITY_VALIDITY_WINDOW_MS).toISOString(),
    principal:
      principal.authority === 'first_party'
        ? { ...identity, authority: 'first_party' }
        : {
            ...identity,
            authority: 'external',
            // The credential's verified inference scopes, never caller input.
            scopes: principal.scopes.filter(
              (scope) => inferenceScopeSchema.safeParse(scope).success,
            ),
          },
    // Attribution only; it does not replace ownerAccountId or authorize user data.
    ...(input.request.onBehalfOfUserId === undefined
      ? {}
      : { userId: input.request.onBehalfOfUserId }),
  });
  const body = Buffer.from(JSON.stringify(assertion));
  return { body, headers: signIdentityBody(input.signing, body, now) };
}
