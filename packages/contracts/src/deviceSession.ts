import { z } from 'zod';

export const sessionAccountSchema = z.object({
  accountId: z.string(),
  sessionId: z.string(),
  authuser: z.number().int().nonnegative(),
  operatedByUserId: z.string().optional(),
});

export const deviceSessionStateSchema = z.object({
  deviceId: z.string(),
  accounts: z.array(sessionAccountSchema),
  activeAccountId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
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
 * possession of the secret IS the proof of device ownership. The server matches
 * `sha256(deviceSecret)` against the device's stored `secretHash` (constant-time)
 * and mints a short access token for the device's active account.
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
  deviceId: z.string().min(1),
  deviceSecret: z.string().min(1),
  accountId: z.string().min(1).optional(),
});

/**
 * Wire shape of a successful `POST /session/device/token`: the freshly-minted
 * short access token for the active account, its expiry, the device secret the
 * client must persist (`nextDeviceSecret` — on mint this echoes the presented
 * secret unchanged so concurrent refreshes from multiple origins do not race),
 * and the projected device-session state. Sign-in rotates the secret via
 * `issueDeviceSecret`; mint does not.
 */
export const deviceTokenMintResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.string(),
  nextDeviceSecret: z.string(),
  state: deviceSessionStateSchema,
});

export type DeviceTokenMintRequest = z.infer<typeof deviceTokenMintRequestSchema>;
export type DeviceTokenMintResponse = z.infer<typeof deviceTokenMintResponseSchema>;

/* -------------------------------------------------------------------------- */
/*  Instant cross-app session sync (token-free socket signal)                 */
/* -------------------------------------------------------------------------- */

/**
 * Name of the token-free Socket.IO event emitted to room `user:<userId>` on
 * every DeviceSession mutation that changes what is signed in for that user.
 *
 * This is a pure SIGNAL — it carries NO access token, NO deviceSecret and NO
 * account bodies. A client that receives it re-fetches its authenticated
 * session/account state (`GET /session/device/state`, `GET /accounts`). Unlike
 * `session_state` (scoped to `device:<deviceId>`, i.e. a single origin), this
 * reaches ALL of a user's connected sockets across their devices/origins so
 * every Oxy app reflects an add / switch / signout instantly.
 */
export const SESSION_ACCOUNTS_CHANGED_EVENT = 'session_accounts_changed';

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
  revision: z.number().int().nonnegative(),
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
 * Deliberately a SEPARATE credential from the rotating `deviceSecret`: that one
 * rotates on every mint, so background code presenting it would become a second
 * writer of a value the JS runtime depends on, and background code killed
 * mid-rotation would silently sign the user out on the next cold start. Against
 * this credential background code is the sole writer, and it can never rotate
 * anything JS reads.
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
  deviceId: z.string().min(1),
  secret: z.string().min(1),
  accountId: z.string().min(1),
  expiresAt: z.string(),
});

/**
 * Request body for `POST /session/device/background-token` — presented by
 * native background code with NO bearer and NO cookies: possession of the
 * background `secret` IS the proof, as it is for the device-secret mint.
 *
 * Unlike that mint this one NEVER rotates the presented secret (hence no
 * `next…` field to persist in the response), so background code interrupted
 * anywhere between request and response leaves the credential intact and
 * usable on its next run.
 */
export const deviceBackgroundTokenRequestSchema = z.object({
  deviceId: z.string().min(1),
  secret: z.string().min(1),
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
  accountId: z.string().min(1),
});

export type DeviceBackgroundCredentialResponse = z.infer<
  typeof deviceBackgroundCredentialResponseSchema
>;
export type DeviceBackgroundTokenRequest = z.infer<typeof deviceBackgroundTokenRequestSchema>;
export type DeviceBackgroundTokenResponse = z.infer<typeof deviceBackgroundTokenResponseSchema>;
