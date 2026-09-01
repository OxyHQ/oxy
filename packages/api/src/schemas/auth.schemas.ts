import { commonsDenyReasonSchema } from '@oxyhq/contracts';
import { z } from 'zod';
import { INVALID_USERNAME_MESSAGE, USERNAME_PATTERN } from '../utils/username';

const deviceIdField = z.string().trim().min(1).max(128).optional();

/**
 * A username is a routing key (`/@alice`, `acct:alice@…`), not prose. The length
 * bounds alone accepted `"al ice"` — the pattern is what actually rejects
 * whitespace and punctuation. The signup / registration controllers enforce the
 * same rule; declaring it on the schema means the request never reaches them.
 */
const usernameField = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(USERNAME_PATTERN, INVALID_USERNAME_MESSAGE);

// POST /auth/register (public key)
export const registerPublicKeySchema = z.object({
  publicKey: z.string().trim().min(1),
  signature: z.string().trim().min(1),
  timestamp: z.number(),
  email: z.string().trim().email().optional(),
  username: usernameField.optional(),
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
  deviceId: deviceIdField,
});

// GET /auth/check-username/:username
export const checkUsernameParams = z.object({
  username: z.string().trim().min(3).max(30),
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

// POST /auth/oauth/token
// Confidential clients pass clientSecret. Public clients pass codeVerifier.
export const oauthTokenSchema = z.object({
  code: z.string().trim().min(1),
  clientId: z.string().trim().min(1),
  redirectUri: z.string().trim().url(),
  clientSecret: z.string().trim().min(1).optional(),
  codeVerifier: z.string().trim().min(43).max(128).optional(),
}).refine(
  (data) => Boolean(data.clientSecret) || Boolean(data.codeVerifier),
  { message: 'Either clientSecret (confidential client) or codeVerifier (PKCE) is required' }
);

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
