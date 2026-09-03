import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { logger } from '../utils/logger';
import sessionService from '../services/session.service';
import type { AccountDocument } from '../services/user.service';
import type { AccessTokenIdentity } from '../utils/sessionUtils';
import { verifyServiceToken, type ServiceTokenPayload } from './serviceToken';
import {
  extractTokenFromRequest,
  decodeToken,
  validateSessionToken,
  type TokenDecoded
} from './authUtils';

// Ensure environment variables are loaded
dotenv.config();

/**
 * Interface for requests with full user object.
 *
 * ## `req.user._id` is KEPT, and it is the account id
 *
 * `_id` here is a REAL property carrying the account id string — the value
 * `userService.readAccountDocument` writes as `_id: row.id`. It is not a getter
 * and not an alias computed at the middleware; nothing about the row's shape is
 * misrepresented.
 *
 * It is kept rather than every call site moving to `id` because on the account
 * document those two mean DIFFERENT THINGS. `AccountDocument.id` reproduces the
 * old model's `id` virtual, `publicKey ?? _id` — so for every account holding a
 * Commons identity key, the document's `id` is the PUBLIC KEY while `_id` is
 * the account id. `_id` is the field that means "the account id" unconditionally,
 * on `req.user` and on every `readAccountDocument` response alike; `id` only
 * means it here because the handler below pins it. Migrating the `_id` readers
 * onto `id` would make every ownership check depend on that pinning continuing
 * to exist, which is strictly more fragile than reading the field that is
 * already unambiguous.
 *
 * `_id` is also not Mongo baggage on this value. `users.id` holds the 24-char
 * ObjectId hex verbatim by the migration contract's own decree, and carrying
 * `_id` beside `id` on this document is the documented contract
 * (`@oxyhq/contracts` `resolveUserId` = `user.id ?? user._id`).
 *
 * ## The cast is gone, which is the other half of the change
 *
 * This used to be `IUser & Document`, populated through
 * `const fullUser = user as IUser & Document`. The cast meant `tsc` checked
 * NONE of the reads that flow from here — a wrong shape would have surfaced as
 * "not authenticated", API-wide, with a clean compile. The type is now exactly
 * what `sessionService.validateSession` returns and there is no cast, so every
 * `req.user.<field>` read is checked against the real document.
 */
export interface AuthRequest extends Request {
  user?: AccountDocument;
  /**
   * The VERIFIED session this request authenticated with.
   *
   * Exposed because the follow graph has to know which application is acting,
   * and the authorization record that answers that is keyed on the session id.
   * Taking it from the token again downstream would mean parsing a credential
   * twice and trusting the second read; taking it from a header or a body field
   * would mean trusting the caller. This is the value the middleware already
   * checked.
   */
  sessionId?: string;
  /**
   * What the bearer resolved to once its claims were checked against the
   * session row (issue #937, Phase 6): subject and actor kept apart, plus the
   * application, device context and scopes the session is bound to.
   *
   * This is the ONE place a route may learn which application is behind a user
   * bearer. The token's own claims are never read again downstream — `req.user`
   * answers "who", this answers "as whom, through what, with which scopes".
   */
  oxyToken?: AccessTokenIdentity;
}

/**
 * Interface for requests with just user ID
 */
export interface SimpleAuthRequest extends Request {
  user?: {
    id: string;
  };
}

/**
 * Reject requests that carry a bearer token in the URL query string
 * (`?token=` / `?access_token=`).
 *
 * Tokens in URLs leak into proxy/ALB access logs, browser history, and
 * Referer headers. Session-establishment endpoints (e.g. POST /auth/session)
 * must accept the bearer token ONLY via the Authorization header, so this
 * guard fails loudly with a 400 instead of silently processing the leaked
 * credential.
 */
export const rejectQueryToken = (req: Request, res: Response, next: NextFunction) => {
  if (req.query.token !== undefined || req.query.access_token !== undefined) {
    return res.status(400).json({
      error: 'Token in URL not allowed',
      message: 'This endpoint accepts the bearer token only via the Authorization header. Remove the token/access_token query parameter.'
    });
  }
  next();
};

/**
 * Authentication middleware that validates JWT tokens and attaches the full user object to the request
 * 
 * Optimized for high-scale usage:
 * - Uses session-based tokens only
 * - Uses session service with caching to minimize database queries
 * - Eliminates redundant user fetches by using populated user from validation
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Invalid or missing authorization header'
      });
    }

    const token = authHeader.split(' ')[1];
    
    if (!process.env.ACCESS_TOKEN_SECRET) {
      logger.error('ACCESS_TOKEN_SECRET not configured');
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Server configuration error'
      });
    }

    try {
      // Decode token to check if it's session-based
      const decoded = decodeToken(token);
      
      if (!decoded) {
        return res.status(401).json({
          error: 'Invalid token',
          message: 'Token could not be decoded'
        });
      }
      
      if (process.env.NODE_ENV === 'development') {
        logger.debug('Token decoded', { 
          hasSessionId: !!decoded.sessionId, 
          sessionId: decoded.sessionId,
          userId: decoded.userId,
          exp: decoded.exp 
        });
      }
      
      // Only session-based tokens are supported
      if (!decoded.sessionId) {
        return res.status(401).json({
          error: 'Invalid token',
          message: 'Token must be session-based (include a sessionId claim).'
        });
      }

      // Session-based token - validate session using service layer
      if (process.env.NODE_ENV === 'development') {
        logger.debug('Validating session-based token', { sessionId: decoded.sessionId });
      }
      
      try {
        // Use session service for optimized validation with caching
        const validationResult = await sessionService.validateSession(token);

        if (!validationResult) {
          if (process.env.NODE_ENV === 'development') {
            logger.debug('Session validation failed', { sessionId: decoded.sessionId });
          }
          return res.status(401).json({
            error: 'Invalid session',
            message: 'Session not found or expired'
          });
        }

        const { user } = validationResult;

        if (!user) {
          return res.status(401).json({
            error: 'Invalid session',
            message: 'User not found'
          });
        }

        // Use user from validationResult — it is already the full account
        // document, which eliminates a redundant database query on every
        // authenticated request.
        //
        // `id` is pinned to the account id, exactly as before: on THIS object
        // `id` and `_id` have always both been the account id, and 43 call
        // sites read `req.user.id` as one (`profiles.ts`, `users.ts`,
        // `userData.ts`, the notification controller…). The document's own `id`
        // is `publicKey ?? _id`, so leaving it alone would silently hand those
        // sites a PUBLIC KEY for every account holding a Commons identity —
        // a change of value, not of name, at ownership checks.
        //
        // A SHALLOW COPY, not a mutation. `user` is the object held in
        // `userCache` and shared by every concurrent request for this account;
        // the `fullUser.id = …` this replaces wrote through to the cache entry.
        req.user = { ...user, id: user._id };
        (req as AuthRequest).sessionId = decoded.sessionId;
        req.oxyToken = validationResult.token;

        next();
      } catch (dbError) {
        logger.error('Database error during session lookup', dbError instanceof Error ? dbError : new Error(String(dbError)), {
          component: 'auth',
          method: 'authMiddleware',
        });
        return res.status(500).json({
          error: 'Database error',
          message: 'Error validating session'
        });
      }
    } catch (error) {
      logger.error('Token verification error', error instanceof Error ? error : new Error(String(error)), {
        component: 'auth',
        method: 'authMiddleware',
      });
      
      if (error instanceof jwt.TokenExpiredError) {
        return res.status(401).json({
          error: 'Token expired',
          message: 'Your session has expired. Please log in again.'
        });
      }
      
      if (error instanceof jwt.JsonWebTokenError) {
        return res.status(401).json({
          error: 'Invalid token',
          message: 'The provided authentication token is invalid'
        });
      }
      
      return res.status(401).json({
        error: 'Authentication error',
        message: 'An error occurred while authenticating your request'
      });
    }
  } catch (error) {
    logger.error('Auth middleware error', error instanceof Error ? error : new Error(String(error)), {
      component: 'auth',
      method: 'authMiddleware',
    });
    return res.status(500).json({
      error: 'Server error',
      message: 'An error occurred while authenticating your request'
    });
  }
};

/**
 * Request augmented by `serviceAuthMiddleware` with the verified service
 * principal. Routes can read `req.serviceApp.scopes` to gate sensitive
 * actions.
 */
export interface ServiceAuthRequest extends Request {
  serviceApp?: ServiceTokenPayload;
}

/**
 * Service token authentication middleware
 *
 * Validates OAuth2 client-credentials service JWTs (type: 'service').
 * Only accepts tokens issued via POST /auth/service-token — rejects regular
 * user session tokens. Used to protect internal endpoints that should only
 * be called by other Oxy ecosystem services.
 *
 * Attaches the decoded service payload (including granted `scopes`) to
 * `req.serviceApp` so routes can do scope-level authorisation.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export const serviceAuthMiddleware = (req: ServiceAuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Invalid or missing authorization header',
    });
  }

  const token = authHeader.split(' ')[1];

  const verification = verifyServiceToken(token);
  if (verification.ok) {
    req.serviceApp = verification.payload;
    return next();
  }

  if (verification.reason === 'expired') {
    return res.status(401).json({
      error: 'Token expired',
      message: 'Service token has expired',
    });
  }
  if (verification.reason === 'not_service') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'This endpoint requires a service token',
    });
  }
  return res.status(401).json({
    error: 'Invalid token',
    message: 'The provided service token is invalid',
  });
};

/**
 * Simplified authentication middleware that only validates the token and attaches the user ID
 *
 * Optimized for high-scale usage - lighter weight than full authMiddleware.
 * Uses session-based tokens only.
 * Use this when you only need the user ID, not the full user object.
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export const simpleAuthMiddleware = async (req: SimpleAuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Invalid or missing authorization header'
      });
    }

    const token = authHeader.split(' ')[1];
    if (!process.env.ACCESS_TOKEN_SECRET) {
      logger.error('ACCESS_TOKEN_SECRET not configured');
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'Server configuration error'
      });
    }

    try {
      // Decode token to check if it's session-based
      const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as TokenDecoded;

      // Only session-based tokens are supported
      if (!decoded.sessionId) {
        return res.status(401).json({
          error: 'Invalid token',
          message: 'Token must be session-based (include a sessionId claim).'
        });
      }

      // Session-based token - validate session using service layer
      const validationResult = await sessionService.validateSession(token);

      if (!validationResult) {
        return res.status(401).json({
          error: 'Invalid session',
          message: 'Session not found or expired'
        });
      }

      // Set user ID. Both sides are `text` columns now, so the `.toString()`
      // calls that coerced an ObjectId are gone; the fallback to the session's
      // own `user_id` remains, since it is the same id by foreign key.
      const userId = validationResult.user?._id || validationResult.session.userId;
      req.user = { id: userId };
      next();
    } catch (error) {
      logger.error('Token verification error', error instanceof Error ? error : new Error(String(error)), {
        component: 'auth',
        method: 'simpleAuthMiddleware',
      });

      if (error instanceof jwt.TokenExpiredError) {
        return res.status(401).json({
          error: 'Token expired',
          message: 'Your session has expired. Please log in again.'
        });
      }

      if (error instanceof jwt.JsonWebTokenError) {
        return res.status(401).json({
          error: 'Invalid token',
          message: 'The provided authentication token is invalid'
        });
      }

      return res.status(401).json({
        error: 'Authentication error',
        message: 'An error occurred while authenticating your request'
      });
    }
  } catch (error) {
    logger.error('Unexpected auth error', error instanceof Error ? error : new Error(String(error)), {
      component: 'auth',
      method: 'simpleAuthMiddleware',
    });
    return res.status(500).json({
      error: 'Server error',
      message: 'An error occurred while authenticating your request'
    });
  }
};
