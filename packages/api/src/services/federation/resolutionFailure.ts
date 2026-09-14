import { logger } from '../../utils/logger';

export type ResolutionPhase = 'actor_fetch' | 'actor_document' | 'identity_policy' | 'webfinger_fetch' | 'webfinger_document';
export type ResolutionFailureReason = 'transport_unavailable' | 'http_status' | 'unreadable_document' | 'missing_actor_fields' | 'actor_id_mismatch' | 'identity_policy_rejected' | 'missing_self_link' | 'unexpected_failure' | 'invalid_selector';
export interface ResolutionFailure {
  operation: 'resolve_external_identity';
  phase: ResolutionPhase;
  reason: ResolutionFailureReason;
  actorUri?: string;
  acct?: string;
  httpStatus?: number;
}
export type ActorProfileResult<T> = { ok: true; profile: T } | { ok: false; failure: ResolutionFailure };

/** Public selectors only: never retain URL credentials, queries, or fragments. */
export function safeActorSelector(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return `${url.origin}${url.pathname}`;
  } catch { return undefined; }
}

export function resolutionFailure(
  phase: ResolutionPhase,
  reason: ResolutionFailureReason,
  selector: { actorUri?: string; acct?: string },
  httpStatus?: number,
): { ok: false; failure: ResolutionFailure } {
  const actorUri = selector.actorUri ? safeActorSelector(selector.actorUri) : undefined;
  const acct = selector.acct && /^[a-z0-9_.+-]+@[a-z0-9.-]+$/i.test(selector.acct) ? selector.acct : undefined;
  const failure: ResolutionFailure = {
    operation: 'resolve_external_identity', phase, reason,
    ...(actorUri ? { actorUri } : {}), ...(acct ? { acct } : {}),
    ...(Number.isInteger(httpStatus) && httpStatus !== undefined && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
  };
  logger.warn('Federation identity resolution failed', { ...failure });
  return { ok: false, failure };
}
