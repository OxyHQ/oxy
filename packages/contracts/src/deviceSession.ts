import { integerCheck } from './numberChecks';
import { urlCheck, utf16MaxLength, utf16MinLength } from './stringChecks';
import { z } from 'zod';
// The Zod-free half of this contract lives in `./client/` (`@oxy.so/contracts/client`);
// it is re-exported here so the root entry is unchanged.
import { SESSION_ACCOUNTS_CHANGED_EVENT } from './client/deviceSession';
export { SESSION_ACCOUNTS_CHANGED_EVENT } from './client/deviceSession';

export const sessionAccountSchema = z.object({
  accountId: z.string(),
  sessionId: z.string(),
  authuser: z.number().check(integerCheck()).nonnegative(),
  operatedByUserId: z.string().optional(),
});

export const deviceSessionStateSchema = z.object({
  deviceId: z.string(),
  accounts: z.array(sessionAccountSchema),
  activeAccountId: z.string().nullable(),
  revision: z.number().check(integerCheck()).nonnegative(),
  updatedAt: z.number(),
});

export const activeTokenSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
});

export const deviceSessionSyncSchema = z.object({
  state: deviceSessionStateSchema,
  activeToken: activeTokenSchema.nullable(),
});

export type SessionAccount = z.infer<typeof sessionAccountSchema>;
export type DeviceSessionState = z.infer<typeof deviceSessionStateSchema>;
export type ActiveToken = z.infer<typeof activeTokenSchema>;
export type DeviceSessionSync = z.infer<typeof deviceSessionSyncSchema>;

/* -------------------------------------------------------------------------- */
/*  Device-secret token mint (phase 2c — zero-cookie transport)               */
/* -------------------------------------------------------------------------- */

/**
 * Request body for `POST /session/device/token` — the client presents the
 * `deviceId` it stored first-party plus the opaque `deviceSecret`. NO bearer:
 * possession of the secret IS the proof of device ownership. The server looks
 * `sha256(deviceSecret)` up among the device's holder credentials (one per app
 * or origin that joined the shared DeviceSession) and mints a short access
 * token for the device's active account.
 *
 * `accountId` pins the mint to ONE account of that device instead of whichever
 * account is currently active. It exists for identity-bound clients (Commons),
 * whose authenticated user is determined by a local cryptographic key and must
 * never follow an account switch made by another app on the same device. The
 * account must already be a member of the device session; the mint NEVER
 * mutates `activeAccountId`, so pinning is read-only with respect to the device
 * state every other app observes.
 */
export const deviceTokenMintRequestSchema = z.object({
  deviceId: z.string().check(utf16MinLength(1)),
  deviceSecret: z.string().check(utf16MinLength(1)),
  accountId: z.string().check(utf16MinLength(1)).optional(),
});

/**
 * Wire shape of a successful `POST /session/device/token`: the freshly-minted
 * short access token for the active account, its expiry, the device secret the
 * client must persist (`nextDeviceSecret` — on mint this echoes the presented
 * secret unchanged so concurrent refreshes from multiple origins do not race),
 * and the projected device-session state. Nothing rotates: each sign-in issues
 * a NEW holder credential and leaves the others valid.
 */
export const deviceTokenMintResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  nextDeviceSecret: z.string(),
  state: deviceSessionStateSchema,
});

export type DeviceTokenMintRequest = z.infer<typeof deviceTokenMintRequestSchema>;
export type DeviceTokenMintResponse = z.infer<typeof deviceTokenMintResponseSchema>;

/** Holder-proven active-context token; it does not freeze the account graph. */
export const deviceContextTokenV1ResponseSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().check(utf16MinLength(1)),
  deviceSessionId: z.string().check(utf16MinLength(1)),
  revision: z.number().check(integerCheck()).nonnegative(),
  contextId: z.string().check(utf16MinLength(1)),
  actorId: z.string().check(utf16MinLength(1)),
  accountId: z.string().check(utf16MinLength(1)),
  sessionId: z.string().check(utf16MinLength(1)),
  accessToken: z.string().check(utf16MinLength(1)),
  expiresAt: z.string().check(utf16MinLength(1)),
});

export type DeviceContextTokenV1Response = z.infer<typeof deviceContextTokenV1ResponseSchema>;

/**
 * Why the signed-in set changed:
 *  - `login`   — a brand-new session was minted for the user (QR / cross-app authorize)
 *  - `add`     — an account was registered onto a device set
 *  - `switch`  — the active account on a device changed
 *  - `signout` — one or all accounts were signed out of a device
 *  - `revoke`  — a dead/revoked account was healed out of a device set
 */
export const sessionAccountsChangedReasonSchema = z.enum([
  'login',
  'add',
  'switch',
  'signout',
  'revoke',
]);

/**
 * Payload of {@link SESSION_ACCOUNTS_CHANGED_EVENT}. `revision` is the mutated
 * DeviceSession revision for device-scoped reasons (`add`/`switch`/`signout`/
 * `revoke`); for `login` (no device mutation at emit time) it is `0`. The
 * payload is deliberately minimal and secret-free — the client refetches.
 */
export const sessionAccountsChangedEventSchema = z.object({
  userId: z.string(),
  revision: z.number().check(integerCheck()).nonnegative(),
  reason: sessionAccountsChangedReasonSchema,
});

export type SessionAccountsChangedReason = z.infer<typeof sessionAccountsChangedReasonSchema>;
export type SessionAccountsChangedEvent = z.infer<typeof sessionAccountsChangedEventSchema>;

/* -------------------------------------------------------------------------- */
/*  Background credential — native background code with no JS runtime         */
/* -------------------------------------------------------------------------- */

/**
 * Response from `POST /session/device/background-credential` — provisioned by
 * the SDK WHILE THE APP IS RUNNING (bearer required, `deviceId` and account
 * derived server-side from it) and consumed afterwards only by native
 * background code, which has no JS runtime to mint a token for itself.
 *
 * Deliberately a SEPARATE credential from the holder `deviceSecret`: that one
 * is device-wide and mints for whichever account is active, while this one is
 * bound to ONE account and expires, so a widget worker never holds a
 * credential that reaches every account on the device. Background code is its
 * sole writer and never touches anything JS reads.
 *
 * The raw `secret` is returned exactly once, at provision time — never stored
 * retrievably, never logged, never re-read. A caller that loses it provisions
 * a new one.
 *
 * `expiresAt` is an unvalidated string, like every other expiry in this file:
 * no consumer on the JS path interprets it (native background code parses it
 * itself), and a `.datetime()` here alone would leave one strict field beside
 * two lax ones. If expiry is ever validated it goes on all three at once, with
 * the API's serializers checked against it — the producer is the same server.
 */
export const deviceBackgroundCredentialResponseSchema = z.object({
  deviceId: z.string().check(utf16MinLength(1)),
  secret: z.string().check(utf16MinLength(1)),
  accountId: z.string().check(utf16MinLength(1)),
  expiresAt: z.string(),
});

/**
 * Request body for `POST /session/device/background-token` — presented by
 * native background code with NO bearer and NO cookies: possession of the
 * background `secret` IS the proof, as it is for the device-secret mint.
 *
 * Like that mint this one NEVER rotates the presented secret, and it carries
 * no `next…` field at all, so background code interrupted anywhere between
 * request and response leaves the credential intact and usable on its next
 * run.
 */
export const deviceBackgroundTokenRequestSchema = z.object({
  deviceId: z.string().check(utf16MinLength(1)),
  secret: z.string().check(utf16MinLength(1)),
});

/**
 * Wire shape of a successful `POST /session/device/background-token`: the short
 * access token, its expiry, and the account the token belongs to — the last so
 * a caller can key cached data per account and drop data belonging to a
 * foreign one.
 *
 * Carries NO device state — no account list, no `activeAccountId`, no
 * `revision`, unlike {@link deviceTokenMintResponseSchema} — deliberately, to
 * cap what a compromised credential record yields.
 */
export const deviceBackgroundTokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  accountId: z.string().check(utf16MinLength(1)),
});

export type DeviceBackgroundCredentialResponse = z.infer<
  typeof deviceBackgroundCredentialResponseSchema
>;
export type DeviceBackgroundTokenRequest = z.infer<typeof deviceBackgroundTokenRequestSchema>;
export type DeviceBackgroundTokenResponse = z.infer<typeof deviceBackgroundTokenResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  The browser bridge — joining the browser's DeviceSession (ADR 0029 D2)    */
/* -------------------------------------------------------------------------- */

/**
 * Proof that the caller holds a device: the `deviceId` it stored first-party and
 * one of that device's holder secrets. Sent with `POST /session/device/join-code`
 * and, optionally, with a sign-in (`POST /auth/session/claim`, the email,
 * password and second-factor sign-ins, `POST /auth/signup`), where
 * a valid proof puts the new session on THAT device so every app holding it sees
 * the account. An invalid proof on a sign-in is ignored, never an error.
 */
export const deviceProofSchema = z.object({
  deviceId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(128)),
  deviceSecret: z.string().check(utf16MinLength(1)).check(utf16MaxLength(256)),
});

/**
 * `POST /session/device/register` — auth.oxy.so only. No body. A new, empty
 * DeviceSession with a server-chosen `deviceId` and ONE holder credential for
 * auth.oxy.so. The raw secret is returned exactly once.
 */
export const deviceRegisterResponseSchema = z.object({
  deviceId: z.string().check(utf16MinLength(1)),
  deviceSecret: z.string().check(utf16MinLength(1)),
});

/** PKCE S256 challenge: base64url of a SHA-256 digest (43 characters). */
const pkceS256ChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * `POST /session/device/join-code` — auth.oxy.so only (the bridge window). Proves
 * auth.oxy.so's device and asks for a one-use code an official app redeems to
 * join it. The code is bound to the application (`clientId`), its exact
 * registered `redirectUri` and the app's PKCE challenge, and lives about a
 * minute.
 */
export const deviceJoinCodeRequestSchema = deviceProofSchema.extend({
  clientId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(256)),
  redirectUri: z.string().check(urlCheck()).check(utf16MaxLength(2048)),
  codeChallenge: pkceS256ChallengeSchema,
  codeChallengeMethod: z.literal('S256'),
});

export const deviceJoinCodeResponseSchema = z.object({
  code: z.string().check(utf16MinLength(1)),
  /** Seconds until the code expires. */
  expiresIn: z.number().check(integerCheck()).positive(),
});

/**
 * `POST /session/device/join` — called by the app's own origin with the code the
 * bridge window posted to it and the PKCE verifier only the app holds. Returns a
 * NEW holder credential for the browser's device; the app then mints through the
 * ordinary `POST /session/device/token`.
 */
export const deviceJoinRequestSchema = z.object({
  code: z.string().check(utf16MinLength(1)).check(utf16MaxLength(256)),
  codeVerifier: z
    .string()
    .check(utf16MinLength(43))
    .check(utf16MaxLength(128))
    .regex(/^[A-Za-z0-9._~-]+$/),
  clientId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(256)),
  redirectUri: z.string().check(urlCheck()).check(utf16MaxLength(2048)),
});

export const deviceJoinResponseSchema = deviceRegisterResponseSchema;

export type DeviceProof = z.infer<typeof deviceProofSchema>;
export type DeviceRegisterResponse = z.infer<typeof deviceRegisterResponseSchema>;
export type DeviceJoinCodeRequest = z.infer<typeof deviceJoinCodeRequestSchema>;
export type DeviceJoinCodeResponse = z.infer<typeof deviceJoinCodeResponseSchema>;
export type DeviceJoinRequest = z.infer<typeof deviceJoinRequestSchema>;
export type DeviceJoinResponse = z.infer<typeof deviceJoinResponseSchema>;
