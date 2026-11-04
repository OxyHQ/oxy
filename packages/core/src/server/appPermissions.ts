/**
 * Application roles, from the application's side: which of THIS application's
 * declared permissions does the person behind a request hold?
 *
 * Oxy decides who holds an app's operator powers (`docs/auth/application-roles.md`),
 * and the backend asks — so no app keeps a `*_OPERATOR_OXY_USER_IDS` allow-list
 * in its environment. One of Oxy's own applications declares its keys
 * (`payments.operate`, …) in Oxy's first-party registry, each held by roles of
 * the owning organization (ADR 0056); a third-party app declares them in the
 * Console and its owners grant them to people. The answer has the same shape
 * either way.
 *
 * ```ts
 * const oxy = new OxyServer({ baseURL: 'https://api.oxy.so', applicationId: process.env.OXY_APPLICATION_ID });
 *
 * app.use('/internal/payments',
 *   oxy.middleware.auth(),
 *   oxy.middleware.requireAppPermission('payments.operate'),   // 404 to everyone else
 *   paymentsOperatorRouter);
 *
 * const held = await oxy.appPermissionsFor(req);                 // non-middleware form
 * if (held.has('catalog.operate')) { … }
 * ```
 *
 * ## How the answer is obtained, and why it cannot be spoofed
 *
 * The SDK forwards the request's OWN verified bearer — the one
 * `middleware.auth()` already validated against its server-side session — to
 * `GET /applications/:appId/roles/me`. Oxy resolves the HUMAN operator from that
 * session (a person acting as their organization is answered for themselves)
 * and reads the grants live. Nothing the client sends other than the bearer is
 * consulted: no user-id header, no claim the app could be handed by the caller.
 * A request authenticated by a SERVICE token, with or without a delegated
 * `X-Oxy-User-Id`, is refused — an operator power is exercised by a person in
 * a session, never through delegation.
 *
 * ## Caching, and how soon a revocation lands
 *
 * Answers are cached per (application, session, user) for
 * {@link APP_PERMISSIONS_CACHE_TTL_MS} (30 s) by default, so a revoked grant
 * keeps working on THIS backend for at most that long. Pass `fresh: true`
 * (option on both forms) on writes and other irreversible actions: it skips the
 * cache, asks Oxy, and refreshes the entry. `appPermissionsCacheTtlMs: 0` on the
 * server config disables caching. Errors are never cached, and every failure to
 * get an answer DENIES (fails closed).
 *
 * Node only; reachable solely from `@oxy.so/core/server`.
 */

import { applicationRolesMeSchema, isApplicationPermissionKey } from '@oxy.so/contracts';
import { logger } from '../logger';
import {
  authorityErrorBody,
  CallerAuthorityCache,
  errorStatus,
  permissionSet,
  readCallerSession,
  type OxyCallerRequest,
} from './callerAuthority';

/** Default cache lifetime of one answer. */
export const APP_PERMISSIONS_CACHE_TTL_MS = 30_000;

/** What a refused request is answered with. */
export type OxyAppPermissionDenyStatus = 403 | 404;

/**
 * - `APP_PERMISSION_DENIED` — a person in a session, without the permission.
 * - `APP_PERMISSION_SESSION_REQUIRED` — no user session on the request: anonymous,
 *   or authenticated by a service token (delegated or not).
 * - `APP_PERMISSION_UNAVAILABLE` — Oxy could not be asked or gave no usable
 *   answer. Fails closed; answered 503.
 * - `APP_PERMISSION_NOT_CONFIGURED` — this server knows no application id, or
 *   Oxy does not know the one it was given. Answered 500: it is a deploy fault.
 */
export type OxyAppPermissionErrorCode =
  | 'APP_PERMISSION_DENIED'
  | 'APP_PERMISSION_SESSION_REQUIRED'
  | 'APP_PERMISSION_UNAVAILABLE'
  | 'APP_PERMISSION_NOT_CONFIGURED';

/** The typed failure of {@link OxyAppPermissionsResolver.resolve} and the middleware. */
export class OxyAppPermissionError extends Error {
  readonly code: OxyAppPermissionErrorCode;
  /** The permission that was required, when a middleware refused. */
  readonly permission: string | undefined;
  /** The underlying failure (an `OxyApiError` from the roles read), if any. Never sent to a client. */
  readonly cause: unknown;

  constructor(
    code: OxyAppPermissionErrorCode,
    message: string,
    options: { permission?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'OxyAppPermissionError';
    this.code = code;
    this.permission = options.permission;
    this.cause = options.cause;
  }
}

/** What the person behind a request holds for one application. */
export interface OxyAppPermissions {
  readonly applicationId: string;
  /**
   * The HUMAN Oxy resolved from the session — record THIS as the actor in an
   * audit log. It differs from `req.userId` when a person acts as an
   * organization (the session speaks as the org; the operator is the person).
   */
  readonly operatorId: string;
  /** The held keys, sorted. */
  readonly permissions: readonly string[];
  has(permission: string): boolean;
}

export interface AppPermissionsOptions {
  /** Skip the cache and ask Oxy (the answer still refreshes the cache). Use on writes. */
  fresh?: boolean;
  /** Ask about another application than the server's configured one. */
  applicationId?: string;
}

export interface RequireAppPermissionOptions extends AppPermissionsOptions {
  /**
   * What a refused request is answered: `404` (default) answers non-holders —
   * and requests with no session — as if the route did not exist, so an
   * operator surface is not revealed; `403` (and `401` without a session)
   * states the refusal.
   */
  deny?: OxyAppPermissionDenyStatus;
  /**
   * `false` hands the {@link OxyAppPermissionError} to `next(error)` instead of
   * answering, for an app whose own error handler renders refusals. Its
   * `code` says which; {@link appPermissionErrorStatus} gives the status the
   * middleware would have used.
   */
  respond?: boolean;
}

/** The request fields the resolver reads — all set by `middleware.auth()`. */
export interface AppPermissionsRequest extends OxyCallerRequest {
  oxyAppPermissions?: OxyAppPermissions;
}

/** The status the middleware answers an error with, under `deny`. */
export function appPermissionErrorStatus(
  error: OxyAppPermissionError,
  deny: OxyAppPermissionDenyStatus = 404,
): number {
  switch (error.code) {
    case 'APP_PERMISSION_DENIED':
      return deny;
    case 'APP_PERMISSION_SESSION_REQUIRED':
      return deny === 404 ? 404 : 401;
    case 'APP_PERMISSION_UNAVAILABLE':
      return 503;
    case 'APP_PERMISSION_NOT_CONFIGURED':
      return 500;
  }
}

/** The response body for a status: the API error envelope (`docs/api-conventions.md`). */
export const appPermissionErrorBody = authorityErrorBody;

/** Throws at MOUNT time on a key that could never be held — a typo is a deploy error. */
export function assertApplicationPermissionKey(permission: unknown): asserts permission is string {
  if (!isApplicationPermissionKey(permission)) {
    throw new Error(
      `requireAppPermission: ${JSON.stringify(permission)} is not an application permission key (2-4 dot-separated lowercase segments, e.g. payments.operate)`,
    );
  }
}

function heldPermissions(
  applicationId: string,
  operatorId: string,
  permissions: readonly string[],
): OxyAppPermissions {
  return Object.freeze({ applicationId, operatorId, ...permissionSet(permissions) });
}

/** What the resolver needs from the server it belongs to. */
export interface AppPermissionsHost {
  /** `GET /applications/:appId/roles/me` with this bearer, uncached. Rejects with the API error. */
  fetchRolesMe(applicationId: string, accessToken: string): Promise<unknown>;
  /** The configured application id, or the one this server's service token names. */
  defaultApplicationId(): Promise<string | null>;
  readonly ttlMs: number;
}

/**
 * The cache and the lookup behind `OxyServer.appPermissionsFor` and
 * `middleware.requireAppPermission`. One per server.
 */
export class OxyAppPermissionsResolver {
  private readonly cache: CallerAuthorityCache<OxyAppPermissions>;

  constructor(private readonly host: AppPermissionsHost) {
    this.cache = new CallerAuthorityCache<OxyAppPermissions>(
      host.ttlMs,
      (value, userId) => value.operatorId === userId,
    );
  }

  /**
   * What the person behind `req` holds. Throws {@link OxyAppPermissionError};
   * never answers "nothing held" for a failure.
   */
  async resolve(
    req: AppPermissionsRequest,
    options: AppPermissionsOptions = {},
  ): Promise<OxyAppPermissions> {
    const caller = readCallerSession(req);
    if (!caller.ok) {
      throw new OxyAppPermissionError(
        'APP_PERMISSION_SESSION_REQUIRED',
        caller.reason === 'service'
          ? 'Application permissions are held by a person in a session; this request is authenticated by a service token'
          : 'No verified user session on this request; mount middleware.auth() first',
      );
    }

    let applicationId = options.applicationId ?? null;
    if (!applicationId) {
      try {
        applicationId = await this.host.defaultApplicationId();
      } catch (error) {
        throw new OxyAppPermissionError(
          'APP_PERMISSION_NOT_CONFIGURED',
          'Could not determine this application id',
          { cause: error },
        );
      }
    }
    if (!applicationId) {
      throw new OxyAppPermissionError(
        'APP_PERMISSION_NOT_CONFIGURED',
        'No application id: set OxyServerConfig.applicationId, configure service auth, or pass { applicationId }',
      );
    }

    const appId = applicationId;
    return this.cache.read([appId], caller.session, options.fresh === true, () =>
      this.lookup(appId, caller.session.accessToken),
    );
  }

  /**
   * Forget cached answers: every one, or those about one person (matched as
   * either the session's user or the resolved operator).
   */
  invalidate(filter: { userId?: string } = {}): void {
    this.cache.invalidate(filter);
  }

  private async lookup(applicationId: string, accessToken: string): Promise<OxyAppPermissions> {
    let answer: unknown;
    try {
      answer = await this.host.fetchRolesMe(applicationId, accessToken);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 401) {
        throw new OxyAppPermissionError(
          'APP_PERMISSION_SESSION_REQUIRED',
          'Oxy refused the session while resolving application permissions',
          { cause: error },
        );
      }
      if (status === 403) {
        // A session bound to ANOTHER application asked about this one.
        logger.warn('[oxy.appPermissions] Oxy refused the roles read for this session', {
          component: 'auth',
          method: 'appPermissions',
          applicationId,
        });
        throw new OxyAppPermissionError(
          'APP_PERMISSION_DENIED',
          'This session may not read this application’s permissions',
          { cause: error },
        );
      }
      if (status === 404) {
        logger.error(
          `[oxy.appPermissions] Oxy knows no application ${applicationId}; check OxyServerConfig.applicationId`,
          error,
          { component: 'auth', method: 'appPermissions' },
        );
        throw new OxyAppPermissionError(
          'APP_PERMISSION_NOT_CONFIGURED',
          `Oxy knows no application ${applicationId}`,
          { cause: error },
        );
      }
      logger.warn('[oxy.appPermissions] Could not resolve application permissions', {
        component: 'auth',
        method: 'appPermissions',
        applicationId,
        status,
      });
      throw new OxyAppPermissionError(
        'APP_PERMISSION_UNAVAILABLE',
        'Could not resolve application permissions from Oxy',
        { cause: error },
      );
    }

    const parsed = applicationRolesMeSchema.safeParse(answer);
    if (!parsed.success || parsed.data.applicationId !== applicationId) {
      throw new OxyAppPermissionError(
        'APP_PERMISSION_UNAVAILABLE',
        parsed.success
          ? 'Oxy answered for a different application'
          : 'Oxy answered with a malformed permission set',
      );
    }
    return heldPermissions(applicationId, parsed.data.userId, parsed.data.permissions);
  }
}
