/**
 * `oxy.auth` — signing in, signing up, and the account's credentials.
 *
 * - Key sign-in: {@link AuthApi.requestChallenge} → sign → {@link AuthApi.verifyChallenge}.
 * - Email: `auth.email` — a 6-digit code and a one-use link; also the code that
 *   confirms an email for sign-up.
 * - Password and authenticator: `auth.password`, `auth.totp`; a first factor on
 *   an account with an authenticator answers the second-factor step, finished
 *   with {@link AuthApi.completeSecondFactor}.
 * - OAuth (a relying party's PKCE code exchange): `auth.oauth`.
 * - "Sign in with Oxy" handoff to Commons (QR, push, deep link): `auth.commons`.
 *
 * Every call that can end in a session attaches THIS client's device proof
 * (`oxy.session.readDeviceProof()`, ADR 0029 D2) unless the caller passes
 * `device` itself (`null` opts out), and a session result plants its access
 * token on `oxy.session`.
 */
import type { User } from '../models/interfaces';
import type { CommonsDenyReason, DeviceProof, LoginResult } from '@oxy.so/contracts';
import {
  emailSignInLinkResponseSchema,
  emailSignInPendingSchema,
  emailSignInStartResponseSchema,
  emailVerificationConfirmResponseSchema,
  emailVerificationStartResponseSchema,
  loginResultSchema,
  safeParseContract,
  secondFactorRequiredSchema,
  signInMethodsSchema,
  totpBackupCodesResponseSchema,
  totpEnrollResponseSchema,
  type EmailSignInPending,
  type EmailSignInStartResponse,
  type EmailVerificationConfirmResponse,
  type EmailVerificationStartRequest,
  type EmailVerificationStartResponse,
  type ReauthAction,
  type ReauthProof,
  type SignInMethods,
  type SignInStepResult,
  type TotpEnrollResponse,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type { SessionLoginResponse } from '../models/session';
import type { PublicApplication } from './apps';
import { OxyAuthenticationError } from '../OxyServices.errors';
import { logger } from '../logger';
import { normalizeUserIdentity } from '../utils/userIdentity';

// The identity key, signatures and the registration proof-of-work load on first
// use: an app that never signs anything must not ship secp256k1.
const loadKeyManager = async () => (await import('../crypto/internal')).KeyManager;
const loadSignatureService = async () => (await import('../crypto/internal')).SignatureService;

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
 * costs the session is spelled out on `auth.oauth.exchangeCode` below.
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
 *   secret `sessionToken` for the first access token via `auth.claimSession`.
 * - `oauth_authorization` — the request additionally carries an OAuth binding
 *   ({@link CommonsOAuthContext}), so it finalizes into a single-use
 *   authorization CODE via {@link AuthCommonsApi.finalizeOAuth}.
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
 * Handle returned by {@link AuthCommonsApi.start} for a
 * relying-party app initiating a "Sign in with Oxy" flow.
 *
 * `sessionToken` is the SECRET, high-entropy device-flow credential — it stays
 * on the initiating client, is exchanged once via `auth.claimSession` (device
 * sign-in) or {@link AuthCommonsApi.finalizeOAuth} (OAuth), and is
 * NEVER placed in the QR/deep-link. `authorizeCode` is the PUBLIC handle carried
 * in `qrPayload`; the approver (Commons) resolves it via
 * {@link AuthCommonsApi.approvalInfo}.
 */
export interface CommonsSignInHandle {
  /** Secret device-flow token (held by the initiator; exchanged via `auth.claimSession`). */
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
   * {@link AuthCommonsApi.markOpened}; it is an
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
   * "not verified") by {@link AuthCommonsApi.approvalInfo}.
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
 * standard PKCE token exchange (`auth.oauth.exchangeCode`) with the `codeVerifier` it
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


/** The device-session fields a sign-in may carry. */
export interface SignInDeviceOptions {
  deviceName?: string;
  deviceFingerprint?: string;
  /** The device the session joins; defaults to the one this client holds. `null` opts out. */
  device?: DeviceProof | null;
}

/** The session a device-flow claim yields. */
export interface ClaimedSession {
  accessToken: string;
  sessionId: string;
  deviceId: string;
  expiresAt: string;
  user: User;
  deviceSecret?: string;
}

/** The body fields a session-ending call sends: the options, plus the device proof. */
async function signInEnvelope(ctx: OxyContext, options: SignInDeviceOptions = {}): Promise<Record<string, unknown>> {
  const { device: explicit, deviceName, deviceFingerprint } = options;
  const device = explicit === undefined ? await ctx.oxy.session.readDeviceProof() : explicit;
  return {
    ...(deviceName ? { deviceName } : {}),
    ...(deviceFingerprint ? { deviceFingerprint } : {}),
    ...(device ? { device } : {}),
  };
}

/** Parse a session, planting its token. */
function plantSession(ctx: OxyContext, res: unknown, path: string): LoginResult {
  const parsed = safeParseContract(loginResultSchema, res);
  if (!parsed) throw new Error(`${path} returned an unexpected response shape`);
  if (parsed.accessToken) ctx.oxy.session.setAccessToken(parsed.accessToken);
  return parsed;
}

/** Parse a first factor's answer: the second-factor step, or a session. */
function signInStep(ctx: OxyContext, res: unknown, path: string): SignInStepResult {
  const challenge = safeParseContract(secondFactorRequiredSchema, res);
  if (challenge) return challenge;
  return plantSession(ctx, res, path);
}

/** `oxy.auth.email` — email sign-in (code or link) and email confirmation codes. */
export class AuthEmailApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * Send a 6-digit code to the email of a new account
   * (`purpose: 'signup'`). The answer is the same whether or not the address
   * already has an account; nothing is revealed about who has one.
   */
  async startVerification(request: EmailVerificationStartRequest): Promise<EmailVerificationStartResponse> {
    const res = await this.ctx.request<unknown>('POST', '/auth/email/verify/start', request, {
      cache: false,
      skipAuth: true,
    });
    const parsed = safeParseContract(emailVerificationStartResponseSchema, res);
    if (!parsed) throw new Error('auth/email/verify/start returned an unexpected response shape');
    return parsed;
  }

  /**
   * Confirm the code {@link AuthEmailApi.startVerification} sent. Resolves to a
   * short-lived one-use ticket, which a sign-up passes (with the email) to
   * {@link AuthApi.signUp}.
   */
  async confirmVerification(verificationId: string, code: string): Promise<EmailVerificationConfirmResponse> {
    const res = await this.ctx.request<unknown>(
      'POST',
      '/auth/email/verify/confirm',
      { verificationId, code },
      { cache: false, skipAuth: true },
    );
    const parsed = safeParseContract(emailVerificationConfirmResponseSchema, res);
    if (!parsed) throw new Error('auth/email/verify/confirm returned an unexpected response shape');
    return parsed;
  }

  /**
   * Send the sign-in email (a code and a link) for a username or email. The
   * answer is the same whether or not the account exists. Keep
   * `requestSecret` in memory only.
   */
  async start(identifier: string, options: { device?: DeviceProof | null } = {}): Promise<EmailSignInStartResponse> {
    const device = options.device === undefined ? await this.ctx.oxy.session.readDeviceProof() : options.device;
    const res = await this.ctx.request<unknown>(
      'POST',
      '/auth/signin/email/start',
      { identifier, ...(device ? { device } : {}) },
      { cache: false, skipAuth: true },
    );
    const parsed = safeParseContract(emailSignInStartResponseSchema, res);
    if (!parsed) throw new Error('auth/signin/email/start returned an unexpected response shape');
    return parsed;
  }

  /**
   * The code from the email → a session, or the second-factor step. The code
   * is 6 digits, or the 10-character long code (`XXXXX-XXXXX`) an account
   * gets after too many guesses in a day — accept both in one field and pass
   * it as typed.
   */
  async confirm(
    request: { requestId: string; requestSecret: string; code: string } & SignInDeviceOptions,
  ): Promise<SignInStepResult> {
    const { requestId, requestSecret, code, ...options } = request;
    const res = await this.ctx.request<unknown>(
      'POST',
      '/auth/signin/email/confirm',
      { requestId, requestSecret, code, ...(await signInEnvelope(this.ctx, options)) },
      { cache: false, skipAuth: true },
    );
    return signInStep(this.ctx, res, 'auth/signin/email/confirm');
  }

  /**
   * Whether the email's link was opened in this browser: `{ status: 'pending' }`
   * until it was, then a session (or the second-factor step). Poll it.
   */
  async collect(
    request: { requestId: string; requestSecret: string } & SignInDeviceOptions,
  ): Promise<SignInStepResult | EmailSignInPending> {
    const { requestId, requestSecret, ...options } = request;
    const res = await this.ctx.request<unknown>(
      'POST',
      '/auth/signin/email/collect',
      { requestId, requestSecret, ...(await signInEnvelope(this.ctx, options)) },
      { cache: false, skipAuth: true },
    );
    const pending = safeParseContract(emailSignInPendingSchema, res);
    if (pending) return pending;
    return signInStep(this.ctx, res, 'auth/signin/email/collect');
  }

  /**
   * auth.oxy.so's link page: approve the request with THIS client's device
   * proof. It approves only in the browser that asked, and never returns a
   * session here — the app's dialog collects it.
   */
  async approveLink(token: string, device?: DeviceProof): Promise<{ approved: true }> {
    const proof = device ?? (await this.ctx.oxy.session.readDeviceProof());
    if (!proof) throw new Error('This browser holds no Oxy device to approve the sign-in with');
    const res = await this.ctx.request<unknown>(
      'POST',
      '/auth/signin/email/link',
      { token, device: proof },
      { cache: false, skipAuth: true },
    );
    const parsed = safeParseContract(emailSignInLinkResponseSchema, res);
    if (!parsed) throw new Error('auth/signin/email/link returned an unexpected response shape');
    return parsed;
  }

}

/** `oxy.auth.password` — password sign-in and setting the password. */
export class AuthPasswordApi {
  constructor(private readonly ctx: OxyContext) {}

  async signIn(request: { identifier: string; password: string } & SignInDeviceOptions): Promise<SignInStepResult> {
    const { identifier, password, ...options } = request;
    const res = await this.ctx.request<unknown>(
      'POST',
      '/auth/signin/password',
      { identifier, password, ...(await signInEnvelope(this.ctx, options)) },
      { cache: false, skipAuth: true },
    );
    return signInStep(this.ctx, res, 'auth/signin/password');
  }

  async set(request: { newPassword: string; reauth: ReauthProof; revokeOtherSessions?: boolean }): Promise<{ success: true }> {
    return this.ctx.request<{ success: true }>('PUT', '/users/me/password', request, { cache: false });
  }

}

/** `oxy.auth.totp` — the account’s authenticator app. */
export class AuthTotpApi {
  constructor(private readonly ctx: OxyContext) {}

  async enroll(): Promise<TotpEnrollResponse> {
    const res = await this.ctx.request<unknown>('POST', '/users/me/totp/enroll', undefined, { cache: false });
    const parsed = safeParseContract(totpEnrollResponseSchema, res);
    if (!parsed) throw new Error('users/me/totp/enroll returned an unexpected response shape');
    return parsed;
  }

  async confirm(code: string, reauth: ReauthProof): Promise<string[]> {
    const res = await this.ctx.request<unknown>('POST', '/users/me/totp/confirm', { code, reauth }, { cache: false });
    const parsed = safeParseContract(totpBackupCodesResponseSchema, res);
    if (!parsed) throw new Error('users/me/totp/confirm returned an unexpected response shape');
    return parsed.backupCodes;
  }

  async disable(reauth: ReauthProof): Promise<{ success: true }> {
    return this.ctx.request<{ success: true }>('POST', '/users/me/totp/disable', { reauth }, { cache: false });
  }

  async regenerateBackupCodes(reauth: ReauthProof): Promise<string[]> {
    const res = await this.ctx.request<unknown>('POST', '/users/me/totp/backup-codes', { reauth }, { cache: false });
    const parsed = safeParseContract(totpBackupCodesResponseSchema, res);
    if (!parsed) throw new Error('users/me/totp/backup-codes returned an unexpected response shape');
    return parsed.backupCodes;
  }

}

/** `oxy.auth.oauth` — a relying party’s OAuth authorization-code exchange. */
export class AuthOAuthApi {
  constructor(private readonly ctx: OxyContext) {}

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
  async exchangeCode(params: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<OAuthTokenExchangeResult> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    });
    const res = await this.ctx.request<unknown>(
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
      this.ctx.oxy.session.setAccessToken(accessToken);
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
  }

  /**
   * Fetch OpenID Connect userinfo for the current bearer (`GET /auth/oauth/userinfo`).
   * The response is a flat JSON document — no `{ data }` wrapper.
   */
  async userInfo(): Promise<OAuthUserInfoResponse> {
    const res = await this.ctx.request<unknown>(
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
  }

}

/**
 * `oxy.auth.commons` — "Sign in with Oxy": a relying party hands a sign-in to
 * Commons (QR, push, deep link, popup), and Commons approves or denies it.
 *
 * Relying party: {@link AuthCommonsApi.start} → {@link AuthCommonsApi.poll}
 * (or the auth socket) → finalize with `oxy.auth.claimSession` (device sign-in)
 * or {@link AuthCommonsApi.finalizeOAuth} (OAuth). Approver (Commons):
 * {@link AuthCommonsApi.approvalInfo} → {@link AuthCommonsApi.approve} /
 * {@link AuthCommonsApi.deny}. The approver signs with its PRIMARY local key;
 * the relying party never sees the private key.
 */
export class AuthCommonsApi {
  constructor(private readonly ctx: OxyContext) {}

  /**
   * MECHANISM B (relying party) — begin a "Sign in with Oxy" handoff.
   *
   * Generates a secret device-flow `sessionToken` client-side (it never
   * appears in the QR), registers it with `POST /auth/session/create`, and
   * returns the server-issued public `authorizeCode` + ready-to-render
   * `qrPayload`. Render the QR (web) / open the deep-link (same-device); the
   * approver resolves the code and authorizes. Then poll with
   * {@link AuthCommonsApi.poll} and finalize.
   *
   * ONE request serves every delivery surface, and how it finalizes is decided
   * here by whether an OAuth binding is attached:
   *   - no `oauth` (the default): a `device_sign_in` request — on `authorized`,
   *     exchange the `sessionToken` via the existing `auth.claimSession`.
   *   - with `oauth`: an `oauth_authorization` request — on `authorized`, call
   *     {@link AuthCommonsApi.finalizeOAuth} with the same `sessionToken` to mint the
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
  async start(params: {
    clientId: string;
    oauth?: CommonsOAuthContext;
  }): Promise<CommonsSignInHandle> {
    // High-entropy opaque secret token (256-bit hex). Generated client-side
    // and held only here; the server stores it but never returns it in the
    // QR. Reuses the platform-safe random generator.
    const sessionToken = await (await loadSignatureService()).generateChallenge();
    const expiresAt = Date.now() + COMMONS_SIGN_IN_EXPIRY_MS;

    const res = await this.ctx.request<CommonsSessionCreateResponse>(
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
  }

  /**
   * MECHANISM B (relying party) — poll a device-flow session for approval.
   *
   * Backstop for the auth socket. On `authorized` (with a `sessionId`), the
   * caller finalizes: `auth.claimSession` for a `device_sign_in` request,
   * {@link AuthCommonsApi.finalizeOAuth} for an `oauth_authorization` one.
   *
   * Every field is narrowed fail-safe. `authorized` counts only as a literal
   * `true`, the identifiers only as non-empty strings, and the delivery
   * progress timestamps degrade to `null` when absent or unparseable — so a
   * partial or older-API payload can advance the waiting UI at most, never
   * make it believe a request was approved.
   *
   * @param sessionToken - The secret token from {@link AuthCommonsApi.start}.
   */
  async poll(sessionToken: string): Promise<CommonsSignInStatus> {
    const res = await this.ctx.request<unknown>(
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
   * everything it shows from `auth.commons.approvalInfo`.
   *
   * @param authorizeCode - The public code from {@link AuthCommonsApi.start}.
   */
  async deliver(authorizeCode: string): Promise<CommonsDeliveryResult> {
    const res = await this.ctx.request<unknown>(
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
  async markOpened(authorizeCode: string): Promise<void> {
    await this.ctx.request<unknown>(
      'POST',
      `/auth/session/opened/${encodeURIComponent(authorizeCode)}`,
      undefined,
      // Public (no bearer) — skip the preflight, exactly like approve-info.
      { cache: false, skipAuth: true },
    );
  }

  /**
   * MECHANISM B (relying party) — finalize an APPROVED, OAuth-bound request
   * into a single-use OAuth authorization code.
   *
   * The OAuth counterpart of `auth.claimSession`: same secret credential,
   * same single-use semantics, different output. Call it once the request the
   * RP started with an `oauth` binding reports `authorized`; the server
   * atomically mints exactly ONE `AuthCode` bound to the redirect URI, PKCE
   * challenge, scopes, approving identity, and any delegated subject account
   * the request was created with. A second call cannot mint another code.
   *
   * The result is an authorization CODE, never a token — the caller completes
   * the flow with the ordinary PKCE exchange (`auth.oauth.exchangeCode`) using the
   * `codeVerifier` it never sent anywhere. Nothing here is exposed to the
   * popup: the code travels back through the registered callback, and the
   * main window owns the verifier.
   *
   * Like `auth.claimSession`, this needs no Authorization header — the
   * high-entropy SECRET `sessionToken` IS the credential. Never pass the
   * public `authorizeCode` here; it is the approver's handle, not the
   * initiator's. Every server-side failure (wrong/expired/already-finalized
   * request, non-OAuth purpose, missing permission for the delegated account)
   * surfaces as one generic error, so nothing about the request's state can be
   * probed from outside.
   *
   * @param sessionToken - The secret token from {@link AuthCommonsApi.start}.
   */
  async finalizeOAuth(sessionToken: string): Promise<CommonsOAuthFinalizeResult> {
    const res = await this.ctx.request<unknown>(
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
  async approvalInfo(authorizeCode: string): Promise<CommonsApprovalInfo> {
    const raw = await this.ctx.request<CommonsApprovalInfoResponse>(
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
  async approve(params: {
    authorizeCode: string;
    deviceName?: string;
    deviceFingerprint?: string;
  }): Promise<CommonsSignInActionResult> {
    const publicKey = await (await loadKeyManager()).getPublicKey();
    if (!publicKey) {
      throw new Error('No identity found on this device. Create or import an identity first.');
    }

    const { challenge } = await this.ctx.oxy.auth.requestChallenge(publicKey);
    const signed = await (await loadSignatureService()).signChallenge(challenge);

    return this.ctx.request<CommonsSignInActionResult>(
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
  async deny(
    authorizeCode: string,
    reason?: CommonsDenyReason,
  ): Promise<CommonsSignInActionResult> {
    return this.ctx.request<CommonsSignInActionResult>(
      'POST',
      `/auth/session/deny/${encodeURIComponent(authorizeCode)}`,
      reason ? { reason } : undefined,
      // Public (no auth required) — skip the bearer preflight.
      { cache: false, skipAuth: true }
    );
  }

}

export class AuthApi {
  /** Email sign-in and email confirmation codes. */
  readonly email: AuthEmailApi;
  /** Password sign-in and setting the password. */
  readonly password: AuthPasswordApi;
  /** The account's authenticator app. */
  readonly totp: AuthTotpApi;
  /** OAuth authorization-code exchange. */
  readonly oauth: AuthOAuthApi;
  /** "Sign in with Oxy" handoff to Commons. */
  readonly commons: AuthCommonsApi;

  constructor(private readonly ctx: OxyContext) {
    this.email = new AuthEmailApi(ctx);
    this.password = new AuthPasswordApi(ctx);
    this.totp = new AuthTotpApi(ctx);
    this.oauth = new AuthOAuthApi(ctx);
    this.commons = new AuthCommonsApi(ctx);
  }

  /**
   * Register a new identity with public key authentication
   * Identity is purely cryptographic - username and profile data are optional
   * 
   * @param publicKey - The user's ECDSA public key (hex)
   * @param signature - Signature of the registration request
   * @param timestamp - Timestamp when the signature was created
   */
  async registerKey(
    publicKey: string,
    signature: string,
    timestamp: number
  ): Promise<{ message: string; user: User }> {
    // Advisory for now (server soft-enforces — see
    // `SessionController.register`), but solved unconditionally so every
    // client is already sending it once the server starts requiring it.
    const { solveRegistrationPow } = await import('../crypto/internal');
    const powNonce = await solveRegistrationPow(publicKey, timestamp);

    const res = await this.ctx.request<{ message: string; user: User }>('POST', '/auth/register', {
      publicKey,
      signature,
      timestamp,
      powNonce,
    }, { cache: false, skipAuth: true });

    if (!res || (typeof res === 'object' && Object.keys(res).length === 0)) {
      throw new OxyAuthenticationError('Registration failed', 'REGISTER_FAILED', 400);
    }

    return res;
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
    return this.ctx.request<ChallengeResponse>('POST', '/auth/challenge', {
      publicKey,
    }, { cache: false, skipAuth: true, ...requestOptions });
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
   * @param options.plantTokens - Install the returned bearer on this client
   *   (default `true`). A caller that must decide LATER whether the session is
   *   still wanted (the account dialog, whose user may have cancelled while the
   *   request was in flight) passes `false` and plants it itself.
   */
  async verifyChallenge(
    publicKey: string,
    challenge: string,
    signature: string,
    timestamp: number,
    deviceName?: string,
    deviceFingerprint?: string,
    requestOptions?: { retry?: boolean; timeout?: number },
    options: { plantTokens?: boolean } = {},
  ): Promise<SessionLoginResponse> {
    const res = await this.ctx.request<SessionLoginResponse>('POST', '/auth/verify', {
      publicKey,
      challenge,
      signature,
      timestamp,
      deviceName,
      deviceFingerprint,
    }, { cache: false, skipAuth: true, ...requestOptions });

    // Plant the freshly-minted tokens, mirroring `auth.claimSession`.
    // `/auth/verify` returns the first access token (and refresh token) in
    // its body, so installing it here means callers get an authenticated
    // client without a second round-trip. Refresh stays in the httpOnly
    // cookie slot set by the API.
    if (res?.accessToken && options.plantTokens !== false) {
      this.ctx.oxy.session.setAccessToken(res.accessToken);
    }

    return {
      ...res,
      user: normalizeUserIdentity(res.user),
    };
  }

  /**
   * Check if a public key is already registered
   */
  async isKeyRegistered(publicKey: string): Promise<PublicKeyCheckResponse> {
    return this.ctx.request<PublicKeyCheckResponse>(
      'GET',
      `/auth/check-publickey/${encodeURIComponent(publicKey)}`,
      undefined,
      { cache: false, skipAuth: true }
    );
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
   * @param options.plantTokens - Install the claimed bearer on this client
   *   (default `true`). Pass `false` to install it yourself once you know the
   *   session is still wanted — see `verifyChallenge`.
   */
  async claimSession(
    sessionToken: string,
    options: { deviceFingerprint?: string; plantTokens?: boolean; device?: DeviceProof | null } = {}
  ): Promise<ClaimedSession> {
    // The device this client holds, so an official app's claim joins it
    // (ADR 0029 D2). `null` opts out explicitly.
    const device = options.device === undefined ? await this.ctx.oxy.session.readDeviceProof() : options.device;
    const res = await this.ctx.request<ClaimedSession>(
      'POST',
      '/auth/session/claim',
      {
        sessionToken,
        ...(options.deviceFingerprint ? { deviceFingerprint: options.deviceFingerprint } : {}),
        ...(device ? { device } : {}),
      },
      // Body-authenticated device-flow claim (no bearer) — skip the preflight.
      { cache: false, retry: false, skipAuth: true }
    );

    if (options.plantTokens !== false) {
      this.ctx.oxy.session.setAccessToken(res.accessToken);
    }

    return res;
  }

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
   * (`@oxy.so/services`); this method just performs the exchange.
   *
   * @param opts.requestOptions - Optional per-call transport overrides
   *   (`retry`, `timeout`) forwarded to BOTH the `requestChallenge` and
   *   `verifyChallenge` round-trips. Interactive flows omit it (defaults keep
   *   retries); the cold-boot `shared-key-signin` step passes `{ retry: false }`
   *   so this network step cannot multiply boot latency via the inner retry
   *   loop. The token-refresh scheduler / 401 lane still retry later.
   * @param opts.plantTokens - Forwarded to `verifyChallenge` (default `true`).
   */
  async signInWithSharedIdentity(
    opts: {
      deviceName?: string;
      deviceFingerprint?: string;
      requestOptions?: { retry?: boolean; timeout?: number };
      plantTokens?: boolean;
    } = {}
  ): Promise<SessionLoginResponse | null> {
    // `hasSharedIdentity()` already returns false on web (the shared
    // keychain is native-only), so this short-circuits the web case without
    // a wasted challenge round-trip.
    const KeyManager = await loadKeyManager();
    if (!(await KeyManager.hasSharedIdentity())) {
      return null;
    }
    const sharedPublicKey = await KeyManager.getSharedPublicKey();
    if (!sharedPublicKey) {
      return null;
    }

    const { challenge } = await this.requestChallenge(sharedPublicKey, opts.requestOptions);
    const signed = await (await loadSignatureService()).signChallengeWithSharedKey(challenge);

    // `signed.challenge` carries the SIGNATURE (mirrors `signChallenge`).
    return await this.verifyChallenge(
      signed.publicKey,
      challenge,
      signed.challenge,
      signed.timestamp,
      opts.deviceName,
      opts.deviceFingerprint,
      opts.requestOptions,
      { plantTokens: opts.plantTokens },
    );
  }

  /**
   * Check username availability
   */
  async checkUsername(username: string): Promise<{ available: boolean; message: string }> {
    // Public availability lookup (pre-session) — skip the bearer preflight.
    return this.ctx.request('GET', `/auth/check-username/${username}`, undefined, { cache: false, skipAuth: true });
  }

  /**
   * The authenticator's code (or a backup code) for a first factor's
   * challenge → the session. Send the same device proof the first factor did
   * (the default does).
   */
  async completeSecondFactor(request: { challengeId: string; code: string } & SignInDeviceOptions): Promise<LoginResult> {
    const { challengeId, code, ...options } = request;
    const res = await this.ctx.request<unknown>(
      'POST',
      '/auth/signin/second-factor',
      { challengeId, code, ...(await signInEnvelope(this.ctx, options)) },
      { cache: false, skipAuth: true },
    );
    return plantSession(this.ctx, res, 'auth/signin/second-factor');
  }

  async signUp(request: { username: string; email: string; emailTicket: string } & SignInDeviceOptions): Promise<LoginResult> {
    const { username, email, emailTicket, ...options } = request;
    const res = await this.ctx.request<unknown>(
      'POST',
      '/auth/signup',
      { username, email, emailTicket, ...(await signInEnvelope(this.ctx, options)) },
      { cache: false, skipAuth: true },
    );
    return plantSession(this.ctx, res, 'auth/signup');
  }

  async methods(): Promise<SignInMethods> {
    const res = await this.ctx.request<unknown>('GET', '/users/me/sign-in-methods', undefined, { cache: false });
    const parsed = safeParseContract(signInMethodsSchema, res);
    if (!parsed) throw new Error('users/me/sign-in-methods returned an unexpected response shape');
    return parsed;
  }

  /**
   * Send a confirmation code to the signed-in account's email, for a
   * `reauth: { emailCode: { verificationId, code } }` proof of ONE change:
   * the code works only for the `action` it was asked for, and the email
   * names it.
   */
  async requestReauthCode(action: ReauthAction): Promise<EmailVerificationStartResponse> {
    const res = await this.ctx.request<unknown>('POST', '/users/me/reauth/email', { action }, { cache: false });
    const parsed = safeParseContract(emailVerificationStartResponseSchema, res);
    if (!parsed) throw new Error('users/me/reauth/email returned an unexpected response shape');
    return parsed;
  }

}
