/**
 * Wire format for the OAuth 2.0 / OpenID Connect endpoints.
 *
 * WHY THIS FILE EXISTS — READ BEFORE "ALIGNING" IT WITH THE REST OF THE API.
 *
 * Every other endpoint answers with the house envelopes: `sendSuccess` wraps
 * payloads in `{ data: … }` and `ApiError.toJSON()` emits
 * `{ error: 'UNAUTHORIZED', message: … }`. The OAuth endpoints CANNOT use
 * either, and that is not a style choice:
 *
 *   - RFC 6749 §5.1 defines the token response as a JSON object whose
 *     TOP-LEVEL members are `access_token`, `token_type`, `expires_in`, …
 *     Every standard OAuth client reads them from the root of the document, so
 *     a `{ data: … }` wrapper makes the endpoint unreadable to all of them.
 *   - RFC 6749 §5.2 defines the error response as top-level `error` +
 *     `error_description`, where `error` is one of a CLOSED set of codes the
 *     client branches on (`invalid_grant` means "start over", `invalid_client`
 *     means "your credentials are wrong"). Our `error: 'UNAUTHORIZED'` code
 *     carries none of that meaning.
 *   - RFC 6749 §5.1 additionally REQUIRES `Cache-Control: no-store` on token
 *     responses so credentials never land in an intermediary cache.
 *   - RFC 6750 §3 defines the `WWW-Authenticate` challenge a resource server
 *     (here: the userinfo endpoint) must return on an invalid bearer token.
 *
 * So this module is the single deliberate exception to the house envelope, and
 * it is confined to the OAuth surface. Do not route these responses through
 * `sendSuccess` / `ApiError`.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from './logger';

/**
 * The error codes this API emits.
 *
 * `invalid_request` … `invalid_scope` are the token-endpoint codes of
 * RFC 6749 §5.2; `server_error` is RFC 6749 §4.1.2.1 (reused here so the token
 * endpoint has ONE error shape for every failure, including unexpected ones);
 * `invalid_token` and `insufficient_scope` are the bearer-token codes of
 * RFC 6750 §3.1 used by the userinfo endpoint.
 */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'server_error'
  | 'invalid_token'
  | 'insufficient_scope';

/**
 * The protection space named in the `WWW-Authenticate` challenges. Constant
 * across the OAuth surface — clients use it only to label a credential prompt.
 */
const OAUTH_REALM = 'oxy';

/**
 * A failure that must be rendered as an RFC 6749 §5.2 / RFC 6750 §3 error.
 *
 * Construct via the static factories so the status code and the challenge
 * header can never drift from the error code they belong to.
 */
export class OAuthError extends Error {
  /** The RFC error code. This is the value clients branch on. */
  public readonly error: OAuthErrorCode;
  /** Human-readable detail. Never leaks which internal precondition failed. */
  public readonly errorDescription: string;
  public readonly statusCode: number;
  /** Challenge header value, when the code requires one. */
  public readonly wwwAuthenticate?: string;

  private constructor(
    error: OAuthErrorCode,
    errorDescription: string,
    statusCode: number,
    wwwAuthenticate?: string,
  ) {
    super(`${error}: ${errorDescription}`);
    this.name = 'OAuthError';
    this.error = error;
    this.errorDescription = errorDescription;
    this.statusCode = statusCode;
    this.wwwAuthenticate = wwwAuthenticate;
  }

  /** Malformed request: missing/duplicated/unparseable parameters. */
  static invalidRequest(errorDescription: string): OAuthError {
    return new OAuthError('invalid_request', errorDescription, 400);
  }

  /**
   * Client authentication failed, or the client is unknown.
   *
   * 401 + a `Basic` challenge: RFC 6749 §5.2 REQUIRES the challenge whenever
   * the client authenticated through the `Authorization` header, and RFC 7235
   * §3.1 requires any 401 to carry one. Emitting it unconditionally satisfies
   * both without the response depending on how the client tried to authenticate.
   */
  static invalidClient(errorDescription: string): OAuthError {
    return new OAuthError(
      'invalid_client',
      errorDescription,
      401,
      `Basic realm="${OAUTH_REALM}", charset="UTF-8"`,
    );
  }

  /**
   * The authorization code is invalid, expired, already redeemed, or was not
   * issued to this client / redirect URI.
   *
   * Callers MUST collapse every one of those causes into this single error with
   * one shared description — telling them apart would let an attacker holding a
   * stolen code probe which binding failed.
   */
  static invalidGrant(errorDescription: string): OAuthError {
    return new OAuthError('invalid_grant', errorDescription, 400);
  }

  /** The `grant_type` is absent or is one this endpoint does not implement. */
  static unsupportedGrantType(errorDescription: string): OAuthError {
    return new OAuthError('unsupported_grant_type', errorDescription, 400);
  }

  /** The request failed for a reason on our side. */
  static serverError(errorDescription: string): OAuthError {
    return new OAuthError('server_error', errorDescription, 500);
  }

  /** RFC 6750 §3.1 — the access token is missing, malformed, or expired. */
  static invalidToken(errorDescription: string): OAuthError {
    return new OAuthError(
      'invalid_token',
      errorDescription,
      401,
      `Bearer realm="${OAUTH_REALM}", error="invalid_token", error_description="${sanitizeChallengeValue(errorDescription)}"`,
    );
  }
}

/**
 * Make a string safe to embed in a `WWW-Authenticate` quoted-string
 * (RFC 7235 §2.1): drop the characters that would terminate or escape it.
 * Descriptions here are developer-authored constants, so this is a guard
 * against future edits rather than against user input.
 */
function sanitizeChallengeValue(value: string): string {
  return value.replace(/[\\"]/g, '');
}

/**
 * Apply the response headers RFC 6749 §5.1 requires on every token response
 * (success AND error): credentials must never be cached by an intermediary.
 * `Pragma: no-cache` is named alongside it for HTTP/1.0 caches.
 */
function applyNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/**
 * Emit an RFC 6749 §5.2 error document: flat `error` + `error_description`,
 * plus the challenge header when the code carries one.
 */
export function sendOAuthError(res: Response, error: OAuthError): void {
  if (error.wwwAuthenticate) {
    res.setHeader('WWW-Authenticate', error.wwwAuthenticate);
  }
  applyNoStore(res);
  res.status(error.statusCode).json({
    error: error.error,
    error_description: error.errorDescription,
  });
}

/**
 * Emit an RFC 6749 §5.1 success document: the payload members sit at the TOP
 * LEVEL of the JSON body, never inside a `data` wrapper.
 *
 * §5.1 explicitly permits additional members beyond the standard ones, which is
 * how Oxy's device-first extras (`deviceId`, `deviceSecret`, `session_id`,
 * `user`) ride along without breaking a standard client.
 */
export function sendOAuthSuccess(res: Response, payload: Record<string, unknown>): void {
  applyNoStore(res);
  res.status(200).json(payload);
}

type OAuthRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Wrap an OAuth route so EVERY failure leaves as an RFC-shaped error document.
 *
 * `OAuthError`s render as themselves. Anything else (a thrown `ApiError`, a
 * Mongoose failure, a programming error) is logged with its real cause and
 * reported to the client as a generic `server_error` — an OAuth client must
 * never receive the house `{ error: 'INTERNAL_SERVER_ERROR', message }`
 * envelope from these endpoints, and must never be told what broke internally.
 */
export function oauthHandler(handler: OAuthRouteHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch((caught: unknown) => {
      if (caught instanceof OAuthError) {
        sendOAuthError(res, caught);
        return;
      }

      logger.error('[OAuth] Unhandled failure in OAuth route', {
        method: req.method,
        path: req.path,
        error: caught instanceof Error ? caught.message : String(caught),
      });
      sendOAuthError(res, OAuthError.serverError('The request could not be completed.'));
    });
  };
}
