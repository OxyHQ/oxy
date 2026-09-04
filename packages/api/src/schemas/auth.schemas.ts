import { commonsDenyReasonSchema, usernameSchema } from '@oxyhq/contracts';
import { z } from 'zod';

const deviceIdField = z.string().trim().min(1).max(128).optional();


// POST /auth/register (public key)
export const registerPublicKeySchema = z.object({
  publicKey: z.string().trim().min(1),
  signature: z.string().trim().min(1),
  timestamp: z.number(),
  email: z.string().trim().email().optional(),
  username: usernameSchema.optional(),
});

// POST /auth/challenge
export const challengeSchema = z.object({
  publicKey: z.string().trim().min(1),
});

// POST /auth/verify
export const verifyChallengeSchema = z.object({
  publicKey: z.string().trim().min(1),
  challenge: z.string().trim().min(1),
  signature: z.string().trim().min(1),
  timestamp: z.number(),
  deviceName: z.string().trim().optional(),
  deviceFingerprint: z.string().trim().optional(),
  // No `deviceId`: this body is unauthenticated, and `createSession` treats an
  // explicit device id as authoritative over everything else it derives.
});

/**
 * GET /auth/check-username/:username
 *
 * The availability check answers a question about a WRITE, so it holds the
 * candidate to the write policy. Its predecessor bounded the length and nothing
 * else, which meant the UI could be told `al ice` was "available" and then be
 * 400ed for asking for it.
 */
export const checkUsernameParams = z.object({
  username: usernameSchema,
});

// GET /auth/check-email/:email
export const checkEmailParams = z.object({
  email: z.string().trim().email(),
});

// GET /auth/check-publickey/:publicKey
export const checkPublicKeyParams = z.object({
  publicKey: z.string().trim().min(1),
});

// GET /auth/user/:publicKey
export const getUserByPublicKeyParams = z.object({
  publicKey: z.string().trim().min(1),
});

// POST /auth/session/create
//
// A cross-app auth session is ALWAYS bound to a registered Application. The
// caller must identify it with exactly one of:
//   - `clientId`      an ApplicationCredential.publicKey / OAuth client_id, or
//   - `applicationId` an Application _id.
// There is no free-form app label.
//
// An OPTIONAL `oauth` block turns the session into an OAuth authorization
// request (`purpose: 'oauth_authorization'`) that finalizes into a single-use
// `AuthCode` instead of a device sign-in claim. It carries only the MINIMUM
// request binding — nothing already owned by `Application`, `AuthCode` or
// `DeviceSession`. The RP-owned `state` never reaches the server.
export const authSessionOAuthContextSchema = z.object({
  redirectUri: z.string().trim().url(),
  /** PKCE is MANDATORY for an OAuth-bound session (no confidential-client path here). */
  codeChallenge: z.string().trim().min(43).max(128),
  /** S256 only — `plain` is rejected outright, per current OAuth BCP. */
  codeChallengeMethod: z.literal('S256'),
  /** Space-separated, normalized exactly like `POST /auth/oauth/authorize`. */
  scope: z.string().trim().max(512).optional(),
  /** Delegated account the app will act AS; permission is verified server-side. */
  subjectAccountId: z.string().trim().min(1).max(64).optional(),
});

export const authSessionCreateSchema = z.object({
  sessionToken: z.string().trim().min(1),
  clientId: z.string().trim().min(1).optional(),
  applicationId: z.string().trim().min(1).optional(),
  expiresAt: z.union([z.string(), z.number()]).optional(),
  /** Originating RP device id — converges QR sign-in onto the same DeviceSession. */
  deviceId: deviceIdField,
  oauth: authSessionOAuthContextSchema.optional(),
}).refine(
  (data) => Boolean(data.clientId) || Boolean(data.applicationId),
  { message: 'Either clientId or applicationId is required' }
).refine(
  // The redirect URI is matched against the OAuth client's registered
  // allowlist, so an OAuth-bound session must be identified by its client_id —
  // an `applicationId`-only reference has no credential to bind to.
  (data) => !data.oauth || Boolean(data.clientId),
  { message: 'clientId is required for an OAuth-bound session' }
);

// :sessionToken path param — the SECRET credential held only by the originating
// client. Shared by GET /auth/session/status, POST /auth/session/authorize,
// POST /auth/session/cancel and POST /auth/session/finalize.
export const authSessionTokenParams = z.object({
  sessionToken: z.string().trim().min(1),
});

// POST /auth/session/authorize/:sessionToken
export const authorizeSessionBodySchema = z.object({
  deviceName: z.string().trim().optional(),
  deviceFingerprint: z.string().trim().optional(),
});

// :authorizeCode path param — the public single-use approval handle from the QR.
export const authorizeCodeParams = z.object({
  authorizeCode: z.string().trim().min(1).max(256),
});

// POST /auth/session/authorize-signed/:authorizeCode
// Key-signed approval (the Commons vault approves with its local key, NOT a
// bearer token). The challenge/signature/timestamp prove control of `publicKey`;
// the resolved signer becomes the authorizing user. Cookieless → no CSRF.
export const authSessionAuthorizeSignedSchema = z.object({
  publicKey: z.string().trim().min(1),
  challenge: z.string().trim().min(1),
  signature: z.string().trim().min(1),
  timestamp: z.number(),
  deviceName: z.string().trim().optional(),
  deviceFingerprint: z.string().trim().optional(),
});

// POST /auth/session/deny/:authorizeCode
// Optional reason from the closed `COMMONS_DENY_REASONS` set, whose single
// declaration lives in `@oxyhq/contracts` — the same one the persisted
// `AuthSession.deniedReason` enum and the client SDK read. Anything outside it
// (including a free-form string) is rejected with 400 before the handler runs.
export const authSessionDenySchema = z.object({
  reason: commonsDenyReasonSchema.optional(),
});

// POST /auth/session/claim
// Exchange a 128-bit `sessionToken` (held only by the originating client)
// for the first access token after another authenticated device has
// approved the session via /auth/session/authorize/:sessionToken.
// No bearer header is required — the `sessionToken` IS the credential.
// Single-use, time-bound, status-bound (must be 'authorized').
export const authSessionClaimSchema = z.object({
  sessionToken: z.string().trim().min(1).max(256),
  // Optional device fingerprint of the originating client. We don't
  // require it because RN/web SDKs may not have one, but when supplied
  // we record it on the new session so the device list shows the
  // correct device, not the authorizer's.
  deviceFingerprint: z.string().trim().max(512).optional(),
});

// POST /auth/service-token
export const serviceTokenSchema = z.object({
  apiKey: z.string().trim().min(1),
  apiSecret: z.string().trim().min(1),
});

// POST /auth/oauth/authorize
// Issued from the auth UI after the user clicks "Allow". Requires the user
// to be authenticated via Bearer token; the client passes the OAuth client
// id and the registered redirect URI to bind into a single-use code.
export const oauthAuthorizeSchema = z.object({
  clientId: z.string().trim().min(1),
  redirectUri: z.string().trim().url(),
  state: z.string().trim().min(1).max(512).optional(),
  /** PKCE — required for public clients (no clientSecret). */
  codeChallenge: z.string().trim().min(43).max(128).optional(),
  codeChallengeMethod: z.literal('S256').optional(),
  scope: z.string().trim().max(512).optional(),
});

// POST /auth/oauth/token — RFC 6749 §4.1.3 `authorization_code` grant.
//
// snake_case because these are the wire parameter NAMES the RFC defines, not a
// house naming choice: a standard OAuth client sends exactly these keys in an
// `application/x-www-form-urlencoded` body.
//
// `client_id` is optional HERE because a confidential client may instead supply
// it through HTTP Basic (RFC 6749 §2.3.1); the route requires one to have
// arrived by one route or the other. `grant_type` is validated BEFORE this
// schema so an unknown grant reports `unsupported_grant_type` rather than a
// generic `invalid_request`.
//
// Confidential clients pass `client_secret`. Public clients pass `code_verifier`
// (PKCE); the route requires one of the two.
export const oauthTokenSchema = z.object({
  code: z.string().trim().min(1),
  redirect_uri: z.string().trim().url(),
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
  code_verifier: z.string().trim().min(43).max(128).optional(),
});

// GET /auth/oauth/client/:clientId
// Public lookup of sanitized application metadata for the consent UI.
export const oauthClientParams = z.object({
  clientId: z.string().trim().min(1),
});

// GET /auth/oauth/consent
// Server-authoritative decision on whether the consent screen must be shown for
// (user, app, scopes). `clientId` + `redirectUri` are resolved/validated exactly
// like POST /auth/oauth/authorize; `scope` is the optional space-separated set.
export const oauthConsentQuerySchema = z.object({
  clientId: z.string().trim().min(1),
  redirectUri: z.string().trim().url(),
  scope: z.string().trim().max(512).optional(),
});

// DELETE /auth/grants/:applicationId
// Revoke the user's OAuth grant for a connected third-party application.
export const grantApplicationIdParams = z.object({
  applicationId: z.string().trim().min(1),
});
