import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OxyServices } from '../OxyServices';
import { OXY_SERVICE_ENVIRONMENTS, type OxyServiceEnvironment } from '../utils/oxyServiceEnvironment';

export { OXY_SERVICE_ENVIRONMENTS };
export type { OxyServiceEnvironment };

export interface OxyRequestUser {
  id: string;
  _id?: string;
  username?: string;
  email?: string;
  avatar?: string;
  [key: string]: unknown;
}

export interface OxyServiceAppContext {
  appId: string;
  appName: string;
  scopes: string[];
  credentialId: string;
  /**
   * The Oxy account that owns `appId` and is financially responsible for it.
   * Read off the VERIFIED service-token claim set — never a user id, and never
   * the delegated `X-Oxy-User-Id` (ADR 0007).
   */
  ownerAccountId: string;
  environment: OxyServiceEnvironment;
}

export interface OxyServiceActingAsContext {
  userId: string;
  scopes: string[];
}

export interface OxyAuthRequest extends Request {
  userId?: string | null;
  user?: OxyRequestUser | null;
  accessToken?: string;
  sessionId?: string | null;
  serviceApp?: OxyServiceAppContext;
  serviceActingAs?: OxyServiceActingAsContext;
}

export interface OxyAuthenticatedRequest extends OxyAuthRequest {
  userId: string;
  user: OxyRequestUser;
}

export interface OxyAuthMiddlewareOptions {
  /**
   * Options forwarded to `oxy.auth()`.
   * `optional` is forced to `true` by the composed helpers so route guards can
   * produce one consistent 401 shape.
   */
  auth?: Parameters<OxyServices['auth']>[0];
}

function normalizeId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function ensureUser(req: OxyAuthRequest, userId: string): OxyRequestUser {
  const existing = req.user;
  if (existing) {
    const user = {
      ...existing,
      id: normalizeId(existing.id) ?? normalizeId(existing._id) ?? userId,
    };
    req.user = user;
    return user;
  }

  const user = { id: userId };
  req.user = user;
  return user;
}

export function getOxyUserId(req: Request): string | null {
  const authReq = req as OxyAuthRequest;
  return (
    normalizeId(authReq.userId) ??
    normalizeId(authReq.user?.id) ??
    normalizeId(authReq.user?._id)
  );
}

export function isOxyAuthenticated(req: Request): req is OxyAuthenticatedRequest {
  return getOxyUserId(req) !== null;
}

/**
 * The principal a request is CHARGED to, and the identifiers a receipt needs.
 *
 * Every field is read from the verified service-token claim set. It is an
 * OBJECT, not a string, and that is the point: `getOxyUserId` returns a
 * `string | null`, so a delegated end-user id cannot be passed anywhere an
 * `OxyBillingPrincipal` is expected. The confusion ADR 0007 forbids —
 * attributing spend to the person a service is acting for rather than to the
 * service's own account — stops being a code-review question and becomes a
 * compile error.
 *
 * `scopes` are the effective scopes minted into the token (credential ∩
 * application). Nothing re-intersects them here.
 */
export interface OxyBillingPrincipal {
  /** `applications.owner_account_id` — the financially responsible account. */
  readonly accountId: string;
  readonly applicationId: string;
  readonly credentialId: string;
  readonly environment: OxyServiceEnvironment;
  readonly scopes: readonly string[];
}

/**
 * The full canonical attribution of ADR 0007 for a request: the billing
 * principal PLUS the optional delegated end user.
 *
 * `delegatedUserId` is named for what it is. It answers "on whose behalf" and
 * is absent for a machine credential acting for itself — its absence is normal,
 * and nothing may synthesize one. If removing it would change what any account
 * is charged, the code reading it is wrong.
 */
export interface OxyRequestAttribution extends OxyBillingPrincipal {
  readonly delegatedUserId: string | null;
}

/**
 * The billing principal of a request, or `null` when the request carries no
 * verified service principal (an ordinary user session is not a billable
 * machine principal — its account is resolved from the account graph, not from
 * a token claim).
 *
 * Reads `req.serviceApp` and NOTHING else: not `req.userId`, not `req.user`,
 * not `req.serviceActingAs`. That exclusivity is the invariant this function
 * exists to hold, and `serviceTokenAttribution.test.ts` mutation-tests it.
 *
 * **It answers for the SERVICE-TOKEN lane only.** The API's machine-credential
 * lane (`oxy_sk_*`, issue #972 §2.3) resolves the same five facts into its own
 * `req.machineCredential`, deliberately never `req.serviceApp` — populating the
 * latter would hand a self-serve third-party credential the lane that only
 * platform-trusted applications may enter. So a machine-credential request has
 * no billing principal HERE and resolves `null`, which fails closed: the caller
 * must handle it, and `getRequiredOxyBillingPrincipal` throws rather than
 * charging anyone. One accessor answering for both lanes belongs to the public
 * inference edge that has to admit both, and it needs the machine principal's
 * shape to move into this package first.
 */
export function getOxyBillingPrincipal(req: Request): OxyBillingPrincipal | null {
  const serviceApp = (req as OxyAuthRequest).serviceApp;
  if (!serviceApp) {
    return null;
  }
  const accountId = normalizeId(serviceApp.ownerAccountId);
  const applicationId = normalizeId(serviceApp.appId);
  const credentialId = normalizeId(serviceApp.credentialId);
  if (!accountId || !applicationId || !credentialId) {
    return null;
  }
  return {
    accountId,
    applicationId,
    credentialId,
    environment: serviceApp.environment,
    scopes: serviceApp.scopes,
  };
}

/**
 * {@link getOxyBillingPrincipal}, throwing when the request has none. Use on
 * routes that have already required a service token.
 */
export function getRequiredOxyBillingPrincipal(req: Request): OxyBillingPrincipal {
  const principal = getOxyBillingPrincipal(req);
  if (!principal) {
    throw new Error('Request has no verified Oxy service principal');
  }
  return principal;
}

/**
 * The delegated end user of a service request, or `null`.
 *
 * Deliberately reads `req.serviceActingAs` — the grant-verified delegation —
 * and not `req.userId`, which on a non-service request is the caller's own
 * session identity and is not a delegation at all.
 */
export function getOxyDelegatedUserId(req: Request): string | null {
  return normalizeId((req as OxyAuthRequest).serviceActingAs?.userId);
}

/**
 * The whole attribution tuple for a service request: who pays, which
 * application and credential, and optionally on whose behalf.
 */
export function getOxyRequestAttribution(req: Request): OxyRequestAttribution | null {
  const principal = getOxyBillingPrincipal(req);
  if (!principal) {
    return null;
  }
  return { ...principal, delegatedUserId: getOxyDelegatedUserId(req) };
}

export function getRequiredOxyUserId(req: Request): string {
  const userId = getOxyUserId(req);
  if (!userId) {
    throw new Error('User not authenticated');
  }
  return userId;
}

export function requireOxyAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = getOxyUserId(req);
  if (!userId) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
    return;
  }

  const authReq = req as OxyAuthRequest;
  authReq.userId = userId;
  ensureUser(authReq, userId);
  next();
}

export function createOptionalOxyAuth(
  oxy: OxyServices,
  options: OxyAuthMiddlewareOptions = {},
): RequestHandler {
  const resolveSession = oxy.auth({ ...options.auth, optional: true });

  return (req, res, next) => {
    if (getOxyUserId(req)) {
      next();
      return;
    }

    resolveSession(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      next();
    });
  };
}

export function createOxyAuthMiddleware(
  oxy: OxyServices,
  options: OxyAuthMiddlewareOptions = {},
): RequestHandler {
  const resolveSession = createOptionalOxyAuth(oxy, options);

  return (req, res, next) => {
    if (getOxyUserId(req)) {
      requireOxyAuth(req, res, next);
      return;
    }

    resolveSession(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }
      requireOxyAuth(req, res, next);
    });
  };
}
