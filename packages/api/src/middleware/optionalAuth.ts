/**
 * Optional Authentication Middleware
 * 
 * Similar to authMiddleware but doesn't reject requests without authentication.
 * Sets req.user if a valid token is present, otherwise leaves it undefined.
 * This allows routes to serve public content while still identifying authenticated users.
 */

import type { Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { isAccountIdFormat } from '../utils/validation';
import { authenticateRequestNonBlocking, type AuthenticatedRequest, extractTokenFromRequest } from './authUtils';
import { verifyServiceToken, type ServiceTokenPayload } from './serviceToken';
import { MEDIA_TOKEN_QUERY_PARAM, verifyMediaToken } from '../utils/mediaToken';

/**
 * Optional authentication middleware
 * Attempts to authenticate but doesn't block if authentication fails
 * Uses session-based tokens only
 */
export async function optionalAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user, source } = await authenticateRequestNonBlocking(req, false);
    
    if (user) {
      req.user = user;
      logger.debug('Optional auth: User authenticated', { 
        userId: user._id, 
        source: source || 'unknown'
      });
    }
    
    next();
  } catch (error) {
    logger.error('Optional auth middleware error:', error);
    // Even on error, continue without blocking the request
    next();
  }
}

/**
 * Extract user ID from request (works with both auth and optional auth)
 */
export function getUserId(req: AuthenticatedRequest): string | undefined {
  return req.user?._id;
}

/**
 * Resolve the viewer user id for a MEDIA stream/download request.
 *
 * A browser `<img src>` / `<a download>` cannot send an `Authorization` header,
 * and the zero-cookie session transport gives it no ambient credential either.
 * Private assets therefore carry a SCOPED MEDIA TOKEN in `?mt=`, minted by
 * `GET /assets/:id/url`, `GET /assets/:id/download`, and `POST
 * /assets/batch-access` only after the caller's access was verified. This
 * resolves that token to the viewer it was minted for.
 *
 * Important properties:
 * - The media token authorizes exactly ONE asset. It is accepted only when its
 *   `fid` claim equals `req.params.id` — the file id THIS request is asking
 *   for — so a token minted for asset A cannot open asset B. Binding to the
 *   route param (rather than a fileId variable a caller passes in) keeps the
 *   check tied to the id that actually selects the bytes.
 * - It is signed with a key derived from `ACCESS_TOKEN_SECRET`, disjoint from
 *   the access/service-token key. A session or service token presented in `?mt=`
 *   does not verify, and a media token does not authenticate any other surface.
 * - It expires in ~15 minutes; the short TTL is the revocation story.
 * - Header/session auth always wins; the media token is only a fallback when no
 *   authenticated user is present on the request.
 *
 * Resolving a viewer here NEVER grants access on its own — every caller still
 * runs `assetService.canUserAccessFile` on the resolved viewer.
 *
 * Scope it to media stream/download routes only — never wire it into a global
 * auth middleware (a token-in-URL must not authenticate arbitrary endpoints).
 */
export function getMediaViewerUserId(req: AuthenticatedRequest): string | undefined {
  const sessionUserId = getUserId(req);
  if (sessionUserId) {
    return sessionUserId;
  }

  const rawToken = req.query?.[MEDIA_TOKEN_QUERY_PARAM];
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    return undefined;
  }

  const requestedFileId = req.params?.id;
  if (typeof requestedFileId !== 'string' || requestedFileId.length === 0) {
    return undefined;
  }

  return verifyMediaToken(rawToken, requestedFileId);
}

/**
 * The HTTP header a calling SERVICE sets to name the end-user (viewer) it is
 * acting on behalf of for personalization. Mirrors the platform convention used
 * by `@oxyhq/core` `makeServiceRequest(..., userId)` and `@oxyhq/core/server`.
 */
const OXY_USER_ID_HEADER = 'x-oxy-user-id';

/**
 * Scope a service credential must hold to supply a personalization viewer via
 * `X-Oxy-User-Id`. `user:read` is the minimal existing scope every first-party
 * consumer (e.g. Mention) already holds; it authorises reading public user data
 * — which is exactly what a personalized (re-ordered public profiles) ranking
 * is. It does NOT grant acting-as-user mutation authority.
 */
const VIEWER_DELEGATION_SCOPE = 'user:read';

/**
 * A request that may carry EITHER an optional authenticated user (`req.user`,
 * from a session bearer token) OR a verified service principal (`req.serviceApp`,
 * from a service token). Used by dual-auth optional surfaces such as the
 * recommendation endpoints.
 */
export interface OptionalUserOrServiceRequest extends AuthenticatedRequest {
  serviceApp?: ServiceTokenPayload;
}

/**
 * Optional DUAL authentication for read surfaces that personalize for a viewer.
 *
 * Resolution order, all NON-BLOCKING (an unauthenticated/invalid caller is
 * simply treated as anonymous — the request is never rejected here):
 *  1. If the bearer token is a VALID service token, attach `req.serviceApp`.
 *     The viewer is resolved later from `X-Oxy-User-Id` (see {@link resolveViewerId})
 *     only when the credential holds the delegation scope.
 *  2. Otherwise fall back to the existing optional user-session auth, attaching
 *     `req.user` when a valid session token is present.
 *
 * An INVALID/expired token attaches neither principal → anonymous. A user-token
 * caller never gets `req.serviceApp`, so `X-Oxy-User-Id` is ignored for it
 * (anti-impersonation — see {@link resolveViewerId}).
 */
export async function optionalUserOrServiceAuth(
  req: OptionalUserOrServiceRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractTokenFromRequest(req);

    if (token) {
      const verification = verifyServiceToken(token);
      if (verification.ok) {
        // Valid service token → service principal. Do NOT also attempt user
        // session auth (a service token has no session).
        req.serviceApp = verification.payload;
        logger.debug('Optional dual auth: service principal', {
          appId: verification.payload.appId,
        });
        next();
        return;
      }
      // `not_service` means a verified user/session token (or a token missing
      // service claims). `expired`/`invalid` means it does not verify at all.
      // In both cases fall through to the optional user-session path, which
      // safely yields anonymous when the token is not a valid session token.
    }

    const { user, source } = await authenticateRequestNonBlocking(req, false);
    if (user) {
      req.user = user;
      logger.debug('Optional dual auth: user authenticated', {
        userId: user._id,
        source: source || 'unknown',
      });
    }
    next();
  } catch (error) {
    logger.error('Optional dual auth middleware error:', error);
    // Never block — degrade to anonymous.
    next();
  }
}

/**
 * Resolve the personalization viewer id for a dual-auth request.
 *
 * - USER token: the viewer is the session's own user (`req.user._id`). Any
 *   `X-Oxy-User-Id` header is IGNORED so a user cannot impersonate another.
 * - SERVICE token: the viewer is the `X-Oxy-User-Id` header — but ONLY when the
 *   credential holds {@link VIEWER_DELEGATION_SCOPE} and the header has the
 *   shape of an account id. A service with no/invalid header (or lacking the
 *   scope) resolves to `undefined` → the caller is treated as anonymous/public.
 * - No principal: `undefined` (anonymous).
 *
 * ## Why a shape check SURVIVES the Postgres port here, when its siblings did not
 *
 * The `Types.ObjectId.isValid` guard this replaces rejected the **uuid v7 every
 * account created after the cutover carries** (`@oxyhq/db`'s
 * `generatedId()`), so a post-cutover viewer id arriving in this header resolved
 * to `undefined` and the request SILENTLY DEGRADED TO ANONYMOUS — viewer-scoped
 * visibility filtering (blocks, restricts, private accounts, follow-gated
 * fields) simply stopped applying for the delegating caller. That is a privacy
 * consequence, not an error, which is precisely why nothing surfaced it.
 *
 * It is replaced rather than deleted, unlike the guards in
 * `securityActivityService` and `identityBinding.service`. Those two existed
 * only to stop a malformed string reaching Mongoose as a `CastError`, and a
 * `text` id that matches no row now produces the same "no such user" outcome a
 * malformed one always did. This one is different in kind: it is not a driver
 * artifact but the documented input contract of a CROSS-PRINCIPAL delegation
 * header — one principal asserting an identity ABOUT ANOTHER — whose documented
 * outcome for a value it does not accept is a defined fallback (anonymous),
 * never an error. Keeping the check bounds an arbitrary caller-supplied string
 * before it becomes a viewer identity across every route listed above.
 *
 * {@link isAccountIdFormat} accepts BOTH live id shapes — the pre-cutover
 * 24-char ObjectId hex preserved verbatim and the uuid v7 — so the contract is
 * kept while the bug is not. Do NOT narrow it back to a 24-hex test.
 */
export function resolveViewerId(req: OptionalUserOrServiceRequest): string | undefined {
  // A user session always derives the viewer from its own token. Ignore any
  // X-Oxy-User-Id on a user request to prevent impersonation.
  if (req.user?._id) {
    return req.user._id;
  }

  const serviceApp = req.serviceApp;
  if (!serviceApp) {
    return undefined;
  }

  if (!serviceApp.scopes.includes(VIEWER_DELEGATION_SCOPE)) {
    logger.debug('resolveViewerId: service lacks viewer-delegation scope', {
      appId: serviceApp.appId,
    });
    return undefined;
  }

  const raw = req.headers[OXY_USER_ID_HEADER];
  const viewerId = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  if (!viewerId || !isAccountIdFormat(viewerId)) {
    return undefined;
  }
  return viewerId;
}
