/**
 * Authentication Methods Mixin
 *
 * Supports password-based login (email/username) and public key challenge-response.
 */
import type { User } from '../models/interfaces';
import type {
  UserNameResponse,
  LoginResult,
  CommonsDenyReason,
} from '@oxyhq/contracts';
import { loginResultSchema, safeParseContract } from '@oxyhq/contracts';
import type { SessionLoginResponse } from '../models/session';
import type { OxyServicesBase } from '../OxyServices.base';
import type { PublicApplication } from './OxyServices.connectedApps';
export {
  getCommonsApprovalBlockingReason,
  parseCommonsApprovalExpiresAt,
} from '../utils/commonsApproval';
import { OxyAuthenticationError } from '../OxyServices.errors';
import { KeyManager } from '../crypto/keyManager';
import { SignatureService } from '../crypto/signatureService';
import { loadNodeCrypto } from '@oxyhq/protocol';
import { logger } from '../logger';
import { normalizeUserIdentity, normalizeUserIdentityOrNull } from '../utils/userIdentity';

/**
 * Default lifetime of a "Sign in with Oxy" device-flow session / authorize code.
 * Matches the authorize-code TTL the server enforces (5 minutes). The server's
 * returned `expiresAt` is authoritative; this is only the client-proposed value.
 */
const COMMONS_SIGN_IN_EXPIRY_MS = 5 * 60 * 1000;

/**
 * Fallback access-token lifetime used only if the token endpoint ever omits the
 * RFC 6749 `expires_in` member. Matches the server's current 15-minute access
 * token; the server's value always wins when present.
 */
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface ChallengeResponse {
  challenge: string;
  expiresAt: string;
}

export interface RegistrationRequest {
  publicKey: string;
  username: string;
  email?: string;
  signature: string;
  timestamp: number;
}

export interface ChallengeVerifyRequest {
  publicKey: string;
  challenge: string;
  signature: string;
  timestamp: number;
  deviceName?: string;
  deviceFingerprint?: string;
}

export interface PublicKeyCheckResponse {
  registered: boolean;
  message: string;
}

/** OpenID Connect userinfo claims returned by `GET /auth/oauth/userinfo`. */
export interface OAuthUserInfoResponse {
  sub: string;
  preferred_username?: string;
  name?: string;
  picture?: string;
}

/**
 * The session an OAuth authorization-code exchange yields.
 *
 * Deliberately NOT `LoginSessionResult`. That type mirrors the API's
 * `buildSessionAuthResponse`, which every FIRST-PARTY sign-in lane emits, and it
 * requires `deviceId` because those lanes always join the origin's DeviceSession.
 * `POST /auth/oauth/token` is the RFC 6749 token endpoint and serves third
 * parties, whose grant is deliberately ISOLATED: an untrusted application must be
 * able to receive a session carrying NO DeviceSession credential at all.
 *
 * Both device fields are therefore optional here, and a response omitting them is
 * a well-formed device-less grant rather than a malformed payload. What that
 * costs the session is spelled out on `exchangeOAuthCode` below.
 */
export interface OAuthTokenExchangeResult {
  sessionId: string;
  /** ISO-8601 expiry of {@link accessToken}, derived from RFC 6749 `expires_in`. */
  expiresAt: string;
  accessToken?: string;
  /**
   * The DeviceSession this grant joined, when the server issued one. ABSENT for
   * an isolated third-party grant — never assume a string.
   */
  deviceId?: string;
  /**
   * The zero-cookie mint credential for {@link deviceId}. Present only alongside
   * it; absent for an isolated third-party grant.
   */
  deviceSecret?: string;
  user: {
    id: string;
    username?: string;
    avatar?: string;
  };
}

// ===========================================================================
// "Sign in with Oxy" — cross-device QR / app-to-app handoff (Workstream C)
// ===========================================================================

/**
 * How a "Sign in with Oxy" request finalizes once the approver authorizes it.
 *
 * ONE request (`AuthSession`) serves every delivery surface — popup, push, QR,
 * deep link — so the purpose describes the FINALIZATION, never the transport:
 *
 * - `device_sign_in` — the classic device flow. The initiator exchanges its
 *   secret `sessionToken` for the first access token via `claimSessionByToken`.
 * - `oauth_authorization` — the request additionally carries an OAuth binding
 *   ({@link CommonsOAuthContext}), so it finalizes into a single-use
 *   authorization CODE via {@link OxyServicesAuthMixin.finalizeCommonsOAuth}.
 *   The caller still performs the PKCE token exchange itself.
 */
export type CommonsSignInPurpose = 'device_sign_in' | 'oauth_authorization';

/**
 * OAuth binding attached to a "Sign in with Oxy" request so a single
 * `AuthSession` can finalize into a standard OAuth authorization code instead of
 * a device-flow session.
 *
 * Only the minimum request binding is carried here — everything else (the app's
 * name, icon, registered redirect URIs, trust flags) is owned server-side by the
 * `Application` the `clientId` resolves to and is never client-supplied.
 *
 * The PKCE `codeVerifier` NEVER appears here: only its S256 `codeChallenge`
 * crosses the wire, exactly as in the redirect flow. The RP-owned OAuth `state`
 * also stays with the relying party, which validates it locally.
 */
export interface CommonsOAuthContext {
  /** Exact registered redirect URI the authorization code will be returned to. */
  redirectUri: string;
  /** PKCE `BASE64URL(SHA-256(codeVerifier))` (RFC 7636 §4.2); the verifier stays client-side. */
  codeChallenge: string;
  /** PKCE transformation method. Always `S256` — `plain` is not accepted. */
  codeChallengeMethod: 'S256';
  /** Space-delimited OAuth scope string; the server normalizes and validates it. */
  scope?: string;
  /**
   * Optional delegated account the application will act AS (an organization or
   * project the identity is a member of). The identity approving the request
   * does not change; the server verifies the identity's permission to act as
   * this account before finalizing.
   */
  subjectAccountId?: string;
}

/**
 * Handle returned by {@link OxyServicesAuthMixin.startCommonsSignIn} for a
 * relying-party app initiating a "Sign in with Oxy" flow.
 *
 * `sessionToken` is the SECRET, high-entropy device-flow credential — it stays
 * on the initiating client, is exchanged once via `claimSessionByToken` (device
 * sign-in) or {@link OxyServicesAuthMixin.finalizeCommonsOAuth} (OAuth), and is
 * NEVER placed in the QR/deep-link. `authorizeCode` is the PUBLIC handle carried
 * in `qrPayload`; the approver (Commons) resolves it via
 * {@link OxyServicesAuthMixin.getCommonsApprovalInfo}.
 */
export interface CommonsSignInHandle {
  /** Secret device-flow token (held by the initiator; exchanged via `claimSessionByToken`). */
  sessionToken: string;
  /** Public, single-use authorize code carried in the QR / deep-link. */
  authorizeCode: string;
  /** Ready-to-render deep-link / universal-link string (`oxycommons://approve?...`). */
  qrPayload: string;
  /** Server-authoritative expiry (epoch milliseconds). */
  expiresAt: number;
  /** Session lifecycle status as reported by the server (e.g. `'pending'`). */
  status: string;
}

/**
 * Poll result for a "Sign in with Oxy" device-flow session
 * (`GET /auth/session/status`).
 *
 * The authoritative state machine stays small — `pending → authorized →
 * consumed`, plus `cancelled` / `expired` — and lives in `status`. Delivery
 * PROGRESS (`pushSentAt`, `openedAt`) is carried as timestamps beside it, never
 * as competing statuses, so a progress signal can never be mistaken for an
 * authorization.
 */
export interface CommonsSignInStatus {
  /** True once an approver has authorized the session. */
  authorized: boolean;
  /** The authorized session id (present once `authorized` for device sign-in). */
  sessionId?: string;
  /** The approving identity's public key (present once `authorized`). */
  publicKey?: string;
  /** Lifecycle status (`'pending'` | `'authorized'` | `'cancelled'` | `'expired'`). */
  status?: string;
  /**
   * How this request finalizes. Unrecognized/missing values degrade to
   * `device_sign_in` so an older API never misroutes an OAuth finalize.
   */
  purpose?: CommonsSignInPurpose;
  /**
   * ISO-8601 timestamp of when the request was pushed to a known Commons
   * installation, or `null` when no push has been sent (including on a server
   * that predates delivery progress). Progress only — it never implies the push
   * was received, opened, or approved.
   */
  pushSentAt: string | null;
  /**
   * ISO-8601 timestamp of when the approval route was opened in Commons, or
   * `null` when it has not been opened. Reported by the approver via
   * {@link OxyServicesAuthMixin.markCommonsApprovalOpened}; it is an
   * un-authenticated progress hint used only to advance the waiting UI, and is
   * NEVER evidence that the request was approved.
   */
  openedAt: string | null;
}

/**
 * Outcome of asking Oxy to deliver a pending sign-in request to the identity's
 * known Commons installations (`POST /auth/session/deliver/:authorizeCode`).
 *
 * `targets: 0` is a NORMAL outcome, not a failure: it simply means no capable
 * Commons installation is registered, so push is not a usable route and the
 * caller shows the QR instead. Feed `targets` into `selectCommonsDelivery`
 * (`utils/commonsDelivery`) rather than branching on it ad hoc.
 */
export interface CommonsDeliveryResult {
  /** Whether the server dispatched the request to at least one installation. */
  delivered: boolean;
  /** How many eligible Commons installations it was dispatched to (`0` is normal). */
  targets: number;
}

/**
 * The account an application will act AS once the request is approved, when the
 * request delegates to an organization/project rather than the approver's own
 * personal account. Resolved and sanitized server-side from the request's
 * `subjectAccountId`, so it is safe to display in the approval UI.
 *
 * The identity approving stays the identity: Commons renders this as a distinct
 * "will act as" line, never as a change of who is signing.
 */
export interface CommonsApprovalSubjectAccount {
  /** The delegated account's id. */
  id: string;
  /** The delegated account's handle. */
  username: string;
  /** Optional human-readable name; absent when the account has no real name. */
  displayName?: string;
}

/**
 * Server-resolved approval context shown by the approver (Commons) before
 * authorizing — the TRUSTED identity of the requesting app, resolved from the
 * `authorizeCode` server-side (never from the QR string).
 */
export interface CommonsApprovalInfo {
  /** Sanitized, display-safe identity of the requesting application. */
  application: PublicApplication | null;
  /** OAuth scopes the application is requesting. */
  scopes: string[];
  /** The origin the session is bound to (the RP web origin), when applicable. */
  boundOrigin?: string;
  /**
   * Server-authoritative anti-phishing flag: `true` only when this device-flow
   * sign-in was started from a verified, registered origin of a trusted app.
   * The approver (Commons) shows a warning when this is `false`. Always present
   * — a missing/non-boolean server value is coerced to `false` (fail-safe to
   * "not verified") by {@link OxyServicesAuthMixin.getCommonsApprovalInfo}.
   */
  originVerified: boolean;
  /**
   * COARSE, display-only label of the client that STARTED the request
   * (`"Chrome on Windows"`), resolved server-side from the requesting browser —
   * NEVER from the QR payload. Render it verbatim as a secondary line under the
   * origin; it is the whole descriptor the platform has (no raw User-Agent, no
   * IP, no location is ever collected for it).
   *
   * `null` whenever the server has no browser context to describe: native
   * requesters, unidentifiable User-Agents, and any API that predates the field.
   * Omit the line entirely in that case — never substitute a guess.
   */
  requesterLabel: string | null;
  /**
   * How this request finalizes. Always present — an unrecognized or missing
   * server value degrades to `'device_sign_in'`, the behaviour every server has
   * always had, so an older API never makes the approver believe it is granting
   * an OAuth authorization.
   */
  purpose: CommonsSignInPurpose;
  /**
   * The delegated account the application will act as, or `null` when the
   * request is for the approver's own account. Always present — a missing or
   * malformed server value degrades to `null` (fail-safe to "no delegation"),
   * so a partial payload can never imply a broader grant than was requested.
   */
  subjectAccount: CommonsApprovalSubjectAccount | null;
  /** Server-authoritative expiry (epoch ms or ISO-8601 string from the API). */
  expiresAt: number | string;
  /** Session lifecycle status. */
  status: string;
}

/**
 * @internal Raw server response of `GET /auth/session/approve-info/:code`.
 * `originVerified`, `purpose` and `subjectAccount` are typed loosely here
 * because older servers may omit them (or send an unexpected shape); the SDK
 * narrows each one fail-safe when mapping into {@link CommonsApprovalInfo}.
 */
interface CommonsApprovalInfoResponse {
  application: PublicApplication | null;
  scopes: string[];
  boundOrigin?: string;
  originVerified?: unknown;
  requesterLabel?: unknown;
  purpose?: unknown;
  subjectAccount?: unknown;
  expiresAt: number | string;
  status: string;
}

/**
 * @internal Narrow an untrusted `requesterLabel` from the approve-info response.
 *
 * Returns the trimmed label only when the server sent a real, non-empty string;
 * everything else — absent (an API that predates the field), `null` (a native
 * requester the server could not describe), or a non-string — degrades to
 * `null`, so the approval UI drops the line instead of rendering a blank or a
 * coerced value under the app it is about to authorize.
 */
function parseCommonsRequesterLabel(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const label = value.trim();
  return label.length > 0 ? label : null;
}

/**
 * @internal Narrow an untrusted `subjectAccount` from the approve-info response.
 *
 * Returns `null` unless the value is an object carrying a non-empty string `id`
 * AND `username` — the two fields the approval UI needs to name the delegated
 * account. A half-populated object is rejected whole rather than rendered with
 * blanks, and `displayName` is only carried through when it is a string.
 */
function parseCommonsSubjectAccount(value: unknown): CommonsApprovalSubjectAccount | null {
  if (value === null || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const { id, username, displayName } = raw;
  if (typeof id !== 'string' || !id || typeof username !== 'string' || !username) {
    return null;
  }
  return {
    id,
    username,
    ...(typeof displayName === 'string' ? { displayName } : {}),
  };
}

/**
 * @internal Narrow an untrusted delivery-progress timestamp from the status
 * response.
 *
 * Returns the ISO-8601 string unchanged when it is a real, parseable instant,
 * and `null` for everything else — absent (an older API that has no delivery
 * progress at all), empty, non-string, or unparseable. Progress is advisory, so
 * degrading to "no progress yet" is always safe; surfacing a garbage timestamp
 * to the waiting UI is not.
 */
function parseCommonsProgressTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}

/** Result of approving / denying a "Sign in with Oxy" request. */
export interface CommonsSignInActionResult {
  success: boolean;
}

/**
 * Result of finalizing an approved, OAuth-bound "Sign in with Oxy" request.
 *
 * This is an authorization CODE, not a session: the caller still performs the
 * standard PKCE token exchange (`exchangeOAuthCode`) with the `codeVerifier` it
 * has held all along. No access token, refresh token, or device secret is ever
 * produced by finalization.
 */
export interface CommonsOAuthFinalizeResult {
  /** Single-use OAuth authorization code. */
  code: string;
  /** The exact registered redirect URI the request was bound to. */
  redirectUri: string;
  /** Lifetime of the authorization code, in seconds. */
  expiresIn: number;
}

/** @internal Response shape of the extended `POST /auth/session/create`. */
interface CommonsSessionCreateResponse {
  authorizeCode: string;
  qrPayload: string;
  status: string;
  /** Optional server-authoritative expiry; falls back to the client-proposed value. */
  expiresAt?: number;
  /** Optional server echo of the session token (the client-supplied value is authoritative). */
  sessionToken?: string;
}

export interface ServiceTokenResponse {
  token: string;
  expiresIn: number;
  appName: string;
}

/**
 * One cache entry per (apiKey hash) → issued token + the secret that produced it.
 * The secret is kept around in raw Buffer form so we can perform a
 * constant-time compare against any reused credential pair — this prevents an
 * attacker who learned a victim's apiKey from receiving the victim's cached
 * service token by simply guessing the secret.
 *
 * @internal
 */
interface ServiceTokenCacheEntry {
  token: string;
  /** Expiry as ms since epoch */
  expiresAt: number;
  /** Raw secret stored as Buffer for constant-time comparison on cache hit */
  secretBuf: Buffer;
  /** In-flight refresh promise (deduplicates concurrent callers) */
  pending: Promise<string> | null;
  /**
   * The raw apiKey that produced this entry. Retained so a targeted, fully
   * synchronous `invalidateServiceToken(apiKey)` can locate the entry without
   * re-deriving the async `SHA-256(apiKey)` Map key. Never logged or returned.
   */
  apiKey: string;
}

/**
 * Sentinel error raised when getServiceToken() is called with a known apiKey
 * but a non-matching secret. Indicates either credential drift in the caller
 * or a cross-tenant cache lookup attempt. Surface as a 401-equivalent.
 */
export class ServiceCredentialMismatchError extends Error {
  constructor() {
    super('Service credential mismatch: provided secret does not match the secret stored for this apiKey');
    this.name = 'ServiceCredentialMismatchError';
  }
}

export function OxyServicesAuthMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    /**
     * Per-credential token cache.
     *
     * Keyed by SHA-256(apiKey). Each entry carries:
     *   - the issued service JWT
     *   - its expiry timestamp
     *   - the secret that produced it (Buffer for constant-time compare)
     *   - an optional in-flight promise to deduplicate concurrent refreshes
     *
     * The previous implementation kept ONE token/exp pair per OxyServices
     * instance. That meant calling `getServiceToken(keyA, secretA)` populated
     * the cache, and a subsequent `getServiceToken(keyB, secretB)` (different
     * tenant) would receive tenant A's token. This is fixed by routing every
     * lookup through the Map.
     *
     * @internal
     */
    _serviceTokenCache = new Map<string, ServiceTokenCacheEntry>();

    /** @internal Raw apiKey stored by configureServiceAuth() for use by getServiceToken() */
    _serviceApiKey: string | null = null;
    /** @internal Raw apiSecret stored by configureServiceAuth() for use by getServiceToken() */
    _serviceApiSecret: string | null = null;

    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Hash an apiKey into a stable Map cache key. Uses Node's SHA-256 — service
     * tokens are only ever issued by a Node host (the SDK on web/RN never has
     * the apiSecret in the first place), so we can rely on Node crypto here.
     *
     * @internal
     */
    async _hashApiKey(apiKey: string): Promise<string> {
      const nodeCrypto = await loadNodeCrypto();
      return nodeCrypto.createHash('sha256').update(apiKey).digest('hex');
    }

    /**
     * Configure service credentials for internal service-to-service communication.
     * Call this once at startup so that getServiceToken() and makeServiceRequest()
     * can automatically obtain and refresh tokens.
     *
     * Calling this with credentials that differ from a previously-configured pair
     * is allowed — each `(apiKey, apiSecret)` pair is cached independently, so
     * legitimate multi-tenant hosts that need to switch credentials cannot leak
     * one tenant's token to another tenant on the same instance.
     *
     * @param apiKey - Application credential public key (oxy_dk_*)
     * @param apiSecret - Application credential secret
     */
    configureServiceAuth(apiKey: string, apiSecret: string): void {
      this._serviceApiKey = apiKey;
      this._serviceApiSecret = apiSecret;
    }

    /**
     * Get a service token for internal service-to-service communication.
     * Tokens are short-lived (1h) and automatically cached/refreshed per
     * `(apiKey, apiSecret)` pair.
     *
     * Concurrent callers for the same credential pair share a single in-flight
     * request to avoid hammering `/auth/service-token` when the cache is empty
     * or expired.
     *
     * **Security guarantee:** if the cache already holds a token for this
     * apiKey but the supplied apiSecret does not constant-time match the
     * secret that originally produced that token, this method throws
     * `ServiceCredentialMismatchError` instead of returning the cached token.
     * This prevents an attacker who learned a peer's apiKey from extracting
     * their service token by polling with a wrong secret.
     *
     * @param apiKey - Application credential public key (optional if configureServiceAuth was called)
     * @param apiSecret - Application credential secret (optional if configureServiceAuth was called)
     */
    async getServiceToken(apiKey?: string, apiSecret?: string): Promise<string> {
      const key = apiKey || this._serviceApiKey;
      const secret = apiSecret || this._serviceApiSecret;

      if (!key || !secret) {
        throw new Error('Service credentials not provided. Call configureServiceAuth() or pass apiKey and apiSecret.');
      }

      const cacheKey = await this._hashApiKey(key);
      const now = Date.now();
      const providedSecretBuf = Buffer.from(secret, 'utf8');

      let entry = this._serviceTokenCache.get(cacheKey);

      // Verify the secret on every cache hit, regardless of token freshness.
      // Constant-time compare prevents timing oracles on the stored secret.
      if (entry) {
        const nodeCrypto = await loadNodeCrypto();
        const storedSecretBuf = entry.secretBuf;
        const lengthMatch = storedSecretBuf.length === providedSecretBuf.length;
        // Always run timingSafeEqual on equal-length inputs to keep timing flat.
        // When lengths differ, run against a zero-padded copy of the same length
        // to avoid an early-return timing signal.
        const compareBuf = lengthMatch
          ? providedSecretBuf
          : Buffer.alloc(storedSecretBuf.length);
        const compareResult = nodeCrypto.timingSafeEqual(storedSecretBuf, compareBuf);
        if (!lengthMatch || !compareResult) {
          logger.warn('[oxy.auth] Service token cache hit with mismatched secret', {
            component: 'auth',
            method: 'getServiceToken',
          });
          throw new ServiceCredentialMismatchError();
        }

        // Return cached token if still valid (with 60s buffer for clock drift)
        if (entry.token && entry.expiresAt > now + 60_000) {
          return entry.token;
        }

        // If a fetch is already in-flight for this credential, share its result
        if (entry.pending) {
          return entry.pending;
        }
      } else {
        // First time seeing this apiKey on this instance — seed an empty entry
        // so concurrent callers serialize on the same promise.
        entry = {
          token: '',
          expiresAt: 0,
          secretBuf: providedSecretBuf,
          pending: null,
          apiKey: key,
        };
        this._serviceTokenCache.set(cacheKey, entry);
      }

      const pending = this._doFetchServiceToken(key, secret, cacheKey, providedSecretBuf);
      entry.pending = pending;
      try {
        return await pending;
      } catch (error) {
        // Do not retain unauthenticated cache entries. If the initial
        // /auth/service-token request fails (for example, wrong apiSecret),
        // leaving the pre-seeded empty entry would cause later calls with the
        // real secret for the same apiKey to fail locally as a credential
        // mismatch without ever contacting the server. Keep previously-issued
        // stale tokens on refresh failures, but remove never-authenticated
        // entries.
        const failed = this._serviceTokenCache.get(cacheKey);
        if (failed?.pending === pending && !failed.token) {
          this._serviceTokenCache.delete(cacheKey);
        }
        throw error;
      } finally {
        // Clear the in-flight slot; the entry itself (with fresh token / expiry)
        // is updated inside _doFetchServiceToken before we land here.
        const settled = this._serviceTokenCache.get(cacheKey);
        if (settled?.pending === pending) {
          settled.pending = null;
        }
      }
    }

    /**
     * Perform the actual /auth/service-token request and cache the result.
     * Separated so getServiceToken() can deduplicate concurrent calls.
     * @internal
     */
    async _doFetchServiceToken(
      key: string,
      secret: string,
      cacheKey: string,
      secretBuf: Buffer,
    ): Promise<string> {
      const response = await this.makeRequest<ServiceTokenResponse>(
        'POST',
        '/auth/service-token',
        { apiKey: key, apiSecret: secret },
        { cache: false, retry: false, skipAuth: true }
      );

      const expiresAt = Date.now() + response.expiresIn * 1000;
      // Update the entry in-place so any caller that already grabbed a reference
      // (via `_serviceTokenCache.get(...)`) sees the fresh state.
      const entry = this._serviceTokenCache.get(cacheKey);
      if (entry) {
        entry.token = response.token;
        entry.expiresAt = expiresAt;
        entry.secretBuf = secretBuf;
      } else {
        this._serviceTokenCache.set(cacheKey, {
          token: response.token,
          expiresAt,
          secretBuf,
          pending: null,
          apiKey: key,
        });
      }

      return response.token;
    }

    /**
     * Invalidate cached service token(s), forcing the next `getServiceToken()`
     * call to mint a fresh token from `/auth/service-token`.
     *
     * `getServiceToken()` only refreshes on expiry (with a 60s clock-drift
     * buffer), so a credential that is revoked or rotated mid-run — surfaced as
     * a 401 on a downstream service request — cannot otherwise be recovered
     * within the same process: the still-unexpired cached token keeps being
     * returned. Call this after such a 401 to clear the stale entry; the very
     * next `getServiceToken()` for that credential re-mints.
     *
     * Fully synchronous and deterministic: the call completes before it
     * returns, so a `getServiceToken()` issued immediately afterwards is
     * guaranteed to see the cleared cache and mint anew.
     *
     * @param apiKey - When provided, clears only the cache entry for that
     *   specific apiKey. When omitted, clears the entry for the credential set
     *   via `configureServiceAuth()`; if neither is available (no key to
     *   target), clears the entire cache. Passing no argument is the common
     *   case for hosts that configured a single service credential at startup.
     *
     * The cache Map is keyed by an asynchronously-computed `SHA-256(apiKey)`
     * that cannot be reproduced synchronously, so a targeted clear scans the
     * entries and removes the one whose stored raw `apiKey` matches — keeping
     * this method synchronous. The fully-untargeted call (no argument and no
     * configured key) clears every entry, which is safe because each credential
     * pair is independently re-minted on its next request.
     */
    invalidateServiceToken(apiKey?: string): void {
      const targetKey = apiKey ?? this._serviceApiKey;

      // No specific credential to target — clear everything. The next
      // getServiceToken() for any credential re-mints from scratch.
      if (!targetKey) {
        this._serviceTokenCache.clear();
        return;
      }

      for (const [cacheKey, entry] of this._serviceTokenCache) {
        if (entry.apiKey === targetKey) {
          this._serviceTokenCache.delete(cacheKey);
          return;
        }
      }
    }

    /**
     * Make an authenticated request on behalf of a user using a service token.
     * Automatically obtains/refreshes the service token.
     *
     * @param method - HTTP method
     * @param url - API endpoint URL
     * @param data - Request body or query params
     * @param userId - Optional user ID to act on behalf of (sent as X-Oxy-User-Id)
     */
    async makeServiceRequest<R = any>(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      data?: any,
      userId?: string
    ): Promise<R> {
      const token = await this.getServiceToken();

      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      if (userId) {
        headers['X-Oxy-User-Id'] = userId;
      }

      return this.makeRequest<R>(method, url, data, { headers, cache: false });
    }

    /**
     * Register a new identity with public key authentication
     * Identity is purely cryptographic - username and profile data are optional
     * 
     * @param publicKey - The user's ECDSA public key (hex)
     * @param signature - Signature of the registration request
     * @param timestamp - Timestamp when the signature was created
     */
    async register(
      publicKey: string,
      signature: string,
      timestamp: number
    ): Promise<{ message: string; user: User }> {
      try {
        const res = await this.makeRequest<{ message: string; user: User }>('POST', '/auth/register', {
          publicKey,
          signature,
          timestamp,
        }, { cache: false, skipAuth: true });

        if (!res || (typeof res === 'object' && Object.keys(res).length === 0)) {
          throw new OxyAuthenticationError('Registration failed', 'REGISTER_FAILED', 400);
        }

        return res;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Request an authentication challenge
     * The client must sign this challenge with their private key
     *
     * @param publicKey - The user's public key
     * @param requestOptions - Optional per-call transport overrides (`retry`,
     *   `timeout`). Interactive callers omit it (defaults keep retries); the
     *   cold-boot `shared-key-signin` step passes `{ retry: false }` so a slow
     *   network cannot multiply boot latency via the inner retry loop.
     */
    async requestChallenge(
      publicKey: string,
      requestOptions?: { retry?: boolean; timeout?: number },
    ): Promise<ChallengeResponse> {
      try {
        return await this.makeRequest<ChallengeResponse>('POST', '/auth/challenge', {
          publicKey,
        }, { cache: false, skipAuth: true, ...requestOptions });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Verify a signed challenge and create a session
     * 
     * @param publicKey - The user's public key
     * @param challenge - The challenge string from requestChallenge
     * @param signature - Signature of the auth message
     * @param timestamp - Timestamp when the signature was created
     * @param deviceName - Optional device name
     * @param deviceFingerprint - Optional device fingerprint
     * @param requestOptions - Optional per-call transport overrides (`retry`,
     *   `timeout`). Interactive callers omit it (defaults keep retries); the
     *   cold-boot `shared-key-signin` step passes `{ retry: false }` so a slow
     *   network cannot multiply boot latency via the inner retry loop.
     */
    async verifyChallenge(
      publicKey: string,
      challenge: string,
      signature: string,
      timestamp: number,
      deviceName?: string,
      deviceFingerprint?: string,
      requestOptions?: { retry?: boolean; timeout?: number },
    ): Promise<SessionLoginResponse> {
      try {
        const res = await this.makeRequest<SessionLoginResponse>('POST', '/auth/verify', {
          publicKey,
          challenge,
          signature,
          timestamp,
          deviceName,
          deviceFingerprint,
        }, { cache: false, skipAuth: true, ...requestOptions });

        // Plant the freshly-minted tokens, mirroring `claimSessionByToken`.
        // `/auth/verify` returns the first access token (and refresh token) in
        // its body, so installing it here means callers get an authenticated
        // client without a second round-trip. Refresh stays in the httpOnly
        // cookie slot set by the API.
        if (res?.accessToken) {
          this.setTokens(res.accessToken);
        }

        return {
          ...res,
          user: normalizeUserIdentity(res.user),
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Check if a public key is already registered
     */
    async checkPublicKeyRegistered(publicKey: string): Promise<PublicKeyCheckResponse> {
      try {
        return await this.makeRequest<PublicKeyCheckResponse>(
          'GET',
          `/auth/check-publickey/${encodeURIComponent(publicKey)}`,
          undefined,
          { cache: false, skipAuth: true }
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get user by public key
     */
    async getUserByPublicKey(publicKey: string): Promise<User> {
      try {
        const user = await this.makeRequest<User>(
          'GET',
          `/auth/user/${encodeURIComponent(publicKey)}`,
          undefined,
          {
            cache: true,
            cacheTTL: 2 * 60 * 1000,
            // Public lookup by public key (pre-session) — skip the bearer preflight.
            skipAuth: true,
          },
        );
        return normalizeUserIdentity(user);
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get user by session ID
     */
    async getUserBySession(sessionId: string): Promise<User> {
      try {
        const user = await this.makeRequest<User>('GET', `/session/user/${sessionId}`, undefined, {
          cache: true,
          cacheTTL: 2 * 60 * 1000,
        });
        return normalizeUserIdentity(user);
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Batch get multiple user profiles by session IDs
     */
    async getUsersBySessions(sessionIds: string[]): Promise<Array<{ sessionId: string; user: User | null }>> {
      try {
        if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
          return [];
        }
        
        const uniqueSessionIds = Array.from(new Set(sessionIds)).sort();
        
        const users = await this.makeRequest<Array<{ sessionId: string; user: User | null }>>(
          'POST',
          '/session/users/batch',
          { sessionIds: uniqueSessionIds },
          {
            cache: true,
            cacheTTL: 2 * 60 * 1000,
            deduplicate: true,
          }
        );
        return users.map((entry) => ({
          ...entry,
          user: normalizeUserIdentityOrNull(entry.user),
        }));
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Exchange a device-flow sessionToken for the first access token.
     *
     * The originating client holds a 128-bit `sessionToken` that nobody
     * else has seen — it was generated client-side, sent once on
     * `POST /auth/session/create`, and is never echoed back. After
     * another authenticated device approves the session via
     * `POST /auth/session/authorize/{sessionToken}` (bearer-authed) and
     * the auth socket / poll loop notifies this client, the client
     * exchanges its `sessionToken` here for the first access token,
     * refresh token, sessionId, and the authorized user.
     *
     * This call requires no Authorization header — the high-entropy
     * `sessionToken` IS the credential (RFC 8628 §3.4). The exchange is
     * single-use; replay attempts are rejected with 401.
     *
     * @param sessionToken - The same sessionToken the SDK passed to
     *   `POST /auth/session/create` at the start of the flow.
     * @param options.deviceFingerprint - Optional fingerprint of the
     *   originating client device.
     */
    async claimSessionByToken(
      sessionToken: string,
      options: { deviceFingerprint?: string } = {}
    ): Promise<{
      accessToken: string;
      sessionId: string;
      deviceId: string;
      expiresAt: string;
      user: User;
      deviceSecret?: string;
    }> {
      try {
        const res = await this.makeRequest<{
          accessToken: string;
          sessionId: string;
          deviceId: string;
          expiresAt: string;
          user: User;
          deviceSecret?: string;
        }>(
          'POST',
          '/auth/session/claim',
          {
            sessionToken,
            ...(options.deviceFingerprint ? { deviceFingerprint: options.deviceFingerprint } : {}),
          },
          // Body-authenticated device-flow claim (no bearer) — skip the preflight.
          { cache: false, retry: false, skipAuth: true }
        );

        this.setTokens(res.accessToken);

        return res;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    // =======================================================================
    // "Sign in with Oxy" — handoff (Workstream C)
    //
    // Two mechanisms share the same challenge/verify + device-flow primitives:
    //   A. Same-device shared-keychain SSO (`signInWithSharedIdentity`): a
    //      sibling native app silently mints its own session from the shared
    //      identity key. No user interaction.
    //   B. QR / app-to-app / popup / push handoff: a relying party
    //      (`startCommonsSignIn` + `pollCommonsSignIn`, finalized with either
    //      `claimSessionByToken` or `finalizeCommonsOAuth`) and the approver /
    //      Commons (`getCommonsApprovalInfo` + `approveCommonsSignIn` /
    //      `denyCommonsSignIn`). The approver signs with its PRIMARY local key;
    //      the RP never sees the private key.
    //
    //      ONE request serves every delivery surface. The delivery surface is
    //      not part of the model: only the request's purpose is, and it is fixed
    //      at creation by whether an OAuth binding was attached.
    // =======================================================================

    /**
     * MECHANISM A — same-device shared-keychain SSO.
     *
     * Native-only. If this device holds a shared identity (the cross-app
     * `group.so.oxy.shared` keychain key), prove control of it and mint a
     * session: `requestChallenge(sharedPublicKey)` → `signChallengeWithSharedKey`
     * → `verifyChallenge` (which plants the tokens). Returns `null` on web or
     * when no shared identity is present — never throws for the absent-identity
     * case, so a cold-boot caller can fall through to the next step.
     *
     * The cold-boot wiring that CALLS this lives in `OxyContext`
     * (`@oxyhq/services`); this method just performs the exchange.
     *
     * @param opts.requestOptions - Optional per-call transport overrides
     *   (`retry`, `timeout`) forwarded to BOTH the `requestChallenge` and
     *   `verifyChallenge` round-trips. Interactive flows omit it (defaults keep
     *   retries); the cold-boot `shared-key-signin` step passes `{ retry: false }`
     *   so this network step cannot multiply boot latency via the inner retry
     *   loop. The token-refresh scheduler / 401 lane still retry later.
     */
    async signInWithSharedIdentity(
      opts: {
        deviceName?: string;
        deviceFingerprint?: string;
        requestOptions?: { retry?: boolean; timeout?: number };
      } = {}
    ): Promise<SessionLoginResponse | null> {
      try {
        // `hasSharedIdentity()` already returns false on web (the shared
        // keychain is native-only), so this short-circuits the web case without
        // a wasted challenge round-trip.
        if (!(await KeyManager.hasSharedIdentity())) {
          return null;
        }
        const sharedPublicKey = await KeyManager.getSharedPublicKey();
        if (!sharedPublicKey) {
          return null;
        }

        const { challenge } = await this.requestChallenge(sharedPublicKey, opts.requestOptions);
        const signed = await SignatureService.signChallengeWithSharedKey(challenge);

        // `signed.challenge` carries the SIGNATURE (mirrors `signChallenge`).
        return await this.verifyChallenge(
          signed.publicKey,
          challenge,
          signed.challenge,
          signed.timestamp,
          opts.deviceName,
          opts.deviceFingerprint,
          opts.requestOptions,
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * MECHANISM B (relying party) — begin a "Sign in with Oxy" handoff.
     *
     * Generates a secret device-flow `sessionToken` client-side (it never
     * appears in the QR), registers it with `POST /auth/session/create`, and
     * returns the server-issued public `authorizeCode` + ready-to-render
     * `qrPayload`. Render the QR (web) / open the deep-link (same-device); the
     * approver resolves the code and authorizes. Then poll with
     * {@link pollCommonsSignIn} and finalize.
     *
     * ONE request serves every delivery surface, and how it finalizes is decided
     * here by whether an OAuth binding is attached:
     *   - no `oauth` (the default): a `device_sign_in` request — on `authorized`,
     *     exchange the `sessionToken` via the existing `claimSessionByToken`.
     *   - with `oauth`: an `oauth_authorization` request — on `authorized`, call
     *     {@link finalizeCommonsOAuth} with the same `sessionToken` to mint the
     *     single-use authorization code, then exchange it with PKCE.
     *
     * @param params.clientId - The RP's registered OAuth client id
     *   (ApplicationCredential publicKey); required so the server can resolve the
     *   requesting application's identity.
     * @param params.oauth - Optional OAuth binding ({@link CommonsOAuthContext}).
     *   Carries only the redirect URI, the PKCE S256 challenge, the requested
     *   scope, and an optional delegated `subjectAccountId` — never the PKCE
     *   verifier, the OAuth `state`, or any token.
     */
    async startCommonsSignIn(params: {
      clientId: string;
      oauth?: CommonsOAuthContext;
    }): Promise<CommonsSignInHandle> {
      try {
        // High-entropy opaque secret token (256-bit hex). Generated client-side
        // and held only here; the server stores it but never returns it in the
        // QR. Reuses the platform-safe random generator.
        const sessionToken = await SignatureService.generateChallenge();
        const expiresAt = Date.now() + COMMONS_SIGN_IN_EXPIRY_MS;

        const res = await this.makeRequest<CommonsSessionCreateResponse>(
          'POST',
          '/auth/session/create',
          {
            sessionToken,
            expiresAt,
            clientId: params.clientId,
            // Omitted entirely when absent so the device-sign-in body stays
            // exactly what it has always been (the server reads presence, not a
            // null, to decide the request's purpose).
            ...(params.oauth ? { oauth: params.oauth } : {}),
          },
          // Public/pre-session (no bearer): skip the preflight so a stale
          // near-expiry token cannot re-enter refreshAccessToken while the
          // refresh handler is already in flight (self-await hang).
          { cache: false, skipAuth: true },
        );

        return {
          sessionToken,
          authorizeCode: res.authorizeCode,
          qrPayload: res.qrPayload,
          expiresAt: res.expiresAt ?? expiresAt,
          status: res.status,
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * MECHANISM B (relying party) — poll a device-flow session for approval.
     *
     * Backstop for the auth socket. On `authorized` (with a `sessionId`), the
     * caller finalizes: `claimSessionByToken` for a `device_sign_in` request,
     * {@link finalizeCommonsOAuth} for an `oauth_authorization` one.
     *
     * Every field is narrowed fail-safe. `authorized` counts only as a literal
     * `true`, the identifiers only as non-empty strings, and the delivery
     * progress timestamps degrade to `null` when absent or unparseable — so a
     * partial or older-API payload can advance the waiting UI at most, never
     * make it believe a request was approved.
     *
     * @param sessionToken - The secret token from {@link startCommonsSignIn}.
     */
    async pollCommonsSignIn(sessionToken: string): Promise<CommonsSignInStatus> {
      try {
        const res = await this.makeRequest<unknown>(
          'GET',
          `/auth/session/status/${encodeURIComponent(sessionToken)}`,
          undefined,
          // Public/pre-session (no bearer): a preflight here is wrong per se and,
          // if ever reached while a refresh is pending, would re-enter
          // refreshAccessToken and await the very promise it runs inside.
          { cache: false, retry: false, skipAuth: true }
        );

        if (res === null || typeof res !== 'object') {
          throw new Error('auth/session/status returned an unexpected response shape');
        }
        const { authorized, sessionId, publicKey, status, purpose, pushSentAt, openedAt } =
          res as Record<string, unknown>;

        return {
          authorized: authorized === true,
          ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
          ...(typeof publicKey === 'string' && publicKey ? { publicKey } : {}),
          ...(typeof status === 'string' && status ? { status } : {}),
          purpose: purpose === 'oauth_authorization' ? 'oauth_authorization' : 'device_sign_in',
          pushSentAt: parseCommonsProgressTimestamp(pushSentAt),
          openedAt: parseCommonsProgressTimestamp(openedAt),
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * MECHANISM B (relying party) — ask Oxy to DELIVER a pending sign-in request
     * to the identity's known Commons installations.
     *
     * This is the automatic half of "one intention, one primary action": rather
     * than offering the user a menu of transports, the caller asks for delivery
     * and lets the answer pick the route. Pass the returned `targets` to
     * `selectCommonsDelivery` (`utils/commonsDelivery`) — `targets: 0` means no
     * capable Commons installation is registered, which is a NORMAL outcome that
     * resolves to the QR route, not an error to surface.
     *
     * **Requires a bearer.** Delivery is only allowed when Oxy already knows the
     * intended identity from a trusted authenticated context — a request that
     * merely carries a username or email typed into an unauthenticated browser
     * must never be able to ring somebody's phone.
     *
     * The push it sends carries only `{ type, approvalUrl }` where the URL holds
     * the public `authorizeCode` — no display data, no secrets. Commons resolves
     * everything it shows from `getCommonsApprovalInfo`.
     *
     * @param authorizeCode - The public code from {@link startCommonsSignIn}.
     */
    async deliverCommonsSignIn(authorizeCode: string): Promise<CommonsDeliveryResult> {
      try {
        const res = await this.makeRequest<unknown>(
          'POST',
          `/auth/session/deliver/${encodeURIComponent(authorizeCode)}`,
          undefined,
          // Bearer REQUIRED (unlike its public siblings): the identity to
          // deliver to comes from the authenticated caller, never the code.
          { cache: false },
        );

        if (res === null || typeof res !== 'object') {
          throw new Error('auth/session/deliver returned an unexpected response shape');
        }
        const { delivered, targets } = res as Record<string, unknown>;
        // Both fields drive the route choice, so a partial payload is rejected
        // outright rather than defaulted into a route the server never chose.
        if (
          typeof delivered !== 'boolean' ||
          typeof targets !== 'number' ||
          !Number.isInteger(targets) ||
          targets < 0
        ) {
          throw new Error('auth/session/deliver returned an incomplete delivery result');
        }

        return { delivered, targets };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * MECHANISM B (approver / Commons) — report that the approval route was
     * OPENED, so the waiting relying party can show "Opened in Commons".
     *
     * Progress only. It is idempotent, applies to a `pending` request alone, and
     * records a timestamp (`openedAt`) — it never approves, authorizes, or
     * advances the authorization state machine. Public, like the other approver
     * handles: the approver has only the public `authorizeCode` at this point
     * and has not yet signed anything.
     *
     * Best-effort by nature — a failure here costs the user only a progress
     * line, so callers are free to ignore a rejection and continue to the
     * approval screen.
     *
     * @param authorizeCode - The public code scanned from the QR / deep-link / push.
     */
    async markCommonsApprovalOpened(authorizeCode: string): Promise<void> {
      try {
        await this.makeRequest<unknown>(
          'POST',
          `/auth/session/opened/${encodeURIComponent(authorizeCode)}`,
          undefined,
          // Public (no bearer) — skip the preflight, exactly like approve-info.
          { cache: false, skipAuth: true },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * MECHANISM B (relying party) — finalize an APPROVED, OAuth-bound request
     * into a single-use OAuth authorization code.
     *
     * The OAuth counterpart of `claimSessionByToken`: same secret credential,
     * same single-use semantics, different output. Call it once the request the
     * RP started with an `oauth` binding reports `authorized`; the server
     * atomically mints exactly ONE `AuthCode` bound to the redirect URI, PKCE
     * challenge, scopes, approving identity, and any delegated subject account
     * the request was created with. A second call cannot mint another code.
     *
     * The result is an authorization CODE, never a token — the caller completes
     * the flow with the ordinary PKCE exchange (`exchangeOAuthCode`) using the
     * `codeVerifier` it never sent anywhere. Nothing here is exposed to the
     * popup: the code travels back through the registered callback, and the
     * main window owns the verifier.
     *
     * Like `claimSessionByToken`, this needs no Authorization header — the
     * high-entropy SECRET `sessionToken` IS the credential. Never pass the
     * public `authorizeCode` here; it is the approver's handle, not the
     * initiator's. Every server-side failure (wrong/expired/already-finalized
     * request, non-OAuth purpose, missing permission for the delegated account)
     * surfaces as one generic error, so nothing about the request's state can be
     * probed from outside.
     *
     * @param sessionToken - The secret token from {@link startCommonsSignIn}.
     */
    async finalizeCommonsOAuth(sessionToken: string): Promise<CommonsOAuthFinalizeResult> {
      try {
        const res = await this.makeRequest<unknown>(
          'POST',
          `/auth/session/finalize/${encodeURIComponent(sessionToken)}`,
          undefined,
          // Body-authenticated by the path's secret token (no bearer) — skip the
          // preflight, exactly like the device-flow claim.
          { cache: false, skipAuth: true },
        );

        if (res === null || typeof res !== 'object') {
          throw new Error('auth/session/finalize returned an unexpected response shape');
        }
        const { code, redirectUri, expiresIn } = res as Record<string, unknown>;
        // All three fields are load-bearing for the exchange that follows, so a
        // partial payload is rejected outright rather than returned half-parsed.
        if (
          typeof code !== 'string' ||
          !code ||
          typeof redirectUri !== 'string' ||
          !redirectUri ||
          typeof expiresIn !== 'number' ||
          !Number.isFinite(expiresIn)
        ) {
          throw new Error('auth/session/finalize returned an incomplete authorization code');
        }

        return { code, redirectUri, expiresIn };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * MECHANISM B (approver / Commons) — resolve the TRUSTED identity of a
     * sign-in request from its public `authorizeCode`.
     *
     * The returned `application` and `subjectAccount` are resolved server-side
     * and are the only safe things to display in the approval UI — NEVER trust
     * the app/name/origin strings carried in the QR payload. Public (no auth
     * required).
     *
     * @param authorizeCode - The public code scanned from the QR / deep-link.
     */
    async getCommonsApprovalInfo(authorizeCode: string): Promise<CommonsApprovalInfo> {
      try {
        const raw = await this.makeRequest<CommonsApprovalInfoResponse>(
          'GET',
          `/auth/session/approve-info/${encodeURIComponent(authorizeCode)}`,
          undefined,
          // Public (no auth required) — skip the bearer preflight (avoids the
          // pre-session self-await class).
          { cache: false, skipAuth: true }
        );
        return {
          application: raw.application,
          scopes: raw.scopes,
          boundOrigin: raw.boundOrigin,
          // Fail-safe: only a literal boolean `true` counts as verified. A
          // missing or non-boolean value (older server, malformed response)
          // coerces to `false` so a stale server can never imply trust.
          originVerified: raw.originVerified === true,
          // Same discipline: a missing/blank/non-string label degrades to null
          // (an older API, or a native requester with no browser to describe),
          // and the approver simply omits the "where from" line.
          requesterLabel: parseCommonsRequesterLabel(raw.requesterLabel),
          // Same discipline: only the literal OAuth purpose opts into OAuth
          // finalization. Anything else — including a server that predates this
          // field — is the plain device sign-in it has always been.
          purpose: raw.purpose === 'oauth_authorization' ? 'oauth_authorization' : 'device_sign_in',
          // A missing/partial delegated account degrades to "no delegation"
          // rather than a half-rendered "will act as" line.
          subjectAccount: parseCommonsSubjectAccount(raw.subjectAccount),
          expiresAt: raw.expiresAt,
          status: raw.status,
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * MECHANISM B (approver / Commons) — approve a sign-in request by signing a
     * fresh challenge with the PRIMARY local identity key.
     *
     * Commons holds the user's identity as its primary key (not the shared
     * key), so this uses `signChallenge`. The signed-but-cookieless authorize
     * endpoint resolves the user from the verified signer — the RP that started
     * the flow then claims its session. Native-only (requires a local identity).
     *
     * @param params.authorizeCode - The public code being approved.
     * @param params.deviceName - Optional human-readable device label.
     * @param params.deviceFingerprint - Optional device fingerprint.
     */
    async approveCommonsSignIn(params: {
      authorizeCode: string;
      deviceName?: string;
      deviceFingerprint?: string;
    }): Promise<CommonsSignInActionResult> {
      try {
        const publicKey = await KeyManager.getPublicKey();
        if (!publicKey) {
          throw new Error('No identity found on this device. Create or import an identity first.');
        }

        const { challenge } = await this.requestChallenge(publicKey);
        const signed = await SignatureService.signChallenge(challenge);

        return await this.makeRequest<CommonsSignInActionResult>(
          'POST',
          `/auth/session/authorize-signed/${encodeURIComponent(params.authorizeCode)}`,
          {
            // `signed.challenge` carries the SIGNATURE; `challenge` is the
            // original server-issued challenge string.
            publicKey: signed.publicKey,
            challenge,
            signature: signed.challenge,
            timestamp: signed.timestamp,
            ...(params.deviceName ? { deviceName: params.deviceName } : {}),
            ...(params.deviceFingerprint ? { deviceFingerprint: params.deviceFingerprint } : {}),
          },
          // Key-signed, cookieless (no bearer) — skip the preflight.
          { cache: false, skipAuth: true }
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * MECHANISM B (approver / Commons) — deny a sign-in request, cancelling the
     * device-flow session so the RP stops waiting.
     *
     * @param authorizeCode - The public code being denied.
     * @param reason - Optional closed-set reason ({@link CommonsDenyReason}).
     *   Pass `'not_me'` ONLY when the user actually reported the request as one
     *   they did not start — the server records it as a suspicious denial rather
     *   than an ordinary cancel. Omitting it sends the exact body this endpoint
     *   has always received.
     */
    async denyCommonsSignIn(
      authorizeCode: string,
      reason?: CommonsDenyReason,
    ): Promise<CommonsSignInActionResult> {
      try {
        return await this.makeRequest<CommonsSignInActionResult>(
          'POST',
          `/auth/session/deny/${encodeURIComponent(authorizeCode)}`,
          reason ? { reason } : undefined,
          // Public (no auth required) — skip the bearer preflight.
          { cache: false, skipAuth: true }
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Internal: decode (without verifying) the `sessionId` claim from a
     * server-signed access token. The server already verified the signature;
     * the client only reads the claim to drive multi-session state.
     *
     * @internal
     */
    _decodeSessionIdFromAccessToken(token: string): string | null {
      if (!token || typeof token !== 'string') {
        return null;
      }
      const segments = token.split('.');
      if (segments.length !== 3) {
        return null;
      }
      const payloadSegment = segments[1];
      if (!payloadSegment) {
        return null;
      }
      try {
        const base64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
        if (typeof atob !== 'function') {
          return null;
        }
        const json = decodeURIComponent(
          atob(padded)
            .split('')
            .map((char) => `%${`00${char.charCodeAt(0).toString(16)}`.slice(-2)}`)
            .join(''),
        );
        const parsed: unknown = JSON.parse(json);
        if (parsed === null || typeof parsed !== 'object') {
          return null;
        }
        const claims = parsed as Record<string, unknown>;
        return typeof claims.sessionId === 'string' ? claims.sessionId : null;
      } catch {
        return null;
      }
    }

    /**
     * Get sessions by session ID
     */
    async getSessionsBySessionId(sessionId: string): Promise<any[]> {
      try {
        return await this.makeRequest('GET', `/session/sessions/${sessionId}`, undefined, {
          cache: false,
        });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Logout from a specific session
     */
    async logoutSession(sessionId: string, targetSessionId?: string): Promise<void> {
      try {
        const url = targetSessionId 
          ? `/session/logout/${sessionId}/${targetSessionId}`
          : `/session/logout/${sessionId}`;
        
        await this.makeRequest('POST', url, undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Logout from all sessions
     */
    async logoutAllSessions(sessionId: string): Promise<void> {
      try {
        await this.makeRequest('POST', `/session/logout-all/${sessionId}`, undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Validate session
     */
    async validateSession(
      sessionId: string,
      options: {
        deviceFingerprint?: string;
        useHeaderValidation?: boolean;
      } = {}
    ): Promise<{
      valid: boolean;
      expiresAt: string;
      lastActivity: string;
      user: User;
      sessionId?: string;
      source?: string;
    }> {
      try {
        const urlParams: Record<string, string> = {};
        if (options.deviceFingerprint) urlParams.deviceFingerprint = options.deviceFingerprint;
        if (options.useHeaderValidation) urlParams.useHeaderValidation = 'true';
        const validation = await this.makeRequest<{
          valid: boolean;
          expiresAt: string;
          lastActivity: string;
          user: User;
          sessionId?: string;
          source?: string;
        }>('GET', `/session/validate/${sessionId}`, urlParams, { cache: false });
        return {
          ...validation,
          user: normalizeUserIdentity(validation.user),
        };
      } catch (error) {
        // Session is invalid — clear any cached user data for this session (#196)
        this.clearCacheEntry(`GET:/session/user/${sessionId}`);
        throw this.handleError(error);
      }
    }

    /**
     * Check username availability
     */
    async checkUsernameAvailability(username: string): Promise<{ available: boolean; message: string }> {
      try {
        // Public availability lookup (pre-session) — skip the bearer preflight.
        return await this.makeRequest('GET', `/auth/check-username/${username}`, undefined, { cache: false, skipAuth: true });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Check email availability
     */
    async checkEmailAvailability(email: string): Promise<{ available: boolean; message: string }> {
      try {
        // Public availability lookup (pre-session) — skip the bearer preflight.
        return await this.makeRequest('GET', `/auth/check-email/${email}`, undefined, { cache: false, skipAuth: true });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Begin a WebAuthn / passkey REGISTRATION ceremony. Requests the
     * `PublicKeyCredentialCreationOptions` the browser's `navigator.credentials
     * .create()` (or `@simplewebauthn/browser`'s `startRegistration`) needs.
     *
     * With a bearer token planted this links a passkey to the signed-in account
     * (`username` ignored); without one it is a prospective signup and `username`
     * is the desired handle. The returned options are OPAQUE — Oxy does not own
     * their shape (the browser / `@simplewebauthn` does), so they pass through
     * as `unknown` for the caller to hand straight to the ceremony.
     */
    async webauthnRegisterOptions(username?: string): Promise<unknown> {
      try {
        return await this.makeRequest<unknown>(
          'POST',
          '/auth/webauthn/register/options',
          { ...(username !== undefined ? { username } : {}) },
          { cache: false, ...(username !== undefined ? { skipAuth: true } : {}) },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Finish a WebAuthn / passkey REGISTRATION ceremony. Forwards the opaque
     * browser `RegistrationResponseJSON` (`response`) alongside the Oxy envelope
     * (desired `username` for signup + the device-session naming fields).
     *
     * Two server branches, disambiguated by the response shape:
     *  - **Signup** (no bearer): the account is created and a session minted —
     *    the response carries `sessionId`, is the SAME {@link LoginResult}
     *    contract as `POST /auth/verify`, and its access token is planted here.
     *  - **Link** (bearer present): the passkey is attached to the signed-in
     *    account and the server returns `{ success, message }` with no session,
     *    which is returned verbatim (no token planting).
     */
    async webauthnRegisterVerify(
      response: unknown,
      envelope: {
        username?: string;
        deviceName?: string;
        deviceFingerprint?: string;
        deviceId?: string;
      } = {},
    ): Promise<{ success: true; message: string } | LoginResult> {
      try {
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/webauthn/register/verify',
          { response, ...envelope },
          { cache: false, ...(envelope.username !== undefined ? { skipAuth: true } : {}) },
        );
        if (res && typeof res === 'object') {
          const record = res as Record<string, unknown>;
          // Signup branch: mints a session (LoginSessionResult, carries
          // `sessionId`). Parse against the login contract and plant the token.
          if ('sessionId' in record) {
            const parsed = safeParseContract(loginResultSchema, record);
            if (!parsed) {
              throw new Error('auth/webauthn/register/verify returned an unexpected response shape');
            }
            if (parsed.accessToken) {
              this.setTokens(parsed.accessToken);
            }
            return parsed;
          }
          // Link branch: passkey attached to the signed-in account, no session.
          if (record.success === true && typeof record.message === 'string') {
            return { success: true, message: record.message };
          }
        }
        throw new Error('auth/webauthn/register/verify returned an unexpected response shape');
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Begin a WebAuthn / passkey AUTHENTICATION ceremony. Requests the
     * `PublicKeyCredentialRequestOptions` the browser's `navigator.credentials
     * .get()` (or `@simplewebauthn/browser`'s `startAuthentication`) needs.
     *
     * When `username` is present the server scopes `allowCredentials` to that
     * user's passkeys (username-first); when omitted it returns an empty
     * allow-list for the usernameless / discoverable-credential flow. The
     * returned options are OPAQUE and pass through as `unknown`.
     */
    async webauthnLoginOptions(username?: string): Promise<unknown> {
      try {
        return await this.makeRequest<unknown>(
          'POST',
          '/auth/webauthn/login/options',
          { ...(username !== undefined ? { username } : {}) },
          // Pre-session login ceremony — skip the bearer preflight.
          { cache: false, skipAuth: true },
        );
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Finish a WebAuthn / passkey AUTHENTICATION ceremony. Forwards the opaque
     * browser `AuthenticationResponseJSON` (`response`) alongside the
     * device-session envelope. Resolves to the SAME {@link LoginResult} contract
     * as `POST /auth/verify`; the access token is planted immediately, and the
     * response's `deviceId` + `deviceSecret` are the zero-cookie restore
     * credential.
     */
    async webauthnLoginVerify(
      response: unknown,
      envelope: { deviceName?: string; deviceFingerprint?: string; deviceId?: string } = {},
    ): Promise<LoginResult> {
      try {
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/webauthn/login/verify',
          { response, ...envelope },
          // Pre-session login ceremony — skip the bearer preflight.
          { cache: false, skipAuth: true },
        );
        const parsed = safeParseContract(loginResultSchema, res);
        if (!parsed) {
          throw new Error('auth/webauthn/login/verify returned an unexpected response shape');
        }
        if (parsed.accessToken) {
          this.setTokens(parsed.accessToken);
        }
        return parsed;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Exchange an OAuth authorization code (returned to the RP redirect URI
     * after sign-in at auth.oxy.so) for a device-first session.
     * Public first-party clients use PKCE (`codeVerifier`); the access token is
     * planted immediately on success.
     *
     * Speaks the standard RFC 6749 §4.1.3 token request — a form-urlencoded
     * body with snake_case parameters and `grant_type=authorization_code` — and
     * reads the flat §5.1 response. The camelCase JSON request and `{ data }`
     * response this method used before were an Oxy invention no OAuth library
     * could interoperate with; the endpoint no longer accepts them. The method's
     * OWN signature is unchanged, so callers are unaffected.
     *
     * `deviceId` + `deviceSecret` are OPTIONAL and their absence is a valid
     * outcome, not an error. A third-party grant is meant to be isolated from the
     * browser's shared DeviceSession, so the token endpoint must be free to return
     * no device credential at all — the guard that used to require the pair made
     * that omission unshippable, since it turned every third-party sign-in through
     * the SDK into a silent `exchange-failed`.
     *
     * The cost is real and deliberate: a DEVICE-LESS session cannot use the
     * zero-cookie mint lane (`POST /session/device/token`), because that lane's
     * whole proof is possession of a `deviceSecret`. Its lifetime is therefore the
     * access token itself — nothing persists a restore credential, the cold boot's
     * `device-secret-mint` step reports `no-secret` and skips, and the refresh
     * scheduler has nothing to re-mint from. When the token expires the session
     * ends LOUDLY: the 401 lane clears the tokens and the provider resolves signed
     * out, so the app can run the OAuth flow again. It never degrades into a
     * session that looks alive and cannot refresh.
     */
    async exchangeOAuthCode(params: {
      code: string;
      clientId: string;
      redirectUri: string;
      codeVerifier: string;
    }): Promise<OAuthTokenExchangeResult> {
      try {
        const form = new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: params.redirectUri,
          client_id: params.clientId,
          code_verifier: params.codeVerifier,
        });
        const res = await this.makeRequest<unknown>(
          'POST',
          '/auth/oauth/token',
          form,
          { cache: false, skipAuth: true },
        );
        if (!res || typeof res !== 'object') {
          throw new Error('auth/oauth/token returned an unexpected response shape');
        }
        // RFC 6749 §5.1: every member sits at the TOP LEVEL of the document.
        const record = res as Record<string, unknown>;
        const accessToken = typeof record.access_token === 'string' ? record.access_token : undefined;
        const sessionId = typeof record.session_id === 'string' ? record.session_id : undefined;
        const deviceId = typeof record.deviceId === 'string' ? record.deviceId : undefined;
        const deviceSecret = typeof record.deviceSecret === 'string' ? record.deviceSecret : undefined;
        const userRaw = record.user;
        // The device pair is NOT part of this guard — see the note above. What is
        // still mandatory is what identifies the session at all.
        if (!sessionId || !userRaw || typeof userRaw !== 'object') {
          throw new Error('auth/oauth/token returned an incomplete session payload');
        }
        const userObj = userRaw as Record<string, unknown>;
        const userId = typeof userObj.id === 'string' ? userObj.id : undefined;
        if (!userId) {
          throw new Error('auth/oauth/token returned a session without user.id');
        }
        const expiresInSec =
          typeof record.expires_in === 'number' ? record.expires_in : DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
        const expiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();
        if (accessToken) {
          this.setTokens(accessToken);
        }
        if (!deviceId || !deviceSecret) {
          logger.debug(
            'auth/oauth/token returned no device credential — this session lives only as long as its access token',
            { component: 'oxy.auth', method: 'exchangeOAuthCode' },
          );
        }
        return {
          sessionId,
          expiresAt,
          accessToken,
          // Omitted rather than set to `undefined` when the server sent no device
          // credential, so a device-less grant serializes as the absence it is.
          ...(deviceId ? { deviceId } : {}),
          ...(deviceSecret ? { deviceSecret } : {}),
          user: {
            id: userId,
            username: typeof userObj.username === 'string' ? userObj.username : undefined,
            avatar: typeof userObj.avatar === 'string' ? userObj.avatar : undefined,
          },
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Fetch OpenID Connect userinfo for the current bearer (`GET /auth/oauth/userinfo`).
     * The response is a flat JSON document — no `{ data }` wrapper.
     */
    async getOAuthUserInfo(): Promise<OAuthUserInfoResponse> {
      try {
        const res = await this.makeRequest<unknown>(
          'GET',
          '/auth/oauth/userinfo',
          undefined,
          { cache: false },
        );
        if (!res || typeof res !== 'object') {
          throw new Error('auth/oauth/userinfo returned an unexpected response shape');
        }
        const record = res as Record<string, unknown>;
        const sub = typeof record.sub === 'string' ? record.sub : undefined;
        if (!sub) {
          throw new Error('auth/oauth/userinfo returned a response without sub');
        }
        return {
          sub,
          ...(typeof record.preferred_username === 'string'
            ? { preferred_username: record.preferred_username }
            : {}),
          ...(typeof record.name === 'string' ? { name: record.name } : {}),
          ...(typeof record.picture === 'string' ? { picture: record.picture } : {}),
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
