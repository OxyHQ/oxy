/**
 * Shared Authentication Utilities
 * 
 * Common functions used by both authMiddleware and optionalAuthMiddleware
 * to avoid code duplication and ensure consistency
 */

import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import sessionService from '../services/session.service';
import type { AccountDocument } from '../services/user.service';

export interface TokenDecoded {
  userId?: string;
  id?: string;
  _id?: string;
  sessionId?: string;
  /**
   * The central `DeviceSession.deviceId` the token was minted for. A declared
   * claim rather than an index-signature read, because `sessionDevice.ts` and
   * `accounts.ts` resolve the caller's device from it — under the old
   * `[key: string]: any` those reads were unchecked.
   */
  deviceId?: string;
  exp?: number;
  [key: string]: unknown;
}

/**
 * The optional-auth request identity.
 *
 * `_id` is the account id — the SAME field, with the same meaning, that
 * `AuthRequest.user._id` carries (see `middleware/auth.ts` for why that is the
 * unambiguous one). `id` is deliberately absent: `normalizeUser` has always
 * dropped it, because on an unauthenticated-optional path there is no handler
 * pinning it and the document's own `id` is `publicKey ?? _id`.
 */
export interface NormalizedUser {
  _id: string;
  [key: string]: unknown;
}

export interface AuthenticatedRequest extends Request {
  user?: NormalizedUser;
}

/**
 * Extract bearer token from the Authorization header.
 */
export function extractTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return undefined;
}

/**
 * Resolve an OAuth access token for the userinfo endpoint.
 *
 * OIDC Core §5.3.1 requires POST support; clients may send the token in the
 * `Authorization` header (preferred) or as `access_token` in a form body.
 * Query-string tokens are explicitly rejected by the userinfo handler.
 */
export function extractOAuthUserinfoToken(req: Request): string | undefined {
  const headerToken = extractTokenFromRequest(req);
  if (headerToken) {
    return headerToken;
  }
  if (req.method !== 'POST') {
    return undefined;
  }
  const body = req.body as { access_token?: unknown } | undefined;
  const bodyToken = body?.access_token;
  return typeof bodyToken === 'string' && bodyToken.length > 0 ? bodyToken : undefined;
}

/**
 * Decode JWT token
 */
export function decodeToken(token: string): TokenDecoded | null {
  try {
    if (!process.env.ACCESS_TOKEN_SECRET) {
      logger.error('ACCESS_TOKEN_SECRET is not configured');
      return null;
    }
    return jwt.verify(
      token,
      process.env.ACCESS_TOKEN_SECRET
    ) as TokenDecoded;
  } catch (error) {
    return null;
  }
}


/**
 * Project an account document onto the optional-auth request identity.
 *
 * Two things it does, both preserved verbatim from the Mongo version:
 *
 *  - `_id` is resolved from `_id`, falling back to `id` ONLY when `id` is not
 *    the public key. On the account document `id` is `publicKey ?? _id`, so
 *    that guard is what stops a keyed account's PUBLIC KEY from being used as
 *    an account id downstream.
 *  - `id` is DROPPED from the projection, so nothing on an optional-auth path
 *    can read an ambiguous one.
 *
 * The `toObject()` branch is gone with the Mongoose documents that needed it —
 * every caller now hands over a plain object.
 */
export function normalizeUser(user: AccountDocument | null | undefined): NormalizedUser | null {
  if (!user) return null;

  const publicKey = typeof user.publicKey === 'string' ? user.publicKey : undefined;
  const fromRowId = typeof user._id === 'string' && user._id.length > 0 ? user._id : undefined;
  const fallbackId = typeof user.id === 'string' && user.id.length > 0 ? user.id : undefined;
  const userId =
    fromRowId ||
    (fallbackId && fallbackId !== publicKey ? fallbackId : undefined);
  if (!userId) return null;

  const { _id, id, ...restUser } = user;

  return {
    ...restUser,
    _id: userId
  };
}

/**
 * Validate session-based token and return normalized user
 */
export async function validateSessionToken(token: string): Promise<NormalizedUser | null> {
  try {
    const validationResult = await sessionService.validateSession(token);
    
    if (!validationResult?.user) {
      return null;
    }
    
    return normalizeUser(validationResult.user);
  } catch (error) {
    logger.debug('Session validation error', { error });
    return null;
  }
}


/**
 * Authenticate request and return normalized user (non-blocking)
 * Returns null if authentication fails (doesn't throw)
 */
export async function authenticateRequestNonBlocking(
  req: Request,
  requireAuth = false
): Promise<{ user: NormalizedUser | null; source: 'header' | null }> {
  const token = extractTokenFromRequest(req);
  const source = req.headers.authorization ? 'header' : null;
  
  if (!token) {
    return { user: null, source };
  }
  
  const decoded = decodeToken(token);
  if (!decoded) {
    return { user: null, source };
  }
  
  // Only session-based tokens are supported
  if (!decoded.sessionId) {
    return { user: null, source };
  }
  
  const user = await validateSessionToken(token);
  return { user, source };
}
