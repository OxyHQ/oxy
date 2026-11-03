/**
 * What every "may the person behind this request …?" read on `OxyServer`
 * shares: which requests carry a person at all, the one failure type and its
 * status mapping, the response envelope, and the positive-only answer cache.
 *
 * The readers built on it answer different questions — keep them apart:
 *
 * | Question | Reader |
 * |---|---|
 * | Does this person hold one of MY application's declared operator keys (`payments.operate`)? | `appPermissionsFor` (`./appPermissions`) |
 * | What may this person do in Oxy account X (an organization, store, channel)? | `accountAccessFor` (`./callerAccess`) |
 * | What may this person do to application A, through the account that owns it (`app:read`, `app:update`)? | `applicationAccessFor` (`./callerAccess`) |
 *
 * ## The outcome mapping, and why an outage is never a "no"
 *
 * Every reader asks Oxy with the request's OWN verified bearer and maps the
 * answer the same way: a 401 means the session is gone (sign in again); a 403
 * or 404 is Oxy's definitive refusal; anything else — a 5xx, a timeout, a
 * malformed body — is UNAVAILABLE, answered 503. Only a positive answer is
 * cached, so a blip can never be remembered as a refusal, and a refusal is
 * never remembered at all (the next request asks again).
 *
 * Node only; reachable solely from `@oxy.so/core/server`.
 */

/** Entries kept per reader; the oldest goes first. */
const CALLER_AUTHORITY_CACHE_MAX = 1000;

/** The request fields a caller-authority read uses — all set by `middleware.auth()`. */
export interface OxyCallerRequest {
  userId?: string | null;
  sessionId?: string | null;
  accessToken?: string;
  /** Set when the request is authenticated by a SERVICE token; such a request carries no person. */
  serviceApp?: unknown;
}

/** The verified person behind a request. */
export interface OxyCallerSession {
  readonly userId: string;
  readonly sessionId: string;
  readonly accessToken: string;
}

/**
 * The person behind `req`, or why there is none: `service` for a request
 * authenticated by a service token (delegated or not — its bearer is the
 * service's, never the person's), `missing` when `middleware.auth()` resolved
 * no user session.
 */
export function readCallerSession(
  req: OxyCallerRequest,
): { ok: true; session: OxyCallerSession } | { ok: false; reason: 'service' | 'missing' } {
  if (req.serviceApp) return { ok: false, reason: 'service' };
  const { userId, sessionId, accessToken } = req;
  if (
    typeof userId !== 'string' ||
    userId.length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    typeof accessToken !== 'string' ||
    !isBearerToken(accessToken)
  ) {
    return { ok: false, reason: 'missing' };
  }
  return { ok: true, session: { userId, sessionId, accessToken } };
}

/** A bearer that can be put in an `Authorization` header unchanged. */
export function isBearerToken(token: string): boolean {
  return token.length > 0 && !/\s/.test(token);
}

/**
 * - `ACCESS_SESSION_REQUIRED` — no person on the request (anonymous, or a
 *   service token), or Oxy refused the session (401). Ask them to sign in.
 * - `ACCESS_DENIED` — Oxy answered "no" (403, 404), or the answer lacks the
 *   permission a gate required. Definitive.
 * - `ACCESS_UNAVAILABLE` — Oxy could not be asked or gave no usable answer.
 *   Fails closed, answered 503, never cached, never a "no".
 */
export type OxyAccessErrorCode = 'ACCESS_SESSION_REQUIRED' | 'ACCESS_DENIED' | 'ACCESS_UNAVAILABLE';

/** The typed failure of `asUser`, `accountAccessFor`, `applicationAccessFor` and their middleware. */
export class OxyAccessError extends Error {
  readonly code: OxyAccessErrorCode;
  /** The permission a gate required, when a gate refused. */
  readonly permission: string | undefined;
  /** The underlying failure (an `OxyApiError`), if any. Never sent to a client. */
  readonly cause: unknown;

  constructor(
    code: OxyAccessErrorCode,
    message: string,
    options: { permission?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'OxyAccessError';
    this.code = code;
    this.permission = options.permission;
    this.cause = options.cause;
  }
}

/** What a refused request is answered with. */
export type OxyAccessDenyStatus = 403 | 404;

/**
 * The status for an {@link OxyAccessError}: `deny` (default `403`) for a
 * refusal; `401` for no session (`404` when `deny` is `404`, so a hidden
 * surface stays hidden from the signed-out too); `503` when Oxy could not say.
 */
export function accessErrorStatus(
  error: OxyAccessError,
  deny: OxyAccessDenyStatus = 403,
): 401 | 403 | 404 | 503 {
  switch (error.code) {
    case 'ACCESS_DENIED':
      return deny;
    case 'ACCESS_SESSION_REQUIRED':
      return deny === 404 ? 404 : 401;
    case 'ACCESS_UNAVAILABLE':
      return 503;
  }
}

/** The response body for a status: the API error envelope (`docs/api-conventions.md`). */
export function authorityErrorBody(status: number): {
  error: { code: string; message: string };
} {
  switch (status) {
    case 401:
      return { error: { code: 'unauthorized', message: 'Authentication required' } };
    case 403:
      return { error: { code: 'forbidden', message: 'Not permitted' } };
    case 404:
      return { error: { code: 'not_found', message: 'Not found' } };
    case 503:
      return { error: { code: 'service_unavailable', message: 'Temporarily unavailable' } };
    default:
      return { error: { code: 'internal_error', message: 'Internal error' } };
  }
}

/** The HTTP status an `OxyApiError` (or anything shaped like one) carries. */
export function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Map a failed caller-bearer read of Oxy to its outcome: 401 → session
 * required, 403/404 → denied, everything else → unavailable.
 */
export function accessFailure(error: unknown, what: string): OxyAccessError {
  const status = errorStatus(error);
  if (status === 401) {
    return new OxyAccessError(
      'ACCESS_SESSION_REQUIRED',
      `Oxy refused the session reading ${what}`,
      {
        cause: error,
      },
    );
  }
  if (status === 403 || status === 404) {
    return new OxyAccessError('ACCESS_DENIED', `Oxy refused ${what} to this session`, {
      cause: error,
    });
  }
  return new OxyAccessError('ACCESS_UNAVAILABLE', `Could not read ${what} from Oxy`, {
    cause: error,
  });
}

interface CacheEntry<T> {
  value: T;
  userId: string;
  startedAt: number;
  expiresAt: number;
}

/**
 * The positive-only answer cache one caller-authority reader keeps, keyed by
 * (resource, session, person). Concurrent identical reads share one lookup; a
 * `fresh` read skips the cache and refreshes it; a slower, OLDER answer never
 * overwrites a newer one (the newer may be the fresh read that saw a
 * revocation); a failure is never stored.
 */
export class CallerAuthorityCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, Promise<T>>();

  /**
   * @param ttlMs How long an answer is reused; `0` disables the cache.
   * @param isAbout Whether a cached answer concerns `userId` beyond the
   *   session's own user (an application-permissions answer names the
   *   resolved operator), for {@link invalidate}.
   */
  constructor(
    private readonly ttlMs: number,
    private readonly isAbout: (value: T, userId: string) => boolean = () => false,
  ) {}

  async read(
    resourceKey: readonly string[],
    session: OxyCallerSession,
    fresh: boolean,
    lookup: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([...resourceKey, session.sessionId, session.userId]);
    const ttl = this.ttlMs;
    if (!fresh && ttl > 0) {
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const inFlight = this.pending.get(key);
      if (inFlight) return inFlight;
    }

    const startedAt = Date.now();
    const answer = lookup().then((value) => {
      if (ttl > 0) this.remember(key, session.userId, value, startedAt, ttl);
      return value;
    });
    if (fresh || ttl <= 0) return answer;

    this.pending.set(key, answer);
    try {
      return await answer;
    } finally {
      if (this.pending.get(key) === answer) this.pending.delete(key);
    }
  }

  /** Forget every answer, or those about one person. */
  invalidate(filter: { userId?: string } = {}): void {
    const { userId } = filter;
    if (!userId) {
      this.entries.clear();
      return;
    }
    for (const [key, entry] of this.entries) {
      if (entry.userId === userId || this.isAbout(entry.value, userId)) this.entries.delete(key);
    }
  }

  private remember(key: string, userId: string, value: T, startedAt: number, ttl: number): void {
    const existing = this.entries.get(key);
    if (existing && existing.startedAt > startedAt) return;
    this.entries.delete(key);
    this.entries.set(key, { value, userId, startedAt, expiresAt: startedAt + ttl });
    if (this.entries.size > CALLER_AUTHORITY_CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

/** A frozen, sorted permission set with `has`. */
export function permissionSet(permissions: readonly string[]): {
  readonly permissions: readonly string[];
  has(permission: string): boolean;
} {
  const sorted = Object.freeze([...new Set(permissions)].sort());
  const held = new Set(sorted);
  return { permissions: sorted, has: (permission: string) => held.has(permission) };
}
