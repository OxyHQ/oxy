import crypto from 'node:crypto';
import { logger } from './logger';
import jwt from 'jsonwebtoken';

/**
 * Access-token lifetime in seconds. Exported because `POST /auth/oauth/token`
 * must report it as RFC 6749 §5.1 `expires_in`, and a hard-coded copy there
 * would start lying the moment this value changes.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // Short-lived access tokens
const ACCESS_TOKEN_EXPIRES_IN = `${ACCESS_TOKEN_TTL_SECONDS}s`;
const REFRESH_TOKEN_EXPIRES_IN = '7d'; // Longer refresh tokens

/**
 * The single issuer identity Oxy signs JWTs under, and the single resource
 * server they address. The service-token mint (`POST /auth/service-token`)
 * already used exactly these two strings, and `@oxy.so/core`'s SDK already
 * verifies service tokens against them by default — so an access token joining
 * the same vocabulary is one issuer/audience pair for the platform rather than
 * a second one invented alongside it. Issue #937 writes `https://auth.oxy.so`
 * in its illustrative claim set; that is a URL for the same party, and adopting
 * it would mean two spellings of one issuer with nothing able to tell them
 * apart. When a SECOND resource server exists, `aud` becomes per-session state
 * (a column) rather than this constant.
 */
export const OXY_TOKEN_ISSUER = 'oxy-auth';
export const OXY_RESOURCE_SERVER = 'oxy-api';

/**
 * The claim-set version an access token carries in `ver`.
 *
 * V1 vs V2 IS EXACTLY `ver === 2`. A v1 token carries no `ver` at all, so the
 * discrimination is the presence of the claim, not the shape of anything else —
 * and `jti`, which every mint now carries, is deliberately NOT the
 * discriminator: it says a token is not replayable, not that the binding claims
 * below were minted and are enforceable.
 */
export const ACCESS_TOKEN_VERSION = 2;

/**
 * Everything a v2 access token binds itself to. Assembled at the mint site from
 * the `sessions` row, so a re-mint of a live session reproduces it exactly and
 * `checkAccessTokenBinding` can compare claim against row.
 */
export interface AccessTokenBinding {
  /** `sub` — the account the token acts AS. `sessions.user_id`. */
  subjectAccountId: string;
  /**
   * `act.sub` — the human operating it. `operated_by_user_id` when the session
   * is delegated, otherwise the subject itself. NEVER conflated with `sub`:
   * on a delegated session those are two different people, and the audit
   * actor, the revocation path and the `account:act_as` re-check all key off
   * this one and not the other.
   */
  principalUserId: string;
  /** `sid` and the legacy `sessionId` claim. */
  sessionId: string;
  /** The legacy `deviceId` claim — the ATTRIBUTION device, unchanged. */
  deviceId: string;
  /** `device_session_id` — `device_sessions.id`, when this session has one. */
  deviceSessionId?: string | null;
  /** `device_context_id` — `device_account_contexts.id` (ADR 0001). */
  deviceContextId?: string | null;
  /** `azp` — the `application_credentials.public_key` that obtained this session. */
  clientId?: string | null;
  /** `scope` — the scopes granted to `azp`, space-delimited on the wire. */
  scopes?: readonly string[] | null;
}

/**
 * Generate the JWT pair for a session.
 *
 * EVERY mint carries a fresh `jti`, which is what makes two mints for one
 * session inside the same second differ. Before that, the payload was
 * `{userId, sessionId, deviceId, type}` with no nonce and a JWT's `iat`/`exp`
 * carry one-second resolution, so a same-second re-mint produced a
 * BYTE-IDENTICAL token — and on the rotation path `refreshTokens` wrote the
 * outgoing token to `previous_refresh_token` and the new one to
 * `refresh_token`, leaving the two EQUAL and NOT invalidating a presented
 * refresh token. `sessions.access_token` / `refresh_token` are also UNIQUE, so
 * the same collision could fail a concurrent mint on a duplicate key.
 *
 * The refresh half deliberately does NOT carry the v2 binding claims. It is
 * presented to exactly one endpoint, which resolves the whole binding from the
 * session row anyway, so copying the binding onto it would be a second
 * authority that can only drift from the first. It carries `jti` because that
 * is the property the rotation path depends on.
 */
export const generateSessionTokens = (binding: AccessTokenBinding) => {
  const accessSecret = process.env.ACCESS_TOKEN_SECRET;
  const refreshSecret = process.env.REFRESH_TOKEN_SECRET;
  if (!accessSecret || !refreshSecret) {
    throw new Error(
      'Token secrets are not configured (ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET)',
    );
  }

  const scope = binding.scopes && binding.scopes.length > 0 ? binding.scopes.join(' ') : undefined;

  const accessToken = jwt.sign(
    {
      ver: ACCESS_TOKEN_VERSION,
      iss: OXY_TOKEN_ISSUER,
      sub: binding.subjectAccountId,
      act: { sub: binding.principalUserId },
      aud: [OXY_RESOURCE_SERVER],
      ...(binding.clientId ? { azp: binding.clientId } : {}),
      ...(scope ? { scope } : {}),
      sid: binding.sessionId,
      ...(binding.deviceSessionId ? { device_session_id: binding.deviceSessionId } : {}),
      ...(binding.deviceContextId ? { device_context_id: binding.deviceContextId } : {}),
      jti: crypto.randomUUID(),
      // The v1 claims, kept verbatim for the migration window AND because
      // `@oxy.so/core/server`'s middleware is decode-only and reads exactly
      // these two: a third-party app backend does not hold the signing secret,
      // so it looks up `sessionId` and compares `userId` against the session it
      // validates over HTTP. Removing either would sign every consuming backend
      // out; see the v1 window note in `checkAccessTokenBinding`.
      userId: binding.subjectAccountId,
      sessionId: binding.sessionId,
      deviceId: binding.deviceId,
      type: 'access',
    },
    accessSecret,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN },
  );

  const refreshToken = jwt.sign(
    {
      ver: ACCESS_TOKEN_VERSION,
      iss: OXY_TOKEN_ISSUER,
      sid: binding.sessionId,
      jti: crypto.randomUUID(),
      userId: binding.subjectAccountId,
      sessionId: binding.sessionId,
      deviceId: binding.deviceId,
      type: 'refresh',
    },
    refreshSecret,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN },
  );

  return { accessToken, refreshToken };
};

/** An application token lives five minutes (ADR 0058 2.3), `@oxy.so/contracts` `DEVICE_APP_TOKEN_TTL_SECONDS`. */
export const HOST_ACCESS_TOKEN_TTL_SECONDS = 300;

/** The platforms whose application tokens Oxy verifies (`@oxy.so/contracts` `PLATFORM_HOSTS`). */
export type HostPlatform = 'oxyos' | 'astro';

const HOST_PLATFORMS: readonly HostPlatform[] = ['oxyos', 'astro'];

/**
 * The `host` claim of an application token: the platform that vouched for the
 * application, and the id of the platform credential it minted with.
 */
export interface HostTokenClaim {
  platform: HostPlatform;
  credential: string;
}

/**
 * Mint an application's token (ADR 0058 2.3): a fresh access token of the
 * SHARED session `binding` describes — the same `sub`, `act`, `sid`,
 * `device_session_id` and `device_context_id` as the device's own token, so it
 * lives and dies with that session — plus `azp` (the application's public
 * client id) and `host`. Five minutes, a fresh `jti`, never stored on the row,
 * no `scope` and no `deviceId` claim: the device is the platform's.
 *
 * `binding` must be a shared session's (no `clientId`, no scopes): an
 * application-bound session is one application's already, and naming another
 * on it would be the third-party isolation turned inside out.
 */
export function generateHostAccessToken(
  binding: AccessTokenBinding,
  application: { clientId: string },
  host: HostTokenClaim,
): { accessToken: string; expiresAt: Date } {
  const accessSecret = process.env.ACCESS_TOKEN_SECRET;
  if (!accessSecret) throw new Error('Token secrets are not configured (ACCESS_TOKEN_SECRET)');
  if (binding.clientId || (binding.scopes && binding.scopes.length > 0)) {
    throw new Error('An application token names an application on a SHARED session only');
  }
  if (!binding.deviceSessionId || !binding.deviceContextId) {
    throw new Error('An application token needs a session bound to its device context');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + HOST_ACCESS_TOKEN_TTL_SECONDS;
  const accessToken = jwt.sign(
    {
      ver: ACCESS_TOKEN_VERSION,
      iss: OXY_TOKEN_ISSUER,
      sub: binding.subjectAccountId,
      act: { sub: binding.principalUserId },
      aud: [OXY_RESOURCE_SERVER],
      azp: application.clientId,
      host: { platform: host.platform, credential: host.credential },
      sid: binding.sessionId,
      device_session_id: binding.deviceSessionId,
      device_context_id: binding.deviceContextId,
      jti: crypto.randomUUID(),
      // The two v1 claims `@oxy.so/core/server`'s decode-only middleware reads
      // (see generateSessionTokens). No `deviceId`: an application token joins
      // no device room and reaches no device route.
      userId: binding.subjectAccountId,
      sessionId: binding.sessionId,
      type: 'access',
      iat: issuedAt,
      exp: expiresAt,
    },
    accessSecret,
  );
  return { accessToken, expiresAt: new Date(expiresAt * 1000) };
}

/**
 * When an access token this server signed expires, read from its own `exp`
 * (the token is ours; this does not verify it). `null` when it is not a JWT
 * or carries no `exp`, which no token this server signs is.
 */
export function accessTokenExpiresAt(token: string): Date | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    const exp = (payload as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Decoded claims carried by the session access/refresh JWTs minted here.
 * Extends `JwtPayload` so the standard registered claims (`iat`, `exp`, …) and
 * its index signature remain available on the decoded token.
 *
 * The v2 members are all OPTIONAL because this type also describes a v1 token
 * still inside the migration window. `checkAccessTokenBinding` is the one place
 * that decides which set it is looking at.
 */
export interface SessionTokenPayload extends jwt.JwtPayload {
  userId: string;
  sessionId: string;
  deviceId: string;
  type: 'access' | 'refresh';
  ver?: number;
  sid?: string;
  act?: { sub?: unknown };
  azp?: string;
  scope?: string;
  device_session_id?: string;
  device_context_id?: string;
  /** Present only on an application token (ADR 0058). */
  host?: unknown;
}

/**
 * Token validation result with error information
 */
export interface TokenValidationResult {
  valid: boolean;
  payload?: SessionTokenPayload;
  error?: 'expired' | 'invalid' | 'malformed';
}

/**
 * Validate and decode an access token
 *
 * Enhanced error handling: Returns specific error types for better debugging
 * and to distinguish between expired tokens (should refresh) vs invalid tokens.
 *
 * @param token - The access token to validate
 * @returns Validation result with payload if valid, or error information if invalid
 */
export const validateAccessToken = (
  token: string,
  options: { throwOnUnavailable?: boolean } = {},
): TokenValidationResult => {
  try {
    const secret = process.env.ACCESS_TOKEN_SECRET;
    if (!secret) {
      logger.error('[SessionUtils] ACCESS_TOKEN_SECRET is not configured');
      if (options.throwOnUnavailable) throw new Error('Access token verification unavailable');
      return { valid: false, error: 'invalid' };
    }
    const decoded = jwt.verify(token, secret);
    if (typeof decoded === 'string') {
      return { valid: false, error: 'malformed' };
    }
    return { valid: true, payload: decoded as SessionTokenPayload };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.debug('[SessionUtils] Access token expired');
      return { valid: false, error: 'expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      logger.debug('[SessionUtils] Access token invalid', { error: error.message });
      return { valid: false, error: 'invalid' };
    }
    if (options.throwOnUnavailable) throw error;
    logger.debug('[SessionUtils] Access token validation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { valid: false, error: 'malformed' };
  }
};

/**
 * Validate and decode a refresh token
 *
 * Enhanced error handling: Returns specific error types for better debugging
 * and to distinguish between expired tokens vs invalid tokens.
 *
 * @param token - The refresh token to validate
 * @returns Validation result with payload if valid, or error information if invalid
 */
export const validateRefreshToken = (token: string): TokenValidationResult => {
  try {
    const secret = process.env.REFRESH_TOKEN_SECRET;
    if (!secret) {
      logger.error('[SessionUtils] REFRESH_TOKEN_SECRET is not configured');
      return { valid: false, error: 'invalid' };
    }
    const decoded = jwt.verify(token, secret);
    if (typeof decoded === 'string') {
      return { valid: false, error: 'malformed' };
    }
    return { valid: true, payload: decoded as SessionTokenPayload };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      logger.debug('[SessionUtils] Refresh token expired');
      return { valid: false, error: 'expired' };
    }
    if (error instanceof jwt.JsonWebTokenError) {
      logger.debug('[SessionUtils] Refresh token invalid', { error: error.message });
      return { valid: false, error: 'invalid' };
    }
    logger.debug('[SessionUtils] Refresh token validation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { valid: false, error: 'malformed' };
  }
};

/**
 * The binding recorded on the `sessions` row, which is the AUTHORITY every v2
 * claim is checked against. A claim that disagrees with the row is not a
 * different opinion, it is a token that no longer describes its session.
 */
export interface SessionTokenBindingRow {
  sessionId: string;
  /** `sessions.user_id` — the subject. */
  userId: string;
  /** `sessions.operated_by_user_id` — set only on a delegated session. */
  operatedByUserId: string | null;
  /**
   * `sessions.application_id`. Row state, NOT a claim: the token names the
   * credential (`azp`), and which application that credential belongs to is a
   * registry fact the token has no business asserting.
   */
  applicationId: string | null;
  clientId: string | null;
  deviceSessionId: string | null;
  deviceContextId: string | null;
  scopes: readonly string[];
}

/**
 * Who a validated bearer says it is, resolved against the session row. This is
 * what the request lane exposes; nothing downstream re-reads the raw claims.
 */
export interface AccessTokenIdentity {
  version: 1 | 2;
  /** The account being acted as. */
  subjectAccountId: string;
  /** The human acting. Equal to the subject on a first-party session. */
  principalUserId: string;
  sessionId: string;
  /**
   * The application this session belongs to, if any. NULL is the shared device
   * session every official app uses; a value means the session is one
   * application's and nothing else may reach it. The device lane reads this to
   * refuse a third-party bearer.
   */
  applicationId: string | null;
  /** The `application_credentials.public_key` this session belongs to, if any. */
  clientId: string | null;
  deviceSessionId: string | null;
  deviceContextId: string | null;
  scopes: readonly string[];
  /**
   * Present only on an APPLICATION TOKEN a platform minted (ADR 0058), once
   * Oxy has re-checked it live (`hostTokenAuthority.service.ts`): which
   * application it is named for (`azp`) and which platform vouched for it.
   * `applicationId`/`clientId` above stay the ROW's (NULL: the shared
   * session), so nothing that reads them confuses a named shared session with
   * an application's own.
   */
  host?: VerifiedHostToken;
}

/** An application token's `host`, verified against the registry and the platform credential. */
export interface VerifiedHostToken {
  platform: HostPlatform;
  /** The platform credential (`device_credentials.id`) it was minted with. */
  credentialId: string;
  /** `azp`: the application's public client id. */
  clientId: string;
  /** The application `clientId` belongs to. */
  applicationId: string;
  /**
   * The token names the platform's OWN application (its credential's
   * `platform_application_id`): OxyOS's Settings and shell. Only such a token
   * may make the account's own security writes (ADR 0058, the platform's
   * Settings is the account UI on a host).
   */
  self: boolean;
}

/** Why a bearer was refused. Each value names one failed check. */
export type AccessTokenBindingFailure =
  | 'legacy_window_closed'
  | 'wrong_token_type'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'session_mismatch'
  | 'subject_mismatch'
  | 'actor_mismatch'
  | 'client_mismatch'
  | 'device_session_mismatch'
  | 'device_context_mismatch'
  | 'scope_not_granted'
  | 'host_mismatch'
  | 'host_not_accepted';

/** An application token's claims, checked against the row but not yet against the registry. */
export interface PendingHostToken {
  platform: HostPlatform;
  credentialId: string;
  clientId: string;
  deviceSessionId: string;
}

export type AccessTokenBindingResult =
  | {
      ok: true;
      identity: AccessTokenIdentity;
      /**
       * Set for an application token. The caller MUST verify it live
       * (`verifyHostTokens`) before believing the bearer; only callers that
       * pass `acceptHost` ever receive one.
       */
      host?: PendingHostToken;
    }
  | { ok: false; reason: AccessTokenBindingFailure };

function hostClaimOf(value: unknown): HostTokenClaim | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { platform, credential, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  if (typeof platform !== 'string' || !HOST_PLATFORMS.includes(platform as HostPlatform)) {
    return null;
  }
  if (typeof credential !== 'string' || credential.length === 0 || credential.length > 128) {
    return null;
  }
  return { platform: platform as HostPlatform, credential };
}

/**
 * Whether a v1 access token is still accepted.
 *
 * THE WINDOW, AND HOW IT CLOSES. Every mint after this change is v2, and an
 * access token lives at most `ACCESS_TOKEN_TTL_SECONDS` (15 minutes) while a
 * refresh token lives at most 7 days — and both the refresh rotation and
 * `getAccessToken`'s re-mint produce v2. So the last possible v1 token expires
 * one refresh-token lifetime after deploy, WITHOUT anybody doing anything. The
 * flag exists so that fact becomes enforceable rather than merely true:
 * setting `ACCESS_TOKEN_V1_WINDOW=closed` refuses every remaining v1 bearer,
 * and after that the v2 guarantees (subject/actor separation, `azp` binding,
 * context binding, unique `jti`) hold for EVERY authenticated request rather
 * than for every request that happens to carry a new enough token.
 */
export function isLegacyAccessTokenAccepted(): boolean {
  return process.env.ACCESS_TOKEN_V1_WINDOW !== 'closed';
}

function claimString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function audienceIncludes(aud: jwt.JwtPayload['aud'], expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
}

/**
 * The v2 binding a session row implies, for the ATTRIBUTION device the mint is
 * stamping. The inverse of `checkAccessTokenBinding`: that one asks whether a
 * presented token still matches its row, this one produces the token the row
 * would mint — so both sides of the phase derive the claims from the SAME
 * expression instead of two copies that can drift.
 *
 * `principalUserId` is `operated_by_user_id` when the session is delegated and
 * the subject itself otherwise. That single line is the actor/subject
 * separation the whole phase turns on — collapsing it would make a delegated
 * session's token claim the organization authorised itself — which is why it
 * is written HERE once and never beside a caller's own mint.
 *
 * `deviceId` is a parameter rather than a row field because it is the only
 * part of a mint the row does not decide: a reuse that migrates the session
 * onto the caller's central device stamps the NEW id while the row still names
 * the old one, and the rotation path stamps the presented token's.
 */
export function tokenBindingFromRow(
  row: SessionTokenBindingRow,
  deviceId: string,
): AccessTokenBinding {
  return {
    subjectAccountId: row.userId,
    principalUserId: row.operatedByUserId ?? row.userId,
    sessionId: row.sessionId,
    deviceId,
    deviceSessionId: row.deviceSessionId,
    deviceContextId: row.deviceContextId,
    clientId: row.clientId,
    scopes: row.scopes,
  };
}

/**
 * Resource-server validation of a verified access token against the session it
 * names. `validateAccessToken` proved the SIGNATURE and the expiry; this proves
 * the token still describes its session, and answers with the identity the
 * request should run as.
 *
 * A v1 token asserted none of this, so for a v1 token the ROW is the whole
 * answer — which is deliberate and is what keeps the third-party device-lane
 * guard working during the window: a legacy bearer for an application-bound
 * session still resolves to that application, because the binding was never in
 * the token to begin with.
 */
export function checkAccessTokenBinding(
  payload: SessionTokenPayload,
  row: SessionTokenBindingRow,
  options: { acceptHost?: boolean } = {},
): AccessTokenBindingResult {
  const rowIdentity: AccessTokenIdentity = {
    version: 1,
    subjectAccountId: row.userId,
    principalUserId: row.operatedByUserId ?? row.userId,
    sessionId: row.sessionId,
    applicationId: row.applicationId,
    clientId: row.clientId,
    deviceSessionId: row.deviceSessionId,
    deviceContextId: row.deviceContextId,
    scopes: row.scopes,
  };

  if (payload.ver !== ACCESS_TOKEN_VERSION) {
    if (!isLegacyAccessTokenAccepted()) {
      return { ok: false, reason: 'legacy_window_closed' };
    }
    return { ok: true, identity: rowIdentity };
  }

  // A service token is signed with the SAME secret as an access token, so
  // `type` is the claim that keeps the two families apart on this lane. It has
  // been present on every access token ever minted, v1 included, but is only
  // ASSERTED for v2 — a v1 token is exactly the case where we cannot be sure
  // what else is out there.
  if (payload.type !== 'access') return { ok: false, reason: 'wrong_token_type' };
  if (payload.iss !== OXY_TOKEN_ISSUER) return { ok: false, reason: 'issuer_mismatch' };
  if (!audienceIncludes(payload.aud, OXY_RESOURCE_SERVER)) {
    return { ok: false, reason: 'audience_mismatch' };
  }
  if (payload.sid !== row.sessionId) return { ok: false, reason: 'session_mismatch' };
  if (payload.sub !== row.userId) return { ok: false, reason: 'subject_mismatch' };

  const actor = claimString(payload.act?.sub);
  if (actor !== (row.operatedByUserId ?? row.userId)) {
    return { ok: false, reason: 'actor_mismatch' };
  }

  // An APPLICATION TOKEN (ADR 0058 2.4): `azp` on a SHARED session, accepted
  // only together with `host`, and only by a caller that verifies `host` live.
  // An `azp` without `host` on a shared session is still `client_mismatch`.
  let host: PendingHostToken | undefined;
  if (payload.host !== undefined) {
    const claim = hostClaimOf(payload.host);
    const azp = claimString(payload.azp);
    if (
      !claim ||
      !azp ||
      row.clientId !== null ||
      row.applicationId !== null ||
      row.deviceSessionId === null ||
      payload.scope !== undefined
    ) {
      return { ok: false, reason: 'host_mismatch' };
    }
    if (!options.acceptHost) return { ok: false, reason: 'host_not_accepted' };
    host = {
      platform: claim.platform,
      credentialId: claim.credential,
      clientId: azp,
      deviceSessionId: row.deviceSessionId,
    };
  } else if (claimString(payload.azp) !== row.clientId) {
    return { ok: false, reason: 'client_mismatch' };
  }
  if (claimString(payload.device_session_id) !== row.deviceSessionId) {
    return { ok: false, reason: 'device_session_mismatch' };
  }
  if (claimString(payload.device_context_id) !== row.deviceContextId) {
    return { ok: false, reason: 'device_context_mismatch' };
  }

  // The row is the grant; the claim may only ever be a subset of it. An excess
  // scope is refused rather than trimmed — a token asking for more than its
  // session was granted is not a token to serve at reduced privilege.
  const claimed = payload.scope ? payload.scope.split(' ').filter((s) => s.length > 0) : [];
  if (claimed.some((scope) => !row.scopes.includes(scope))) {
    return { ok: false, reason: 'scope_not_granted' };
  }

  return {
    ok: true,
    identity: {
      version: 2,
      subjectAccountId: row.userId,
      principalUserId: row.operatedByUserId ?? row.userId,
      sessionId: row.sessionId,
      applicationId: row.applicationId,
      clientId: row.clientId,
      deviceSessionId: row.deviceSessionId,
      deviceContextId: row.deviceContextId,
      scopes: claimed.length > 0 ? claimed : row.scopes,
    },
    ...(host ? { host } : {}),
  };
}
