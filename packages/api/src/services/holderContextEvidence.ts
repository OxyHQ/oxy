import type { HolderContextEvidenceV1Response } from '@oxy.so/contracts';
import type { AccessTokenIdentity, SessionTokenPayload } from '../utils/sessionUtils';
import { ServiceUnavailableError } from '../utils/error';

export type HolderContextEvidenceResult =
  | { status: 'ok'; evidence: HolderContextEvidenceV1Response }
  | { status: 'invalid_bearer' }
  | { status: 'unsupported_bearer' }
  | { status: 'binding_unavailable' };

/** The token was verified by the live session service, not decoded by a caller. */
export interface VerifiedHolderBearer {
  token: AccessTokenIdentity;
  payload: SessionTokenPayload;
}

/** Database data plus writer state from the same statement and snapshot. */
export interface HolderContextObservation {
  inRecovery: boolean;
  credentialId: string | null;
  deviceSessionId: string | null;
  revision: number | null;
  contextId: string | null;
  actorId: string | null;
  accountId: string | null;
  sessionId: string | null;
  personSessionId: string | null;
  accessToken: string | null;
  sessionExpiresAt: Date | null;
}

export function classifyHolderBearer(
  verified: VerifiedHolderBearer,
  deviceId: string,
): 'valid' | 'invalid_bearer' | 'unsupported_bearer' | 'binding_unavailable' {
  const { token, payload } = verified;
  if (
    token.version !== 2 ||
    token.applicationId !== null ||
    token.clientId !== null ||
    token.deviceSessionId === null ||
    token.deviceContextId === null ||
    token.principalUserId !== token.subjectAccountId
  )
    return 'unsupported_bearer';
  if (
    payload.userId !== token.subjectAccountId ||
    payload.sessionId !== token.sessionId ||
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp)
  )
    return 'invalid_bearer';
  if (payload.deviceId !== deviceId) return 'binding_unavailable';
  return 'valid';
}

export function holderContextEvidence(
  verified: VerifiedHolderBearer,
  deviceId: string,
  accessToken: string,
  observation: HolderContextObservation | undefined,
): HolderContextEvidenceResult {
  if (!observation || observation.inRecovery !== false)
    throw new ServiceUnavailableError('Session authority is not a writable primary');
  const { token, payload } = verified;
  if (
    !observation.credentialId ||
    !observation.deviceSessionId ||
    !observation.contextId ||
    !observation.actorId ||
    !observation.accountId ||
    !observation.sessionId ||
    !observation.sessionExpiresAt ||
    observation.revision === null ||
    observation.accessToken !== accessToken ||
    observation.deviceSessionId !== token.deviceSessionId ||
    observation.contextId !== token.deviceContextId ||
    observation.actorId !== token.principalUserId ||
    observation.accountId !== token.subjectAccountId ||
    observation.sessionId !== token.sessionId ||
    observation.personSessionId !== token.sessionId
  )
    return { status: 'binding_unavailable' };

  const expiresAt = new Date(
    Math.min((payload.exp ?? Number.NaN) * 1000, observation.sessionExpiresAt.getTime()),
  );
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
    return { status: 'invalid_bearer' };
  return {
    status: 'ok',
    evidence: {
      version: 1,
      deviceId,
      deviceSessionId: observation.deviceSessionId,
      revision: observation.revision,
      contextId: observation.contextId,
      actorId: observation.actorId,
      accountId: observation.accountId,
      sessionId: observation.sessionId,
      expiresAt: expiresAt.toISOString(),
    },
  };
}
