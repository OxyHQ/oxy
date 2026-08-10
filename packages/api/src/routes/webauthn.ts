/**
 * WebAuthn / passkey ceremony routes (Fase B/b1).
 *
 * Four endpoints implement the two WebAuthn ceremonies:
 *   POST /webauthn/register/options   — begin registration (link OR signup)
 *   POST /webauthn/register/verify    — finish registration
 *   POST /webauthn/login/options      — begin authentication
 *   POST /webauthn/login/verify       — finish authentication
 *
 * All four read an OPTIONAL bearer (like `sessionDevice.ts`'s
 * `resolveCallerDeviceId`) rather than mounting `authMiddleware`: a bearer means
 * "link a passkey to THIS signed-in account", its absence means "prospective
 * signup / usernameless login".
 *
 * CORE PRINCIPLE — reuse the session mint. The verify handlers do ONLY: verify
 * the assertion via `@simplewebauthn/server` → resolve the userId → run the exact
 * same finalisation the password/2FA paths run (`sessionService.createSession` →
 * `buildSessionAuthResponse` → `finalizeDeviceLogin`) → return the same
 * `AuthSuccess` shape as `POST /auth/verify`. No session/device-secret minting is
 * reinvented here.
 *
 * ## Storage (Postgres)
 *
 * `webauthn_credentials`, `webauthn_challenges`, `user_auth_methods` and `users`
 * are Drizzle tables. Two things the Mongo version could not do, and now does:
 *
 * - **Signup is ONE transaction** (account + credential + auth method). The
 *   compensating `User.findByIdAndDelete` that used to unwind a half-created
 *   account existed only because Mongo gave this path no transaction; it is
 *   deleted rather than translated.
 * - **A duplicate is identified by the CONSTRAINT that rejected it**
 *   (`uniqueViolationConstraint`) rather than by which statement threw, so one
 *   `catch` around the transaction still tells "username taken" apart from
 *   "passkey already registered" and returns the same two 409s as before.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { decodeClientDataJSON, isoUint8Array } from '@simplewebauthn/server/helpers';
import {
  webauthnRegisterOptionsRequestSchema,
  webauthnLoginOptionsRequestSchema,
  webauthnRegisterVerifyRequestSchema,
  webauthnLoginVerifyRequestSchema,
} from '@oxyhq/contracts';
import { getDb } from '../config/postgres';
import { notifications } from '../db/schema/notifications';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { users } from '../db/schema/users';
import { webauthnChallenges } from '../db/schema/webauthnChallenges';
import { webauthnCredentials } from '../db/schema/webauthnCredentials';
import { extractTokenFromRequest, decodeToken } from '../middleware/authUtils';
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError, InternalServerError } from '../utils/error';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';
import { isOxyApexOrigin } from '../utils/origin';
import { getWebauthnRpId } from '../config/env';
import { normalizeUsername, USERNAME_PATTERN, INVALID_USERNAME_MESSAGE } from '../utils/username';
import { buildSessionAuthResponse, sessionCreateOptionsFromBody } from '../controllers/session.controller';
import sessionService from '../services/session.service';
import { finalizeDeviceLogin } from '../services/deviceLogin.service';
import securityActivityService from '../services/securityActivityService';
import type { SessionAuthResponse } from '../types/session';

const router = Router();

const RP_NAME = 'Oxy';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CREDENTIAL_NAME = 'Passkey';

/** SQLSTATE for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';
/** The unique index that rejects a second account claiming one username. */
const USERNAME_UNIQUE_CONSTRAINT = 'users_lower_username_key';
/** The two unique indexes a second registration of one passkey can collide with. */
const CREDENTIAL_UNIQUE_CONSTRAINTS = new Set([
  'webauthn_credentials_credential_id_key',
  'user_auth_methods_method_credential_id_key',
]);

const registerOptionsLimiter = rateLimit({ prefix: 'rl:webauthn:register-options:', windowMs: 60_000, max: 20 });
const registerVerifyLimiter = rateLimit({ prefix: 'rl:webauthn:register-verify:', windowMs: 60_000, max: 10 });
const loginOptionsLimiter = rateLimit({ prefix: 'rl:webauthn:login-options:', windowMs: 60_000, max: 30 });
const loginVerifyLimiter = rateLimit({ prefix: 'rl:webauthn:login-verify:', windowMs: 60_000, max: 10 });

/** The device-session options every first-party sign-in body carries. */
interface DeviceEnvelope {
  deviceName?: string;
  deviceFingerprint?: string;
}

/**
 * The `users` columns this route needs to mint a session: exactly the three
 * `buildSessionAuthResponse` projects onto the wire (`id`, `username`,
 * `avatar`). Selecting them by name rather than reading the whole row also
 * keeps the protected columns (`phone`, the contact hashes, `refresh_token`)
 * out of the query entirely.
 */
interface WebauthnAccount {
  id: string;
  username: string | null;
  avatar: string | null;
}

/** Managed accounts are operated only through the audited account-switch flow. */
function isPersonalAccount(kind: string): boolean {
  return kind === 'personal';
}

/**
 * The `sessions` fields the mint tail reads, declared structurally.
 *
 * `session.service` returns a FLAT `sessions` row — `deviceName` / `deviceType`
 * / `platform` are columns, not a nested `deviceInfo` subdocument. Naming the
 * shape here rather than importing the service's row type states exactly what
 * this route depends on, and is what makes the flat read explicit at the
 * boundary instead of implied by a property access.
 */
interface MintedSession {
  sessionId: string;
  deviceId: string;
  expiresAt: Date;
  accessToken?: string;
  deviceName?: string | null;
  deviceType?: string | null;
  platform?: string | null;
}

/**
 * Resolve the authenticated userId from an OPTIONAL bearer, mirroring
 * `sessionDevice.ts`'s `resolveCallerDeviceId`: decode the access JWT and read
 * its `userId` claim. Returns null when there is no valid `access` bearer — the
 * caller then treats the request as unauthenticated (signup / usernameless).
 */
function resolveOptionalBearerUserId(req: Request): string | null {
  const token = extractTokenFromRequest(req);
  const decoded = token ? decodeToken(token) : null;
  if (!decoded || decoded.type !== 'access') {
    return null;
  }
  return typeof decoded.userId === 'string' && decoded.userId.length > 0 ? decoded.userId : null;
}

/**
 * Read a field off a driver error. Drizzle wraps a postgres.js failure in its
 * own error, so `code` and `constraint_name` live on the `cause` — walking the
 * chain is what keeps the check "THIS constraint fired" rather than "something
 * threw"; the wrapper's own message carries only the SQL.
 *
 * `cause` is read through `Reflect.get` rather than `error.cause`: this package
 * compiles against the `es6` lib, where `Error.cause` is not declared.
 */
function pgField(error: unknown, field: string): string | undefined {
  for (let current: unknown = error; current instanceof Error; current = Reflect.get(current, 'cause')) {
    const value: unknown = Reflect.get(current, field);
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * The name of the unique index that rejected a statement, or null when the
 * failure was not a unique violation at all (in which case it is rethrown).
 */
function uniqueViolationConstraint(error: unknown): string | null {
  if (pgField(error, 'code') !== UNIQUE_VIOLATION) return null;
  return pgField(error, 'constraint_name') ?? '';
}

/**
 * `where lower(btrim(username)) = lower(btrim($1))` — the ONLY spelling that
 * both matches case-insensitively and uses `users_lower_username_key`. A plain
 * `username = $1` is correct-looking, case-sensitive, and would not use the
 * index.
 */
function usernameMatches(candidate: string) {
  return sql`lower(btrim(${users.username})) = lower(btrim(${candidate}))`;
}

/**
 * The transports a stored credential advertises, in the shape
 * `@simplewebauthn/server` takes. NULL means "the authenticator gave no hint".
 *
 * The assertion is deliberate and unchanged from the Mongo version: the column
 * is a plain `text[]` and `AuthenticatorTransportFuture` grows with the spec, so
 * FILTERING to the values we know today would silently drop a transport a newer
 * authenticator reported and make its credential harder to invoke.
 */
function toTransports(value: string[] | null): AuthenticatorTransportFuture[] | undefined {
  return value === null ? undefined : (value as AuthenticatorTransportFuture[]);
}

/**
 * Pull the browser ceremony response out of the raw request body. The outer Oxy
 * envelope is validated by Zod separately; the `response` object is validated by
 * `@simplewebauthn/server`, so here we only assert it is present and object-shaped.
 */
function readCeremonyResponse<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('WebAuthn ceremony response is required');
  }
  const response = (body as Record<string, unknown>).response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new BadRequestError('WebAuthn ceremony response is required');
  }
  return response as T;
}

/**
 * Guard that a value pulled from the (Zod-unvalidated) browser ceremony response
 * really is a string. These values are attacker-controlled and each is compared
 * against a `text` column AND handed to the WebAuthn verifier as the expected
 * challenge / credential id, so a non-string is a malformed ceremony and must be
 * a 400 rather than something the driver silently stringifies into a query that
 * matches nothing.
 */
function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new BadRequestError(`WebAuthn ${label} must be a string`);
  }
  return value;
}

/**
 * Decode the ceremony's `clientDataJSON` and return the origin (validated to be
 * an Oxy apex origin) plus the challenge the authenticator signed. The origin
 * gate is the WebAuthn `expectedOrigin` allow-set: `@simplewebauthn/server`'s
 * `expectedOrigin` only accepts a concrete string/array, not a predicate, so we
 * validate the reported origin against `isOxyApexOrigin` here and then pass that
 * exact origin back in — the security boundary is this gate.
 */
function decodeAndGuardClientData(clientDataJSON: unknown): { origin: string; challenge: string } {
  const raw = requireString(clientDataJSON, 'clientDataJSON');
  let clientData: { origin: string; challenge: string };
  try {
    clientData = decodeClientDataJSON(raw);
  } catch {
    throw new BadRequestError('Malformed WebAuthn clientDataJSON');
  }
  // `clientData` is attacker-controlled JSON; both fields flow into a query
  // (the origin gate below and the challenge burn), so pin them to strings first.
  const origin = requireString(clientData.origin, 'ceremony origin');
  const challenge = requireString(clientData.challenge, 'ceremony challenge');
  if (!isOxyApexOrigin(origin)) {
    throw new BadRequestError('WebAuthn ceremony origin is not allowed');
  }
  return { origin, challenge };
}

/**
 * Atomically burn the ceremony's stored challenge. A single conditional `update`
 * flips `used` only if the row is still unused and unexpired — a burned/expired/
 * unknown challenge updates nothing, so the ceremony is rejected (no replay).
 * `owner` additionally binds the challenge to its intended flow: a string binds
 * it to that account (a linking challenge, or a username-first login challenge),
 * `null` binds it to a flow with no account (signup, or a discoverable login).
 *
 * The expiry predicate is NOT delegated to the `db/expiry.ts` sweep: the sweep
 * lags an interval, and a challenge that outlives its deadline is a live
 * credential for that whole window.
 */
async function burnChallenge(
  challenge: string,
  type: 'registration' | 'authentication',
  owner: string | null,
): Promise<boolean> {
  const burned = await getDb()
    .update(webauthnChallenges)
    .set({ used: true })
    .where(
      and(
        eq(webauthnChallenges.challenge, challenge),
        eq(webauthnChallenges.type, type),
        eq(webauthnChallenges.used, false),
        gt(webauthnChallenges.expiresAt, new Date()),
        owner === null
          ? isNull(webauthnChallenges.userId)
          : eq(webauthnChallenges.userId, owner),
      ),
    )
    .returning({ id: webauthnChallenges.id });
  return burned.length > 0;
}

/**
 * Realistic transport spreads a decoy credential can advertise. A real
 * credential's `transports` vary widely by authenticator (platform passkey →
 * `['internal']`, hybrid/QR → `['internal','hybrid']`, security key →
 * `['usb','nfc']`), so a deterministic pick from this pool sits inside the natural
 * distribution and is not, by itself, an existence signal.
 */
const DECOY_TRANSPORT_POOL: AuthenticatorTransportFuture[][] = [
  ['internal'],
  ['internal', 'hybrid'],
  ['usb', 'nfc'],
  ['usb'],
];

/**
 * Deterministic keystream over the server salt: HMAC(salt, `${message}|blk${n}`)
 * concatenated across as many 32-byte SHA-256 blocks as `byteLength` needs. A single
 * HMAC digest is only 32 bytes, but a realistic roaming-key credential id can reach
 * ~64 bytes, so a decoy id that long must span more than one block. Every byte stays
 * keyed on the server secret, so no decoy field is attacker-computable.
 */
function decoyKeystream(salt: string, message: string, byteLength: number): Buffer {
  const blocks: Buffer[] = [];
  for (let block = 0, produced = 0; produced < byteLength; block += 1) {
    const digest = crypto.createHmac('sha256', salt).update(`${message}|blk${block}`).digest();
    blocks.push(digest);
    produced += digest.length;
  }
  return Buffer.concat(blocks).subarray(0, byteLength);
}

/**
 * DETERMINISTIC decoy allow-credentials for a username-first `login/options`
 * request that does NOT resolve to an account with a passkey — i.e. the username
 * is unknown OR belongs to a real account that has no WebAuthn credential. Its
 * only job is anti-enumeration: the "no real credential" response must be
 * INDISTINGUISHABLE from the "here are your credential ids" response so an
 * unauthenticated caller cannot probe which usernames exist / have a passkey.
 *
 * - **Stable per username.** Each id derives from `HMAC(DEVICE_ID_SALT, …)` — the
 *   SAME username always yields the SAME decoy across requests, exactly as a real
 *   user's credential ids are stable. A per-request-random decoy (count, id, length,
 *   or transports) would itself be the tell (a real allow-list does not change
 *   between two polls of the same username).
 * - **Unforgeable / fail-closed.** Keying on the server-side salt (never a raw hash
 *   of the username) stops an attacker precomputing "the decoy for X" and matching
 *   it against a response to classify fake vs real. If the salt is empty (misconfig)
 *   the decoy would become attacker-computable, so this throws (500) rather than
 *   silently emitting a computable decoy.
 * - **Masked COUNT (1 or 2).** A fixed count-of-1 decoy made `count === 2` a clean
 *   "this public username has ≥2 passkeys" posture oracle (a real account with two
 *   passkeys returns two entries). The count is now a deterministic 1 or 2, so the
 *   common 1–2-passkey case is indistinguishable between a decoy and a real
 *   allow-list. RESIDUAL: a real account with ≥3 passkeys still exceeds the decoy
 *   max of 2 — accepted, since that posture is rarer and account EXISTENCE is
 *   already public (`GET /auth/lookup`); this closes the clean 1-vs-2 oracle, not
 *   every conceivable posture signal.
 * - **Natural shape.** Id length (16–64 bytes → 22–86 base64url chars, covering both
 *   short platform passkeys and long roaming/hardware-key ids) and transports
 *   (sometimes omitted, like real credentials that advertise none) are derived from
 *   the same keystream so they land within the spread of real authenticator
 *   credential ids/transports rather than at a fixed tell-tale size/shape.
 *
 * The paired challenge is stored PRE-BURNED by the caller, so no assertion by any
 * authenticator can ever satisfy it: `login/verify` then fails with the same
 * generic error a wrong/unknown passkey produces.
 */
function decoyAllowCredentials(
  normalizedUsername: string,
): { id: string; transports?: AuthenticatorTransportFuture[] }[] {
  const salt = process.env.DEVICE_ID_SALT;
  // FAIL CLOSED. An empty salt makes every decoy attacker-computable, defeating the
  // whole anti-enumeration point. Prod already fail-fasts on the salt at boot
  // (`config/env.ts`); this is defense-in-depth so a misconfigured/empty salt can
  // NEVER silently downgrade the decoy to a computable value — it 500s instead.
  if (!salt) {
    throw new InternalServerError('WebAuthn anti-enumeration is not configured');
  }

  // Deterministic COUNT of 1 or 2 (never always 1) — see the "Masked COUNT" note above.
  const count = 1 + (decoyKeystream(salt, `webauthn-decoy|${normalizedUsername}`, 2)[1] % 2);

  const credentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];
  for (let index = 0; index < count; index += 1) {
    // Key each decoy on its index so the ids differ (like a real account's do) while
    // staying stable per (username, index) across polls. 66 bytes = 1 length byte +
    // up to 64 id bytes + 1 transports-selector byte.
    const material = decoyKeystream(salt, `webauthn-decoy|${normalizedUsername}|${index}`, 66);
    const idByteLength = 16 + (material[0] % 49); // 16–64 bytes → 22–86 base64url chars
    const id = material.subarray(1, 1 + idByteLength).toString('base64url');
    const transportSelector = material[65];
    // Omit transports ~1-in-4 deterministically so `[{ id }]` vs `[{ id, transports }]`
    // is not a fake-vs-real tell (some real credentials advertise no transports).
    if (transportSelector % 4 === 0) {
      credentials.push({ id });
    } else {
      credentials.push({ id, transports: DECOY_TRANSPORT_POOL[transportSelector % DECOY_TRANSPORT_POOL.length] });
    }
  }
  return credentials;
}

/**
 * The shared session-mint finalisation. Identical to the `/auth/signup` /
 * `/auth/verify` tail: create the session, format the standard auth response,
 * register the session into its device set + mint the rotating `deviceSecret`,
 * and best-effort log the sign-in. Produces the SAME `AuthSuccess` shape as
 * `POST /auth/verify`.
 */
async function mintWebauthnSession(
  req: Request,
  res: Response,
  account: WebauthnAccount,
  envelope: DeviceEnvelope,
): Promise<void> {
  const session: MintedSession = await sessionService.createSession(
    account.id,
    req,
    sessionCreateOptionsFromBody(envelope),
  );

  // `buildSessionAuthResponse` projects exactly `id`, `username` and `avatar`
  // onto the wire, which is why those are the three columns selected above.
  const baseResponse = buildSessionAuthResponse(session, {
    _id: account.id,
    username: account.username ?? undefined,
    avatar: account.avatar ?? undefined,
  });
  if (!baseResponse) {
    throw new InternalServerError('Failed to format user data');
  }
  const response: SessionAuthResponse & { deviceSecret?: string } = baseResponse;

  const deviceExtras = await finalizeDeviceLogin({ session, userId: account.id });
  if (deviceExtras.deviceSecret) {
    response.deviceSecret = deviceExtras.deviceSecret;
  }

  try {
    await securityActivityService.logSignIn(account.id, req, session.deviceId, {
      deviceName: envelope.deviceName || session.deviceName || undefined,
      deviceType: session.deviceType ?? undefined,
      platform: session.platform ?? undefined,
    });
  } catch (error) {
    logger.error(
      'Failed to log security event for webauthn sign-in',
      error instanceof Error ? error : new Error(String(error)),
      { component: 'webauthn', method: 'mintWebauthnSession', userId: account.id },
    );
  }

  res.json(response);
}

/**
 * POST /webauthn/register/options
 *
 * Bearer → link a passkey to the signed-in account (excludes existing passkeys).
 * No bearer → prospective signup: validate the requested username is available
 * WITHOUT creating the user yet (a throwaway userID handle is used for the
 * ceremony). Either way the returned `challenge` is persisted as a
 * `registration` challenge and burned exactly once at verify time.
 */
router.post(
  '/register/options',
  registerOptionsLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = webauthnRegisterOptionsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid request body');
    }

    const db = getDb();
    const rpID = getWebauthnRpId();
    const bearerUserId = resolveOptionalBearerUserId(req);

    let userName: string;
    let userHandle: string;
    let challengeUserId: string | null = null;
    let excludeCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];

    if (bearerUserId) {
      // Linking branch: the signed-in account adds another passkey.
      const [account] = await db
        .select({ id: users.id, username: users.username, kind: users.kind })
        .from(users)
        .where(eq(users.id, bearerUserId))
        .limit(1);
      if (!account) {
        throw new UnauthorizedError('User not found');
      }
      if (!isPersonalAccount(account.kind)) {
        throw new ForbiddenError('Passkeys can only be linked to personal accounts');
      }
      userName = account.username || bearerUserId;
      userHandle = bearerUserId;
      challengeUserId = bearerUserId;

      const existing = await db
        .select({ credentialID: webauthnCredentials.credentialID, transports: webauthnCredentials.transports })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, bearerUserId));
      excludeCredentials = existing.map((cred) => ({
        id: cred.credentialID,
        transports: toTransports(cred.transports),
      }));
    } else {
      // Signup branch: validate username availability but DON'T create the user.
      const requestedUsername = parsed.data.username;
      if (!requestedUsername) {
        throw new BadRequestError('username is required to register a new account');
      }
      const normalizedUsername = normalizeUsername(requestedUsername);
      if (!USERNAME_PATTERN.test(normalizedUsername)) {
        throw new BadRequestError(INVALID_USERNAME_MESSAGE);
      }
      const [taken] = await db
        .select({ id: users.id })
        .from(users)
        .where(usernameMatches(normalizedUsername))
        .limit(1);
      if (taken) {
        throw new ConflictError('Username already taken');
      }
      userName = normalizedUsername;
      // Throwaway per-ceremony handle: the real account id does not exist yet and
      // the credential is resolved by its own id at login, so this is opaque.
      userHandle = crypto.randomUUID();
      challengeUserId = null;
    }

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName,
      userID: isoUint8Array.fromUTF8String(userHandle),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: {
        // `preferred`, not `required`: a discoverable (resident) credential is still
        // asked for so usernameless login keeps working on platform authenticators
        // and modern security keys, but a roaming/hardware key with no resident-key
        // support (or full resident slots) can STILL register — it just enrolls a
        // non-discoverable credential, which the username-first login/options path
        // serves via an explicit allow-list. `required` here is exactly what made a
        // Google Titan fail Chrome's "device can't be used with this site" gate.
        residentKey: 'preferred',
        // `preferred`, not `required` (owner possession-credential policy): a
        // UV-capable authenticator (platform Face ID / Windows Hello, FIDO2-with-PIN)
        // STILL performs user verification unchanged; only a UV-incapable key (a
        // U2F/CTAP1 Titan with no PIN) falls back to presence-only. The assurance
        // level of each ceremony is captured on the credential's `userVerified` flag
        // (see register/verify) so a future step-up can gate on UV-backed credentials.
        userVerification: 'preferred',
        // `authenticatorAttachment` is deliberately UNPINNED so both platform (Face ID /
        // Touch ID / Windows Hello) and cross-platform/roaming (USB-C / NFC security key)
        // authenticators are offered.
      },
    });

    await db.insert(webauthnChallenges).values({
      challenge: options.challenge,
      type: 'registration',
      userId: challengeUserId,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      used: false,
    });

    res.json(options);
  }),
);

/**
 * POST /webauthn/register/verify
 *
 * Verifies the attestation, atomically burns the matching `registration`
 * challenge, then either LINKS the passkey to the bearer's account (returns
 * `{ success: true }`) or, for a signup, CREATES the account + credential and
 * runs the shared session mint (returns the `/auth/verify` `AuthSuccess` shape).
 */
router.post(
  '/register/verify',
  registerVerifyLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsedEnvelope = webauthnRegisterVerifyRequestSchema.safeParse(req.body);
    if (!parsedEnvelope.success) {
      throw new BadRequestError('Invalid request body');
    }
    const envelope = parsedEnvelope.data;
    const response = readCeremonyResponse<RegistrationResponseJSON>(req.body);

    const db = getDb();
    const rpID = getWebauthnRpId();
    const bearerUserId = resolveOptionalBearerUserId(req);

    const { origin, challenge } = decodeAndGuardClientData(response.response.clientDataJSON);

    // Bind the challenge to its flow: a linking challenge to its user, a signup
    // challenge to no user.
    const burned = await burnChallenge(challenge, 'registration', bearerUserId);
    if (!burned) {
      throw new UnauthorizedError('Invalid or expired registration challenge');
    }

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        // Possession-only credentials are accepted (owner policy): a presence-only
        // U2F/CTAP1 key would fail here if UV were required. The actual assurance
        // level is recorded per-credential via `registrationInfo.userVerified`.
        requireUserVerification: false,
      });
    } catch (error) {
      logger.warn('webauthn register verification threw', {
        component: 'webauthn',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new BadRequestError('Passkey registration could not be verified');
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestError('Passkey registration could not be verified');
    }

    // CAVEAT — `userVerified` is authenticator-SELF-ASSERTED, not attestation-proven.
    // We register with `attestationType: 'none'` and verify with
    // `requireUserVerification: false`, so this flag is only the UV bit the
    // authenticator reported for THIS ceremony; nothing cryptographically attests the
    // authenticator's UV capability or that UV actually happened. Treat it as an
    // assurance/telemetry marker ONLY — it must NOT be used as a hard security
    // boundary for step-up (e.g. "require a UV-backed credential for sensitive
    // actions"). A real step-up gate needs attestation.
    const { credential, credentialDeviceType, credentialBackedUp, userVerified } = verification.registrationInfo;
    const credentialName = envelope.deviceName?.trim() || DEFAULT_CREDENTIAL_NAME;

    if (bearerUserId) {
      // ---- Linking branch --------------------------------------------------
      const [account] = await db
        .select({ id: users.id, kind: users.kind })
        .from(users)
        .where(eq(users.id, bearerUserId))
        .limit(1);
      if (!account) {
        throw new UnauthorizedError('User not found');
      }
      if (!isPersonalAccount(account.kind)) {
        throw new ForbiddenError('Passkeys can only be linked to personal accounts');
      }

      // The credential row and its `user_auth_methods` row describe ONE fact, so
      // they are written together: a committed credential with no auth method
      // would be invisible to `GET /auth/methods` and to the unlink guard.
      try {
        await db.transaction(async (tx) => {
          await tx.insert(webauthnCredentials).values({
            userId: account.id,
            credentialID: credential.id,
            credentialPublicKey: Buffer.from(credential.publicKey),
            counter: credential.counter,
            transports: credential.transports,
            deviceType: credentialDeviceType,
            backedUp: credentialBackedUp,
            userVerified,
            name: credentialName,
          });
          await tx.insert(userAuthMethods).values({
            userId: account.id,
            type: 'webauthn',
            methodCredentialId: credential.id,
            methodName: credentialName,
          });
        });
      } catch (error) {
        const constraint = uniqueViolationConstraint(error);
        if (constraint !== null && CREDENTIAL_UNIQUE_CONSTRAINTS.has(constraint)) {
          throw new ConflictError('This passkey is already registered');
        }
        throw error;
      }

      userCache.invalidate(account.id);

      res.json({ success: true, message: 'Passkey registered successfully' });
      return;
    }

    // ---- Signup branch -----------------------------------------------------
    const requestedUsername = envelope.username;
    if (!requestedUsername) {
      throw new BadRequestError('username is required to register a new account');
    }
    const normalizedUsername = normalizeUsername(requestedUsername);
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      throw new BadRequestError(INVALID_USERNAME_MESSAGE);
    }
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(usernameMatches(normalizedUsername))
      .limit(1);
    if (taken) {
      throw new ConflictError('Username already taken');
    }

    // The account, its credential and its auth method are created in ONE
    // transaction, so a failed credential insert can no longer orphan a username
    // with no usable auth method. Mongo needed a compensating delete here purely
    // because it had no transaction on this path; that delete is gone.
    let account: WebauthnAccount;
    try {
      account = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({ username: normalizedUsername })
          .returning({ id: users.id, username: users.username, avatar: users.avatar });
        await tx.insert(webauthnCredentials).values({
          userId: created.id,
          credentialID: credential.id,
          credentialPublicKey: Buffer.from(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports,
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          userVerified,
          name: credentialName,
        });
        await tx.insert(userAuthMethods).values({
          userId: created.id,
          type: 'webauthn',
          methodCredentialId: credential.id,
          methodName: credentialName,
        });
        return created;
      });
    } catch (error) {
      // Which unique index rejected the write is what distinguishes the two
      // 409s — the statement that threw no longer can, now that all three
      // inserts share one transaction.
      const constraint = uniqueViolationConstraint(error);
      if (constraint === USERNAME_UNIQUE_CONSTRAINT) {
        throw new ConflictError('Username already taken');
      }
      if (constraint !== null && CREDENTIAL_UNIQUE_CONSTRAINTS.has(constraint)) {
        throw new ConflictError('This passkey is already registered');
      }
      throw error;
    }

    // Welcome notification — best-effort, mirrors SessionController.signUp. It is
    // deliberately OUTSIDE the transaction above: a notification failure must not
    // undo a completed signup.
    try {
      await db.insert(notifications).values({
        recipientId: account.id,
        actorId: account.id,
        type: 'welcome',
        entityId: account.id,
        entityType: 'profile',
        read: false,
      });
    } catch (notificationError) {
      logger.error(
        'Failed to create welcome notification during webauthn signup',
        notificationError instanceof Error ? notificationError : new Error(String(notificationError)),
        { component: 'webauthn', method: 'register/verify', userId: account.id },
      );
    }

    await mintWebauthnSession(req, res, account, envelope);
  }),
);

/**
 * POST /webauthn/login/options
 *
 * Two flows, selected by whether the body carries a `username`:
 *
 *  - **No username → usernameless/discoverable.** Empty allow-list, unbound
 *    challenge, no user lookup. The authenticator surfaces its resident credential
 *    and the user is resolved by credentialID at verify time. (Unchanged.)
 *
 *  - **Username present → username-first.** Returns THAT user's credentialIDs in
 *    `allowCredentials`, so a roaming/hardware key that did NOT store a resident
 *    (discoverable) credential can still be used — the browser needs the explicit
 *    id to invoke it. The challenge is bound to the resolved account so
 *    `login/verify` can reject a credential owned by a different user.
 *
 * ANTI-ENUMERATION (this is why the M1 empty-allow-list existed — do NOT regress
 * it): a username that does NOT resolve to an account-with-a-passkey (unknown, or a
 * real account with no credential) returns a DETERMINISTIC decoy allow-credential
 * of the same shape (see `decoyAllowCredentials`), paired with a challenge that
 * nothing can spend. Every branch does the SAME work — resolve the user, compute
 * the decoy, run one credential query, insert one challenge row — and returns the
 * SAME response shape, so an unknown username is indistinguishable from a known one
 * by RESPONSE CONTENT and by TIMING. There are no account-existence-dependent early
 * returns.
 */
router.post(
  '/login/options',
  loginOptionsLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = webauthnLoginOptionsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError('Invalid request body');
    }

    const db = getDb();
    const rpID = getWebauthnRpId();
    const requestedUsername = parsed.data.username;

    let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];
    let challengeUserId: string | null = null;
    // A decoy's challenge is stored ALREADY BURNED — see the branch below.
    let challengeSpent = false;

    if (requestedUsername) {
      const normalizedUsername = normalizeUsername(requestedUsername);
      // Always resolve the user (an unparseable/nonexistent username simply finds
      // nothing — never a distinct rejection that would leak "no such account").
      const [account] = await db
        .select({ id: users.id, kind: users.kind })
        .from(users)
        .where(usernameMatches(normalizedUsername))
        .limit(1);
      // Always compute the decoy, whether or not it is ultimately used, so the
      // found and not-found paths do the same work.
      const decoy = decoyAllowCredentials(normalizedUsername);
      // Always issue exactly one credential query. For a missing user a throwaway
      // id keeps the query shape/cost identical while returning no rows.
      const personalAccount = account && isPersonalAccount(account.kind) ? account : undefined;
      const probeUserId = personalAccount?.id ?? crypto.randomUUID();
      const credentials = await db
        .select({ credentialID: webauthnCredentials.credentialID, transports: webauthnCredentials.transports })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, probeUserId));

      if (personalAccount && credentials.length > 0) {
        allowCredentials = credentials.map((cred) => ({
          id: cred.credentialID,
          transports: toTransports(cred.transports),
        }));
        // Bind the challenge to the resolved account — verify asserts the presented
        // credential's owner equals this id (user A's challenge ≠ user B's key).
        challengeUserId = personalAccount.id;
      } else {
        // Unknown username OR an account with no passkey → decoy. Its challenge is
        // stored PRE-BURNED (`used: true`) instead of bound to a throwaway account
        // id as it was under Mongo: `webauthn_challenges.user_id` now carries a real
        // foreign key, so an id that maps to no user is no longer storable. Pre-burned
        // is the same guarantee by a different mechanism — the burn in `login/verify`
        // requires `used = false`, so no assertion by ANY owner can satisfy it, and the
        // rejection is the same generic 401 a wrong passkey produces. Storing it
        // unbound (`user_id = null`) instead would be a live enumeration oracle: the
        // discoverable-fallback burn accepts a null-bound challenge from any owner, so
        // an attacker holding their own passkey would get 200 for a decoy and 401 for a
        // real account with passkeys.
        allowCredentials = decoy;
        challengeUserId = null;
        challengeSpent = true;
      }
    }

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      // `preferred` (owner possession-credential policy): UV-capable authenticators
      // still verify; a UV-incapable U2F key authenticates presence-only. The
      // ceremony's real assurance level is refreshed onto the credential's
      // `userVerified` flag at verify time.
      userVerification: 'preferred',
    });

    await db.insert(webauthnChallenges).values({
      challenge: options.challenge,
      type: 'authentication',
      userId: challengeUserId,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      used: challengeSpent,
    });

    res.json(options);
  }),
);

/**
 * POST /webauthn/login/verify
 *
 * Resolves the credential by its public id, atomically burns the matching
 * `authentication` challenge, verifies the assertion, enforces the signature
 * counter (rejecting a genuine regression), persists the new counter, and runs
 * the shared session mint — returning the SAME `AuthSuccess` shape as
 * `POST /auth/verify`.
 */
router.post(
  '/login/verify',
  loginVerifyLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const parsedEnvelope = webauthnLoginVerifyRequestSchema.safeParse(req.body);
    if (!parsedEnvelope.success) {
      throw new BadRequestError('Invalid request body');
    }
    const envelope = parsedEnvelope.data;
    const response = readCeremonyResponse<AuthenticationResponseJSON>(req.body);

    const db = getDb();
    const rpID = getWebauthnRpId();

    // Resolve the credential by its PUBLIC base64url id (plain equality).
    // `response.id` is attacker-controlled and Zod-unvalidated; pin it to a
    // string before it is compared against a `text` column.
    const credentialId = requireString(response.id, 'credential id');
    const [credential] = await db
      .select({
        id: webauthnCredentials.id,
        userId: webauthnCredentials.userId,
        credentialID: webauthnCredentials.credentialID,
        credentialPublicKey: webauthnCredentials.credentialPublicKey,
        counter: webauthnCredentials.counter,
        transports: webauthnCredentials.transports,
      })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialID, credentialId))
      .limit(1);
    if (!credential) {
      throw new UnauthorizedError('Unknown passkey');
    }

    const { origin, challenge } = decodeAndGuardClientData(response.response.clientDataJSON);

    // Burn the challenge, and in doing so ENFORCE the challenge↔owner binding
    // atomically. Two mutually-exclusive shapes are accepted:
    //   1. Username-first: the challenge was stored bound to an account id, so it is
    //      only burned when that id EQUALS this credential's owner. A challenge
    //      issued for user A is therefore unusable by user B's credential (the match
    //      fails), and a decoy challenge (stored already burned) is unusable by
    //      anyone — both fall through to the same generic error.
    //   2. Discoverable: the challenge carries no account id; any owner may satisfy
    //      it. (Unchanged.)
    // Because the owner constraint lives INSIDE the conditional `update`, the
    // cross-user rejection cannot race the burn.
    const owner = credential.userId;
    const usernameFirstBurned = await burnChallenge(challenge, 'authentication', owner);
    const discoverableBurned = usernameFirstBurned
      ? false
      : await burnChallenge(challenge, 'authentication', null);
    if (!usernameFirstBurned && !discoverableBurned) {
      throw new UnauthorizedError('Invalid or expired authentication challenge');
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        // Possession-only assertions are accepted (owner policy); the actual
        // assurance level is refreshed onto `credential.userVerified` below.
        requireUserVerification: false,
        credential: {
          id: credential.credentialID,
          publicKey: new Uint8Array(credential.credentialPublicKey),
          counter: credential.counter,
          transports: toTransports(credential.transports),
        },
      });
    } catch (error) {
      logger.warn('webauthn authentication verification threw', {
        component: 'webauthn',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new UnauthorizedError('Passkey authentication could not be verified');
    }

    if (!verification.verified) {
      throw new UnauthorizedError('Passkey authentication could not be verified');
    }

    const { newCounter, userVerified } = verification.authenticationInfo;
    // Counter regression = replay/cloned authenticator. `newCounter === 0` is NOT
    // a regression: platform authenticators keep the counter at 0 and never
    // increment, so a stored 0 and a fresh 0 are legitimate.
    if (newCounter !== 0 && newCounter <= credential.counter) {
      try {
        await securityActivityService.logSuspiciousActivity(
          owner,
          'WebAuthn signature counter regression detected — possible cloned authenticator',
          { credentialId: credential.credentialID, storedCounter: credential.counter, presentedCounter: newCounter },
          req,
        );
      } catch (error) {
        logger.error(
          'Failed to log webauthn counter-regression security event',
          error instanceof Error ? error : new Error(String(error)),
          { component: 'webauthn', method: 'login/verify', userId: owner },
        );
      }
      throw new UnauthorizedError('Passkey authentication rejected');
    }

    await db
      .update(webauthnCredentials)
      .set({
        counter: newCounter,
        lastUsedAt: new Date(),
        // Refresh the assurance level: a credential that enrolled UV-capable but
        // authenticated presence-only (or vice versa) reflects its most recent ceremony.
        // CAVEAT (same as register/verify): `userVerified` is authenticator-SELF-ASSERTED
        // — verify runs with `requireUserVerification: false` and no attestation, so this
        // is only the UV bit the authenticator reported for this assertion. It is an
        // assurance/telemetry marker, NOT an attestation-proven fact, and must NOT gate a
        // hard step-up boundary without attestation.
        userVerified,
      })
      .where(eq(webauthnCredentials.id, credential.id));

    const [account] = await db
      .select({ id: users.id, username: users.username, avatar: users.avatar, kind: users.kind })
      .from(users)
      .where(eq(users.id, owner))
      .limit(1);
    if (!account) {
      throw new UnauthorizedError('User not found');
    }
    if (!isPersonalAccount(account.kind)) {
      // Managed accounts must remain bound to an operator session whose
      // `account:act_as` permission is revalidated; a passkey cannot encode that
      // delegation, so direct authentication is deliberately unavailable.
      throw new UnauthorizedError('Invalid passkey');
    }

    await mintWebauthnSession(req, res, account, envelope);
  }),
);

export default router;
