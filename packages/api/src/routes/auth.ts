/**
 * Authentication Routes
 *
 * Sign-in is passkey (WebAuthn) or public-key challenge-response for local
 * identity wallets, plus the OAuth authorize/consent/token surface. Password
 * and social OAuth sign-in were removed ecosystem-wide.
 */

import type { CommonsDenyReason } from '@oxyhq/contracts';
import express from 'express';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { SessionController } from '../controllers/session.controller';
import { getDb } from '../config/postgres';
import { appGrants } from '../db/schema/appGrants';
import { applicationCredentials } from '../db/schema/applicationCredentials';
import { applications } from '../db/schema/applications';
import { authSessions } from '../db/schema/authSessions';
import { publicColumns } from '../db/schema/protectedColumns';
import { sessions as sessionsTable } from '../db/schema/sessions';
import { users } from '../db/schema/users';
import { intersectScopes, isPaymentsScope } from '../utils/applicationScopes';
import { isCredentialUsable } from '../utils/credentialUsability';
import { isTrustedApplication } from '../utils/trustedApplication';
import { userConsentRequiredScopes } from '../utils/applicationScopes';
import { authMiddleware, rejectQueryToken, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { BadRequestError, NotFoundError, UnauthorizedError, ForbiddenError } from '../utils/error';
import { OAuthError, oauthHandler, sendOAuthSuccess } from '../utils/oauthResponse';
import { resolveClientAuthentication } from '../utils/oauthClientAuth';
import { ACCESS_TOKEN_TTL_SECONDS } from '../utils/sessionUtils';
import { logger } from '../utils/logger';
import SignatureService from '../services/signature.service';
import { emitAuthSessionUpdate, emitAuthSessionProgress } from '../utils/authSessionSocket';
import { broadcastSessionAccountsChanged } from '../utils/socket';
import webauthnRouter from './webauthn';
import { validate } from '../middleware/validate';
import sessionService from '../services/session.service';
import { finalizeDeviceLogin } from '../services/deviceLogin.service';
import { formatUserResponse } from '../utils/userTransform';
import { issueAuthCode, exchangeAuthCode, AUTH_CODE_TTL_MS } from '../services/oauthCode.service';
import {
  approvalMintsSession,
  claimAuthSession,
  authorizeSessionWithSignedChallenge,
  authorizeSessionWithBearer,
  finalizeOAuthAuthorization,
  resolveOAuthContext,
  verifyDelegatedSubject,
} from '../services/authSession.service';
import {
  deliverAuthRequestToIdentityApps,
  markAuthRequestOpened,
} from '../services/authSessionDelivery.service';
import { isAllowedRedirectUri } from '../utils/oauthRedirect';
import {
  extractTokenFromRequest,
  extractOAuthUserinfoToken,
  decodeToken,
  validateSessionToken,
} from '../middleware/authUtils';
import {
  registerPublicKeySchema,
  challengeSchema,
  verifyChallengeSchema,
  checkUsernameParams,
  checkEmailParams,
  checkPublicKeyParams,
  getUserByPublicKeyParams,
  authSessionCreateSchema,
  authSessionTokenParams,
  authorizeSessionBodySchema,
  authorizeCodeParams,
  authSessionAuthorizeSignedSchema,
  authSessionDenySchema,
  authSessionClaimSchema,
  serviceTokenSchema,
  oauthAuthorizeSchema,
  oauthTokenSchema,
  oauthClientParams,
  oauthConsentQuerySchema,
  grantApplicationIdParams,
} from '../schemas/auth.schemas';
import { normaliseOrigin, isLoopbackOrigin } from '../utils/origin';
import { deriveCoarseClientLabel } from '../utils/deviceUtils';
import { serializePublicApplication } from '../utils/serializeApplication';
import { composeDisplayName, formatUserNameResponse } from '../utils/displayName';
import { USERNAME_PATTERN, normalizeUsername } from '../utils/username';

const router = express.Router();

/**
 * Every `applications` column this module reads, named explicitly.
 *
 * Not `db.select().from(applications)`: that also pulls `webhook_secret` and
 * `webhook_url`, which no authentication path needs and no response here may
 * ever carry. `applications` is not in `protectedColumns.ts` — nothing would
 * FAIL if the whole row were selected — so naming the columns is the guard.
 */
const APPLICATION_COLUMNS = {
  id: applications.id,
  name: applications.name,
  description: applications.description,
  icon: applications.icon,
  websiteUrl: applications.websiteUrl,
  privacyPolicyUrl: applications.privacyPolicyUrl,
  termsUrl: applications.termsUrl,
  type: applications.type,
  status: applications.status,
  isOfficial: applications.isOfficial,
  isInternal: applications.isInternal,
  scopes: applications.scopes,
  redirectUris: applications.redirectUris,
  createdByUserId: applications.createdByUserId,
} as const;

/** An `applications` row as every read in this module projects it. */
type ApplicationRow = {
  [K in keyof typeof APPLICATION_COLUMNS]: (typeof applications.$inferSelect)[K];
};

/**
 * An `application_credentials` row as {@link resolveUsableCredential} projects
 * it. `secret_hash` is included because the two secret-verifying routes
 * (`POST /auth/oauth/token`, `POST /auth/service-token`) compare against it in
 * constant time; it never leaves the process.
 */
type ApplicationCredentialRow = Pick<
  typeof applicationCredentials.$inferSelect,
  'id' | 'applicationId' | 'publicKey' | 'secretHash' | 'type' | 'environment' | 'scopes' | 'status' | 'expiresAt'
>;

/** Read one application by id, projected to {@link APPLICATION_COLUMNS}. */
async function findApplicationById(applicationId: string): Promise<ApplicationRow | null> {
  const [app] = await getDb()
    .select(APPLICATION_COLUMNS)
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  return app ?? null;
}

/** Read one ACTIVE application by id, projected to {@link APPLICATION_COLUMNS}. */
async function findActiveApplicationById(applicationId: string): Promise<ApplicationRow | null> {
  const [app] = await getDb()
    .select(APPLICATION_COLUMNS)
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.status, 'active')))
    .limit(1);
  return app ?? null;
}

// ============================================
// WebAuthn / Passkey Routes
// ============================================

/**
 * POST /auth/webauthn/register/options  - begin passkey registration (link OR signup)
 * POST /auth/webauthn/register/verify   - finish passkey registration
 * POST /auth/webauthn/login/options     - begin passkey authentication
 * POST /auth/webauthn/login/verify      - finish passkey authentication
 *
 * Each reads an OPTIONAL bearer (link when signed in, signup/usernameless
 * otherwise). The verify handlers reuse the standard session mint and return the
 * same AuthSuccess shape as POST /auth/verify.
 */
router.use('/webauthn', webauthnRouter);

// ============================================
// Public Key Authentication Routes
// ============================================

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Register a new account with a public key
 *     description: >
 *       Create a passwordless account bound to a local secp256k1 identity.
 *       The client generates a key pair (see `KeyManager` in `@oxyhq/core`),
 *       signs `register:{publicKey}:{timestamp}`, and submits the
 *       signature. Username and email are optional but recommended for
 *       discoverability.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - publicKey
 *               - signature
 *               - timestamp
 *             properties:
 *               publicKey:
 *                 type: string
 *                 description: secp256k1 public key (hex).
 *               signature:
 *                 type: string
 *                 description: Hex signature over `register:{publicKey}:{timestamp}`.
 *               timestamp:
 *                 type: integer
 *                 description: Unix ms when the signature was produced (max 5 minutes old).
 *               email:
 *                 type: string
 *                 format: email
 *               username:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 30
 *                 pattern: '^[a-zA-Z0-9]{3,30}$'
 *     responses:
 *       200:
 *         description: Account created and the first session issued.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthSuccess'
 *       400:
 *         description: Invalid signature, malformed key, or duplicate username/email.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/register', validate({ body: registerPublicKeySchema }), SessionController.register);

/**
 * @openapi
 * /auth/challenge:
 *   post:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Request a sign-in challenge for a public key
 *     description: >
 *       Step 1 of the passwordless public-key login. Returns a short-lived
 *       random challenge that the client must sign with the matching private
 *       key, then submit to `POST /auth/verify`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - publicKey
 *             properties:
 *               publicKey:
 *                 type: string
 *                 description: secp256k1 public key (hex).
 *     responses:
 *       200:
 *         description: Challenge issued.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 challenge:
 *                   type: string
 *                   description: Opaque challenge string to sign.
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: No account registered for this public key.
 *       429:
 *         description: Rate limit exceeded (10 / minute / IP).
 */
const challengeLimiter = rateLimit({
  prefix: 'rl:auth:challenge:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 10 // 10 per minute (100 in dev)
});
router.post('/challenge', challengeLimiter, validate({ body: challengeSchema }), SessionController.requestChallenge);

/**
 * @openapi
 * /auth/verify:
 *   post:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Verify a signed challenge and create a session
 *     description: >
 *       Step 2 of the passwordless public-key login. Submit the challenge
 *       returned by `/auth/challenge` together with its signature; on success
 *       a new session is created and the standard `AuthSuccess` payload is
 *       returned.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - publicKey
 *               - challenge
 *               - signature
 *               - timestamp
 *             properties:
 *               publicKey:
 *                 type: string
 *               challenge:
 *                 type: string
 *               signature:
 *                 type: string
 *                 description: Hex signature of the challenge.
 *               timestamp:
 *                 type: integer
 *                 description: Unix ms.
 *               deviceName:
 *                 type: string
 *               deviceFingerprint:
 *                 type: string
 *     responses:
 *       200:
 *         description: Session created.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthSuccess'
 *       401:
 *         description: Signature invalid or challenge expired.
 *       429:
 *         description: Rate limit exceeded (5 / minute / IP).
 */
const verifyLimiter = rateLimit({
  prefix: 'rl:auth:verify:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 50 : 5 // 5 per minute (50 in dev)
});
router.post('/verify', verifyLimiter, validate({ body: verifyChallengeSchema }), SessionController.verifyChallenge);

// ============================================
// Validation Routes
// ============================================

/**
 * @openapi
 * /auth/validate:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Validate authentication status
 *     description: Check whether the current request carries valid authentication.
 *     responses:
 *       200:
 *         description: Authentication is valid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid:
 *                   type: boolean
 *                   example: true
 */
router.get('/validate', asyncHandler(async (req, res) => {
  sendSuccess(res, { valid: true });
}));

// Strict rate limit for enumeration-sensitive check endpoints (10/min per IP)
const checkLimiter = rateLimit({
  prefix: 'rl:auth:lookup:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 10,
  message: 'Too many lookup requests, please try again later.',
});

/**
 * @openapi
 * /auth/check-username/{username}:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Check username availability
 *     description: Check whether a username is available for registration.
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 3
 *           maxLength: 30
 *         example: johndoe
 *     responses:
 *       200:
 *         description: Availability check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid username format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Rate limit exceeded
 */
router.get('/check-username/:username', checkLimiter, validate({ params: checkUsernameParams }), asyncHandler(async (req, res) => {
  let { username } = req.params;
  
  if (!username) {
    throw new BadRequestError(
      'Username must be at least 3 characters long and contain only letters and numbers'
    );
  }

  username = normalizeUsername(username);

  if (!USERNAME_PATTERN.test(username)) {
    throw new BadRequestError('Username can only contain letters and numbers');
  }

  // `lower(btrim(...))` on BOTH sides — that is the expression
  // `users_lower_username_key` indexes, so a plain `username = $1` would be
  // both case-sensitive (wrong: `Nate` and `nate` are one account now) and a
  // sequential scan.
  const [existingUser] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);

  logger.debug('GET /auth/check-username', { username, available: !existingUser });

  sendSuccess(res, {
    available: !existingUser,
    message: existingUser ? 'Username is already taken' : 'Username is available'
  });
}));

/**
 * @openapi
 * /auth/lookup/{username}:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Lookup user by username
 *     description: Lightweight lookup that returns minimal public info for the login flow. Returns whether the user exists along with their color preset, avatar, and display name.
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 3
 *         example: nate
 *     responses:
 *       200:
 *         description: Lookup result
 *       429:
 *         description: Rate limit exceeded
 */
router.get('/lookup/:username', checkLimiter, validate({ params: checkUsernameParams }), asyncHandler(async (req, res) => {
  let { username } = req.params;

  if (!username) {
    throw new BadRequestError('Username is required');
  }

  username = username.trim().toLowerCase();

  // Matched through the `lower(btrim(username))` unique index — see
  // `check-username` above. The structured name is FLAT here (`name_first` /
  // `name_last`); `formatUserNameResponse` reassembles the wire object, so the
  // response contract (`name.displayName` present only for a real name) is
  // unchanged.
  const [user] = await getDb()
    .select({
      username: users.username,
      color: users.color,
      avatar: users.avatar,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
    })
    .from(users)
    .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
    .limit(1);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  sendSuccess(res, {
    exists: true,
    username: user.username,
    color: user.color || null,
    avatar: user.avatar || null,
    name: formatUserNameResponse({
      name: { first: user.nameFirst, last: user.nameLast },
      username: user.username,
    }),
  });
}));

/**
 * @openapi
 * /auth/check-email/{email}:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Check email availability
 *     description: Check whether an email address is available for registration.
 *     parameters:
 *       - in: path
 *         name: email
 *         required: true
 *         schema:
 *           type: string
 *           format: email
 *         example: user@example.com
 *     responses:
 *       200:
 *         description: Availability check result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid email format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Rate limit exceeded
 */
router.get('/check-email/:email', checkLimiter, validate({ params: checkEmailParams }), asyncHandler(async (req, res) => {
  const { email } = req.params;
  
  if (!email || !email.includes('@')) {
    throw new BadRequestError('Please provide a valid email address');
  }

  const normalizedEmail = email.trim().toLowerCase();
  // Matched through `users_lower_email_key`, the `lower(btrim(email))` unique
  // index — Mongoose's `lowercase: true` setter has no Postgres counterpart, so
  // the normalization is re-applied on BOTH sides at the call site.
  const [existingUser] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.email})) = lower(btrim(${normalizedEmail}))`)
    .limit(1);

  logger.debug('GET /auth/check-email', { email: normalizedEmail, available: !existingUser });

  sendSuccess(res, {
    available: !existingUser,
    message: existingUser ? 'Email is already registered' : 'Email is available'
  });
}));

/**
 * GET /auth/check-publickey/:publicKey
 * Check if a public key is already registered
 */
router.get('/check-publickey/:publicKey', checkLimiter, validate({ params: checkPublicKeyParams }), asyncHandler(async (req, res) => {
  const { publicKey } = req.params;
  
  if (!publicKey) {
    throw new BadRequestError('Public key is required');
  }

  if (!SignatureService.isValidPublicKey(publicKey)) {
    throw new BadRequestError('Invalid public key format');
  }

  // Matched through `users_lower_public_key_key`. Mongoose lower-cased the key
  // on write, so the stored values are already canonical; applying the same
  // expression on both sides is what lets the index serve the lookup.
  const [existingUser] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(btrim(${users.publicKey})) = lower(btrim(${publicKey}))`)
    .limit(1);

  logger.debug('GET /auth/check-publickey', {
    publicKey: SignatureService.shortenPublicKey(publicKey), 
    registered: !!existingUser 
  });
  
  sendSuccess(res, { 
    registered: !!existingUser, 
    message: existingUser ? 'This identity is already registered' : 'This identity is available' 
  });
}));

/**
 * GET /auth/user/:publicKey
 * Get user by public key (public profile info)
 */
router.get('/user/:publicKey', validate({ params: getUserByPublicKeyParams }), SessionController.getUserByPublicKey);

// ============================================
// Cross-App Authentication (OAuth-like flow)
// ============================================

/**
 * @openapi
 * /auth/session/create:
 *   post:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Open a cross-app auth session (OAuth-like flow)
 *     description: >
 *       Begin a cross-app sign-in handshake. A third-party / first-party
 *       client generates a one-time `sessionToken` and opens this endpoint;
 *       the user is then directed to Oxy Accounts where they authorise the
 *       session via `POST /auth/session/authorize/{sessionToken}`. The
 *       client polls `GET /auth/session/status/{sessionToken}` until the
 *       session is authorised, cancelled, or expires (default 5 minutes).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sessionToken
 *             properties:
 *               sessionToken:
 *                 type: string
 *                 description: Random opaque token the client generates and keeps secret.
 *                 example: at_random_4e9c2a1b8e9d3f4a1c2b3d4
 *               clientId:
 *                 type: string
 *                 description: >
 *                   OAuth client_id (ApplicationCredential public key) of the
 *                   requesting application. Provide this OR `applicationId`.
 *                 example: oxy_dk_1a2b3c4d
 *               applicationId:
 *                 type: string
 *                 description: >
 *                   Application _id of the requesting application. Provide this
 *                   OR `clientId`.
 *                 example: 64f7c2a1b8e9d3f4a1c2b3d4
 *               expiresAt:
 *                 oneOf:
 *                   - type: string
 *                     format: date-time
 *                   - type: integer
 *                     description: Unix ms.
 *                 description: Optional explicit expiry (capped at 5 minutes).
 *     responses:
 *       200:
 *         description: Auth session pending.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionToken:
 *                   type: string
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 status:
 *                   type: string
 *                   enum: [pending, authorized, cancelled, expired]
 *                   example: pending
 *       400:
 *         description: Missing/invalid application reference or token already in use.
 *       403:
 *         description: Application is not available (suspended/deleted/pending review).
 */
router.post('/session/create', validate({ body: authSessionCreateSchema }), asyncHandler(async (req, res) => {
  const { sessionToken, expiresAt, clientId, applicationId, deviceId, oauth } = req.body as {
    sessionToken: string;
    clientId?: string;
    applicationId?: string;
    expiresAt?: string | number;
    deviceId?: string;
    oauth?: {
      redirectUri: string;
      codeChallenge: string;
      codeChallengeMethod: string;
      scope?: string;
      subjectAccountId?: string;
    };
  };

  if (!sessionToken) {
    throw new BadRequestError('sessionToken is required');
  }
  if (!clientId && !applicationId) {
    throw new BadRequestError('Either clientId or applicationId is required');
  }
  // An OAuth-bound request is matched against the OAuth CLIENT's registered
  // redirect allowlist, so it must be identified by its client_id.
  if (oauth && !clientId) {
    throw new BadRequestError('clientId is required for an OAuth-bound session');
  }
  // Only S256 — `plain` is rejected outright, matching POST /auth/oauth/authorize.
  if (oauth && oauth.codeChallengeMethod !== 'S256') {
    throw new BadRequestError('Only S256 code_challenge_method is supported');
  }

  const now = Date.now();
  const SESSION_CREATE_TTL_MS = 5 * 60 * 1000;
  const defaultExpiresAt = new Date(now + SESSION_CREATE_TTL_MS);
  let expiresAtDate = expiresAt ? new Date(expiresAt) : defaultExpiresAt;

  if (Number.isNaN(expiresAtDate.getTime()) || expiresAtDate.getTime() < now + 30 * 1000) {
    expiresAtDate = defaultExpiresAt;
  } else if (expiresAtDate.getTime() > now + SESSION_CREATE_TTL_MS) {
    expiresAtDate = new Date(now + SESSION_CREATE_TTL_MS);
  }

  // Resolve the canonical Application. Every session is bound to a real,
  // active registered Application — there is no free-form app label.
  //
  // The `applicationId` branch no longer format-checks the id first: an id
  // Postgres cannot match simply selects no rows and falls into the same
  // `Invalid application` 400 the guard used to produce. Keeping the check
  // would additionally have rejected every uuid v7 id minted after the cutover.
  let resolvedApp: ApplicationRow | null = null;
  if (clientId) {
    const credential = await resolveUsableCredential(clientId);
    if (credential) {
      resolvedApp = await findApplicationById(credential.applicationId);
    }
  } else if (applicationId) {
    resolvedApp = await findApplicationById(applicationId);
  }

  if (!resolvedApp) {
    throw new BadRequestError('Invalid application');
  }

  if (resolvedApp.status !== 'active') {
    // Suspended / deleted / pending_review applications cannot start flows.
    throw new ForbiddenError('Application is not available');
  }

  // OAuth binding (optional). When present this request stops being a device
  // sign-in and becomes an OAuth authorization request that finalizes into a
  // single-use AuthCode. The redirect URI is validated against the SAME exact,
  // constant-time allowlist check `POST /auth/oauth/authorize` uses — and a
  // failure is surfaced as an error, NEVER a redirect (RFC 6749 §3.1.2.4).
  // Parsed before origin binding so the IdP shell (auth.oxy.so) can start an
  // OAuth-bound flow for official apps without its own Origin being registered.
  let oauthContext:
    | {
        redirectUri: string;
        codeChallenge: string;
        codeChallengeMethod: 'S256';
        scopes: string[];
        subjectAccountId?: string;
      }
    | undefined;
  if (oauth) {
    if (!isAllowedRedirectUri(resolvedApp, oauth.redirectUri)) {
      logger.warn('[OAuth] Rejected unregistered redirect_uri on session/create', {
        applicationId: resolvedApp.id,
      });
      throw new ForbiddenError('redirect_uri is not registered for this client');
    }
    // `auth_sessions.oauth_subject_account_id` carries a real foreign key to
    // `users` now, so an id that names no account is a constraint violation
    // (a 500) rather than a value that sits inert until approval. The old
    // FORMAT check is replaced by an EXISTENCE check, which keeps the
    // documented 400 and is strictly stronger — a well-formed id for a
    // nonexistent account used to be accepted here and refused much later.
    if (oauth.subjectAccountId && !(await userExists(oauth.subjectAccountId))) {
      throw new BadRequestError('Invalid subjectAccountId');
    }
    oauthContext = {
      redirectUri: oauth.redirectUri,
      codeChallenge: oauth.codeChallenge,
      codeChallengeMethod: 'S256',
      // Normalized exactly like POST /auth/oauth/authorize.
      scopes: oauth.scope ? oauth.scope.split(/\s+/).filter(Boolean) : [],
      ...(oauth.subjectAccountId ? { subjectAccountId: oauth.subjectAccountId } : {}),
    };
  }

  // The browser Origin the session was created from (null for native callers).
  // For OAuth-bound requests the relying-party redirect origin is what the
  // approver must see — the IdP shell's Origin (auth.oxy.so) is not the RP.
  const requestOriginHeader = requestOrigin(req);
  const boundOrigin = oauthContext
    ? originFromRedirectUri(oauthContext.redirectUri) ?? requestOriginHeader
    : requestOriginHeader;

  // Public OAuth client IDs are routing identifiers, not authenticators. For
  // trusted first-party/internal app identities, a browser caller must prove it
  // is running on one of the app's registered redirect origins before the
  // device-consent UI shows official branding. Native clients attach no Origin /
  // Referer header (no browser context) and cannot prove an origin, so they are
  // accepted as-is — the device-flow consent screen still authorises every
  // session interactively. OAuth-bound requests skip this gate: the redirect_uri
  // was already exact-matched above and the caller may legitimately be the IdP.
  if (
    !oauthContext &&
    isTrustedApplication(resolvedApp) &&
    hasBrowserContext(req)
  ) {
    // Loopback dev origins (http://localhost, 127.0.0.1, [::1] on any port) are
    // allowed to START the QR flow for a trusted app even though they are not
    // registered redirect origins — otherwise no local dev server could sign in.
    // This is only a gate to begin the flow; `originVerified` below stays false
    // for loopback (it keys off applicationAllowsOrigin ONLY), so the Commons
    // approval UI still shows its anti-phishing warning for an unverified origin.
    if (!boundOrigin || (!applicationAllowsOrigin(resolvedApp, boundOrigin) && !isLoopbackOrigin(boundOrigin))) {
      throw new ForbiddenError('Application origin is not allowed');
    }
  }

  // Authoritative anti-phishing signal for the Commons approval UI. True ONLY
  // when a platform-trusted Application proved it is running on one of its OWN
  // registered redirect origins. Native callers (no Origin) and untrusted /
  // third-party apps are `false` — Commons warns the approver in that case. The
  // guard above already rejected a trusted browser caller on a NON-registered
  // origin, so reaching here with a trusted app + allowed origin is the only way
  // this is true. This flag is never a gate by itself.
  const originVerified =
    isTrustedApplication(resolvedApp) &&
    !!boundOrigin &&
    applicationAllowsOrigin(resolvedApp, boundOrigin);

  // COARSE requester descriptor for the approval screen ("Chrome on Windows"),
  // so the approver can see WHERE the request came from. It is derived
  // SERVER-side from the request's own User-Agent: the QR / deep-link payload is
  // requester-controlled and must never be a display source. Native callers have
  // no browser context at all, so they persist `null` and the approval UI omits
  // the line instead of inventing one. The label is the entire descriptor — no
  // User-Agent string, no IP, no geolocation is captured here or anywhere on
  // this path (platform-wide no-IP-at-rest invariant).
  const requesterLabel = hasBrowserContext(req)
    ? deriveCoarseClientLabel(req.headers['user-agent'])
    : null;

  // The client-supplied `sessionToken` is the SECRET claim credential and is
  // kept as-is (never regenerated, never echoed to observers). The
  // `authorizeCode` is a SEPARATE public single-use handle that travels in the
  // QR / deep link so the Commons vault can approve without ever seeing the
  // secret sessionToken.
  const authorizeCode = crypto.randomBytes(16).toString('hex');
  const qrNonce = crypto.randomBytes(8).toString('hex');

  // Create the auth session. Every field is written from a SERVER-resolved value
  // or an explicitly whitelisted one — `req.body` is never spread in.
  //
  // The reuse check IS the insert now: `auth_sessions_session_token_key`
  // decides, so a token already in use returns no row and produces the same
  // generic `Unable to create session` (never enumerating whether it exists).
  // The read-then-write pair this replaces left a window in which two callers
  // could both pass the check, and the loser then hit a raw duplicate-key 500.
  //
  // The OAuth binding is written as FLAT columns alongside `purpose` in ONE
  // insert, because `auth_sessions_oauth_binding_check` and
  // `auth_sessions_oauth_purpose_check` require the whole group and the purpose
  // to agree. There is no half-bound row to write — the schema-level statement
  // of what the Mongoose sub-schema achieved by staying `undefined`.
  const [authSession] = await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      applicationId: resolvedApp.id,
      authorizeCode,
      boundOrigin: boundOrigin ?? null,
      originVerified,
      requesterLabel,
      challengeNonce: qrNonce,
      expiresAt: expiresAtDate,
      status: 'pending',
      purpose: oauthContext ? 'oauth_authorization' : 'device_sign_in',
      oauthRedirectUri: oauthContext ? oauthContext.redirectUri : null,
      oauthCodeChallenge: oauthContext ? oauthContext.codeChallenge : null,
      oauthCodeChallengeMethod: oauthContext ? oauthContext.codeChallengeMethod : null,
      oauthScopes: oauthContext ? oauthContext.scopes : null,
      oauthSubjectAccountId: oauthContext?.subjectAccountId ?? null,
      deviceId: typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : null,
    })
    .onConflictDoNothing({ target: authSessions.sessionToken })
    .returning({
      authorizeCode: authSessions.authorizeCode,
      expiresAt: authSessions.expiresAt,
      status: authSessions.status,
    });

  if (!authSession) {
    throw new BadRequestError('Unable to create session');
  }

  // Deep-link / universal-link payload for the QR. Commons parses ONLY `code`
  // from this; the `approve` path segment and `code` param name are part of its
  // deep-link router contract and MUST NOT change.
  const qrPayload = `oxycommons://approve?v=1&code=${authorizeCode}&app=${resolvedApp.id}` +
    `&origin=${encodeURIComponent(boundOrigin ?? '')}&nonce=${qrNonce}&exp=${expiresAtDate.getTime()}`;

  logger.debug('Auth session created', {
    sessionToken: sessionToken.substring(0, 8) + '...',
    authorizeCode: authorizeCode.substring(0, 8) + '...',
    applicationId: resolvedApp.id,
  });

  sendSuccess(res, {
    // Echoed from the REQUEST rather than re-read from the row: the insert
    // matched it byte for byte, so the two are the same value, and
    // `auth_sessions.session_token` stays out of every select in this module
    // (`protectedColumns.ts`).
    sessionToken,
    authorizeCode: authSession.authorizeCode,
    expiresAt: authSession.expiresAt.toISOString(),
    status: authSession.status,
    qrPayload,
  });
}));

/**
 * @openapi
 * /auth/session/status/{sessionToken}:
 *   get:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Poll the status of a cross-app auth session
 *     description: >
 *       Polled by the client that opened a session via
 *       `POST /auth/session/create`. Returns the session's current `status`
 *       and, once authorised, the `sessionId` / `userId` that the client
 *       should now treat as its own session.
 *     parameters:
 *       - name: sessionToken
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Current status of the auth session.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [pending, authorized, cancelled, expired]
 *                 authorized:
 *                   type: boolean
 *                 sessionToken:
 *                   type: string
 *                 application:
 *                   nullable: true
 *                   description: >
 *                     Sanitized public metadata of the registered Application
 *                     bound to this session, for the consent UI. Null only if
 *                     the app was hard-deleted after the session was created.
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     description:
 *                       type: string
 *                     icon:
 *                       type: string
 *                     websiteUrl:
 *                       type: string
 *                     type:
 *                       type: string
 *                       enum: [first_party, third_party, internal, system]
 *                     isOfficial:
 *                       type: boolean
 *                     isInternal:
 *                       type: boolean
 *                     scopes:
 *                       type: array
 *                       items:
 *                         type: string
 *                     developerName:
 *                       type: string
 *                       description: Best-effort owner display name (non-official apps only).
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 pushSentAt:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                   description: >
 *                     Delivery progress, not a status: when the pending request
 *                     was pushed to the approving identity's capable installs.
 *                     Null when no push was delivered.
 *                 openedAt:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                   description: >
 *                     Delivery progress, not a status: when the approval surface
 *                     first opened the request. Written at most once.
 *                 sessionId:
 *                   type: string
 *                   nullable: true
 *                 publicKey:
 *                   type: string
 *                   nullable: true
 *                 userId:
 *                   type: string
 *                   nullable: true
 *             examples:
 *               pending:
 *                 value:
 *                   status: pending
 *                   authorized: false
 *                   sessionToken: at_random_4e9c2a1b8e9d3f4a1c2b3d4
 *                   application:
 *                     id: 64f7c2a1b8e9d3f4a1c2b3d4
 *                     name: Oxy Accounts
 *                     type: first_party
 *                     isOfficial: true
 *                     isInternal: false
 *                     scopes: [user:read]
 *                   expiresAt: '2025-05-25T12:39:56.000Z'
 *                   sessionId: null
 *                   publicKey: null
 *                   userId: null
 *               authorized:
 *                 value:
 *                   status: authorized
 *                   authorized: true
 *                   sessionToken: at_random_4e9c2a1b8e9d3f4a1c2b3d4
 *                   application:
 *                     id: 64f7c2a1b8e9d3f4a1c2b3d4
 *                     name: Acme Widgets
 *                     type: third_party
 *                     isOfficial: false
 *                     isInternal: false
 *                     scopes: [files:read, user:read]
 *                     websiteUrl: https://acme.example
 *                     developerName: Ada Lovelace
 *                   expiresAt: '2025-05-25T12:39:56.000Z'
 *                   sessionId: sess_64f7c2a1b8e9d3f4a1c2b3d4
 *                   publicKey: '02a1b2c3d4e5f6...'
 *                   userId: 64f7c2a1b8e9d3f4a1c2b3d4
 *       404:
 *         description: Auth session not found.
 */
router.get('/session/status/:sessionToken', validate({ params: authSessionTokenParams }), asyncHandler(async (req, res) => {
  const { sessionToken } = req.params;

  // Explicit columns, never `select()`: `auth_sessions.session_token` is a
  // protected column (`protectedColumns.ts`) and this handler has no reason to
  // read it — the value it echoes is the one the caller presented.
  const [row] = await getDb()
    .select({
      id: authSessions.id,
      status: authSessions.status,
      applicationId: authSessions.applicationId,
      expiresAt: authSessions.expiresAt,
      pushSentAt: authSessions.pushSentAt,
      openedAt: authSessions.openedAt,
      authorizedSessionId: authSessions.authorizedSessionId,
      authorizedBy: authSessions.authorizedBy,
      authorizedUserId: authSessions.authorizedUserId,
      purpose: authSessions.purpose,
    })
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);

  if (!row) {
    throw new NotFoundError('Auth session not found');
  }

  // Check if expired. Unconditional, exactly as before: a row past its deadline
  // reports `expired` whatever it was, including an already-`consumed` one.
  let status = row.status;
  if (row.expiresAt < new Date()) {
    status = 'expired';
    await getDb()
      .update(authSessions)
      .set({ status: 'expired' })
      .where(eq(authSessions.id, row.id));
  }

  // Resolve sanitized public application metadata for the consent UI. Every
  // session is bound to a canonical `applicationId` at create-time, so this is
  // normally always present. If the app was later hard-deleted (or is no longer
  // active) we return null rather than throwing — defensive only.
  let application = null;
  const app = await findApplicationById(row.applicationId);
  if (app && app.status === 'active') {
    const developerName = await resolveDeveloperName(app);
    application = serializePublicApplication(app, developerName);
  }

  sendSuccess(res, {
    status,
    authorized: status === 'authorized',
    sessionToken,
    application,
    expiresAt: row.expiresAt.toISOString(),
    // Delivery progress as TIMESTAMPS — never statuses. This is the
    // authoritative read-back for the socket's payload-free wake signal: the
    // waiting client learns "pushed" / "opened in the vault" from here, so no
    // progress data has to travel as trusted data on the socket.
    pushSentAt: row.pushSentAt ? row.pushSentAt.toISOString() : null,
    openedAt: row.openedAt ? row.openedAt.toISOString() : null,
    sessionId: row.authorizedSessionId || null,
    publicKey: row.authorizedBy || null,
    userId: row.authorizedUserId ?? null,
    // Lets poll clients distinguish device sign-in (claim) from OAuth (finalize).
    purpose: row.purpose,
  });
}));

/**
 * @openapi
 * /auth/session/authorize/{sessionToken}:
 *   post:
 *     tags:
 *       - Authentication
 *     summary: Authorise a pending cross-app auth session
 *     description: >
 *       Called by the Oxy Accounts app (or any first-party UI) after the
 *       user accepts a cross-app sign-in prompt. Requires the authorising
 *       user's access token via the `Authorization: Bearer` header — the
 *       authenticated principal is the only valid source of "who is
 *       authorising". The previous `x-session-id`-based path has been
 *       removed (fixes C2).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - name: sessionToken
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               deviceName:
 *                 type: string
 *               deviceFingerprint:
 *                 type: string
 *     responses:
 *       200:
 *         description: Session authorised.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 sessionId:
 *                   type: string
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Session expired, or malformed body.
 *       401:
 *         description: Missing or invalid bearer token.
 *       404:
 *         description: Auth session not found or already processed.
 */
router.post('/session/authorize/:sessionToken', authMiddleware, validate({ params: authSessionTokenParams, body: authorizeSessionBodySchema }), asyncHandler(async (req: AuthRequest, res) => {
  const { sessionToken } = req.params;
  const { deviceName, deviceFingerprint } = req.body;

  const authenticatedUser = req.user;
  if (!authenticatedUser?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  // Find the auth session. Explicit columns — `session_token` is protected and
  // this handler already holds the value, having matched on it.
  const [authSession] = await getDb()
    .select({
      id: authSessions.id,
      applicationId: authSessions.applicationId,
      deviceId: authSessions.deviceId,
      expiresAt: authSessions.expiresAt,
      purpose: authSessions.purpose,
      oauthRedirectUri: authSessions.oauthRedirectUri,
      oauthCodeChallenge: authSessions.oauthCodeChallenge,
      oauthCodeChallengeMethod: authSessions.oauthCodeChallengeMethod,
      oauthScopes: authSessions.oauthScopes,
      oauthSubjectAccountId: authSessions.oauthSubjectAccountId,
    })
    .from(authSessions)
    .where(and(eq(authSessions.sessionToken, sessionToken), eq(authSessions.status, 'pending')))
    .limit(1);
  if (!authSession) {
    throw new NotFoundError('Auth session not found or already processed');
  }

  // Check if expired
  if (authSession.expiresAt < new Date()) {
    await getDb()
      .update(authSessions)
      .set({ status: 'expired' })
      .where(eq(authSessions.id, authSession.id));
    throw new BadRequestError('Auth session has expired');
  }

  const authenticatedUserId = authenticatedUser._id.toString();

  // Delegated subject gate: approving an app acting AS another account requires
  // the authenticated identity to hold `account:act_as` over it (the same
  // predicate `POST /accounts/:id/switch` uses). The identity never becomes the
  // account — it authorises the app to act as it.
  const oauthContext = resolveOAuthContext(authSession);
  const subjectAccountId = oauthContext?.subjectAccountId;
  if (subjectAccountId) {
    const delegation = await verifyDelegatedSubject(authenticatedUserId, subjectAccountId);
    if (!delegation.ok) {
      logger.warn('Delegated subject refused on session authorize', {
        sessionToken: sessionToken.substring(0, 8) + '...',
        userId: authenticatedUserId,
        reason: delegation.reason,
      });
      throw new ForbiddenError('Not authorized to act as the requested account');
    }
  }

  // An OAuth authorization request mints NO session on approval — its result is
  // the single-use authorization code produced by
  // `POST /auth/session/finalize/:sessionToken`. Key off `purpose`, not the
  // presence of an `oauth` binding: a corrupt/missing binding must not mint a
  // device session for an OAuth-purpose row.
  let newSessionId: string | undefined;
  if (approvalMintsSession(authSession)) {
    // Resolve the bound Application for the device-name label. The session can't
    // exist without a valid applicationId; fall back to a generic label only if
    // the app was hard-deleted between create and authorize.
    const app = await findApplicationById(authSession.applicationId);
    const appLabel = app ? app.name : 'App';

    // Create a new session for the third-party app, owned by the
    // authenticated user identified via the bearer token. When the flow was
    // started with a device binding (`deviceId` persisted at create time), pass it
    // as the explicit deviceId so the session lands on the originating device.
    const newSession = await sessionService.createSession(
      authenticatedUserId,
      req,
      {
        deviceName: deviceName || `${appLabel} App`,
        deviceFingerprint,
        ...(authSession.deviceId ? { deviceId: authSession.deviceId } : {}),
      }
    );
    newSessionId = newSession.sessionId;
  }

  // Update auth session — including WHICH identity approved. `authorizedBy` is
  // left untouched when the approver has no public key, matching the Mongoose
  // path that only assigned the field when one existed.
  await getDb()
    .update(authSessions)
    .set({
      status: 'authorized',
      authorizedUserId: authenticatedUserId,
      ...(authenticatedUser.publicKey ? { authorizedBy: authenticatedUser.publicKey } : {}),
      ...(newSessionId ? { authorizedSessionId: newSessionId } : {}),
    })
    .where(eq(authSessions.id, authSession.id));

  logger.info('Auth session authorized', {
    sessionToken: sessionToken.substring(0, 8) + '...',
    userId: authenticatedUserId,
    applicationId: authSession.applicationId,
  });

  // Emit socket event to notify the waiting client
  emitAuthSessionUpdate(sessionToken, {
    status: 'authorized',
    sessionId: newSessionId,
    publicKey: authenticatedUser.publicKey,
    userId: authenticatedUserId,
    username: authenticatedUser.username,
  });

  // A1: a brand-new session was minted for this user — signal all of their other
  // connected sockets (across devices/origins) to refetch. No device mutation
  // happens here, so the revision hint is 0. Nothing was minted for an OAuth
  // authorization request, so there is nothing to refetch.
  if (newSessionId) {
    broadcastSessionAccountsChanged(authenticatedUserId, 0, 'login');
  }

  sendSuccess(res, {
    success: true,
    sessionId: newSessionId,
    user: {
      id: authenticatedUserId,
      username: authenticatedUser.username,
      publicKey: authenticatedUser.publicKey,
    },
  });
}));

// Limiter for the device-flow claim. Tighter than the OAuth token
// endpoint because each `sessionToken` is single-use — legitimate
// clients hit this at most once per flow. The cap blunts brute-force
// attempts against the 128-bit sessionToken value even though
// guessing is computationally infeasible (10^7 RPS for 100 years to
// hit a 50 % collision).
const authSessionClaimLimiter = rateLimit({
  prefix: 'rl:auth:session-claim:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
});

/**
 * @openapi
 * /auth/session/claim:
 *   post:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Exchange a sessionToken for the first access token (device flow)
 *     description: >
 *       Final step of the QR-code / "Open Oxy Auth" device sign-in flow.
 *       After another authenticated device has approved this session via
 *       `POST /auth/session/authorize/{sessionToken}`, the originating
 *       client — which alone knows the secret `sessionToken` — calls
 *       this endpoint to atomically claim the resulting access token,
 *       refresh token, and session ID.
 *
 *       No `Authorization` header is required: the 128-bit `sessionToken`
 *       (held only by the originating client, never echoed back to
 *       observers) IS the credential, exactly as in RFC 8628 §3.4.
 *       The exchange is single-use: a successful claim transitions the
 *       AuthSession status from `authorized` -> `consumed`, so a replayed
 *       sessionToken is rejected. Time-bound by the AuthSession TTL
 *       (default 5 minutes). Status-bound: only `authorized` rows are
 *       claimable.
 *
 *       This endpoint is the only device-flow token handoff: the originating
 *       client starts with no bearer token, so it must claim exactly once with
 *       the secret sessionToken it created.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sessionToken
 *             properties:
 *               sessionToken:
 *                 type: string
 *                 description: The same 128-bit sessionToken issued by `POST /auth/session/create`.
 *               deviceFingerprint:
 *                 type: string
 *                 description: Optional fingerprint of the originating client device.
 *     responses:
 *       200:
 *         description: First access token issued.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken:
 *                   type: string
 *                 deviceSecret:
 *                   type: string
 *                 sessionId:
 *                   type: string
 *                 deviceId:
 *                   type: string
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Validation failed.
 *       401:
 *         description: SessionToken is unknown, expired, cancelled, not yet authorized, or already consumed.
 */
router.post(
  '/session/claim',
  authSessionClaimLimiter,
  validate({ body: authSessionClaimSchema }),
  asyncHandler(async (req, res) => {
    const { sessionToken } = req.body as { sessionToken: string };

    const outcome = await claimAuthSession({ sessionToken });

    if (!outcome.ok) {
      // Per RFC 6749 §5.2 we collapse all failure modes to a single
      // generic error to avoid leaking which step failed (does the
      // sessionToken exist? was it authorized?).
      logger.warn('[AuthSession] Claim rejected', {
        reason: outcome.reason,
        sessionToken: sessionToken.substring(0, 8) + '...',
      });
      throw new UnauthorizedError('invalid_grant');
    }

    const { authSession } = outcome;

    if (!authSession.authorizedSessionId || !authSession.authorizedUserId) {
      // Defensive: should never happen for an 'authorized' row but we
      // never want to return a successful response without these.
      logger.error('[AuthSession] Claimed authSession is missing bindings', new Error('missing bindings'), {
        sessionToken: sessionToken.substring(0, 8) + '...',
      });
      throw new UnauthorizedError('invalid_grant');
    }

    const tokenResult = await sessionService.getAccessToken(authSession.authorizedSessionId);
    if (!tokenResult) {
      logger.error('[AuthSession] Could not resolve access token for claimed session', new Error('no access token'), {
        sessionToken: sessionToken.substring(0, 8) + '...',
        sessionId: authSession.authorizedSessionId,
      });
      throw new UnauthorizedError('invalid_grant');
    }

    // `publicColumns` is the sanctioned whole-row read: it drops `phone`, the
    // contact-discovery hashes and `refresh_token` AT THE TYPE LEVEL, so the
    // serializer below cannot carry any of them into the response.
    const [user] = await getDb()
      .select(publicColumns(users))
      .from(users)
      .where(eq(users.id, authSession.authorizedUserId))
      .limit(1);
    if (!user) {
      logger.error('[AuthSession] User not found for claimed session', new Error('user not found'), {
        sessionToken: sessionToken.substring(0, 8) + '...',
        userId: authSession.authorizedUserId,
      });
      throw new UnauthorizedError('invalid_grant');
    }

    // Pull the deviceId from the underlying Session for the response.
    const [session] = await getDb()
      .select({ deviceId: sessionsTable.deviceId, expiresAt: sessionsTable.expiresAt })
      .from(sessionsTable)
      .where(eq(sessionsTable.sessionId, authSession.authorizedSessionId))
      .limit(1);

    if (!session) {
      logger.error('[AuthSession] Underlying session disappeared between authorize and claim', new Error('session missing'), {
        sessionToken: sessionToken.substring(0, 8) + '...',
      });
      throw new UnauthorizedError('invalid_grant');
    }

    const userData = formatUserResponse(user);

    // Mint the `deviceSecret` the client persists first-party (with the response's
    // `deviceId`) to restore the session via `POST /session/device/token`
    // (zero-cookie transport). Best-effort — a mint failure never fails the claim,
    // and a device with no doc simply omits the secret.
    let deviceSecret: string | undefined;
    try {
      if (typeof session.deviceId === 'string' && session.deviceId.length > 0) {
        const { deviceSessionService } = await import('../services/deviceSession.service.js');
        const minted = await deviceSessionService.issueDeviceSecret(session.deviceId);
        if (minted) deviceSecret = minted;
      }
    } catch (error) {
      logger.warn('[AuthSession] deviceSecret mint failed on claim', {
        sessionId: authSession.authorizedSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('[AuthSession] Claim succeeded', {
      sessionToken: sessionToken.substring(0, 8) + '...',
      sessionId: authSession.authorizedSessionId,
      userId: authSession.authorizedUserId,
      applicationId: authSession.applicationId,
    });

    sendSuccess(res, {
      accessToken: tokenResult.accessToken,
      sessionId: authSession.authorizedSessionId,
      deviceId: session.deviceId,
      expiresAt: tokenResult.expiresAt.toISOString(),
      user: userData,
      ...(deviceSecret ? { deviceSecret } : {}),
    });
  })
);

/**
 * POST /auth/session/cancel/:sessionToken
 * Cancel an auth session. The `sessionToken` is a 128-bit secret held only by
 * the originating client, so possessing it IS the ownership proof — no
 * additional identifier is required.
 */
router.post('/session/cancel/:sessionToken', validate({ params: authSessionTokenParams }), asyncHandler(async (req, res) => {
  const { sessionToken } = req.params;

  // Cancel in ONE statement: the 404 is "no row carried this secret", which the
  // update itself answers, so there is no read to go stale in between. As
  // before, cancelling is unconditional on the current status — possession of
  // the secret is the ownership proof.
  const cancelled = await getDb()
    .update(authSessions)
    .set({ status: 'cancelled' })
    .where(eq(authSessions.sessionToken, sessionToken))
    .returning({ id: authSessions.id });

  if (cancelled.length === 0) {
    throw new NotFoundError('Auth session not found');
  }

  // Emit socket event to notify the waiting client
  emitAuthSessionUpdate(sessionToken, {
    status: 'cancelled',
  });

  sendSuccess(res, { success: true });
}));

// ============================================
// "Sign in with Oxy" QR / app-to-app handoff (C2)
// ============================================
//
// The originating client (web RP / native app) creates a session and renders a
// QR whose `authorizeCode` is PUBLIC; the secret `sessionToken` never leaves the
// originator. The Commons vault scans it, fetches the server-resolved app
// identity (so a spoofed-name QR still shows the true app), biometric-gates, and
// approves by SIGNING a challenge with its local key — no bearer token. The
// originator then claims the result with its secret `sessionToken` as usual.

// Public — read-only resolution of the app identity behind an authorizeCode.
const authSessionApproveInfoLimiter = rateLimit({
  prefix: 'rl:auth:session-approve-info:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 60,
});

// Key-signed approval. Tight, like the claim limiter — a legitimate approval
// hits this once per flow; the cap blunts brute force against the authorizeCode.
const authSessionAuthorizeSignedLimiter = rateLimit({
  prefix: 'rl:auth:session-authorize-signed:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
});

/**
 * Sanitized identity of a DELEGATED subject account for the approval screen —
 * id + handle + display name and NOTHING else. Enough for Commons to render
 * "Mention will act as: The Oxy Collective"; never a channel for account
 * internals (kind, membership, owner, status) on a public endpoint.
 */
interface SanitizedSubjectAccount {
  id: string;
  username: string | null;
  displayName: string | null;
}

/**
 * GET /auth/session/approve-info/:authorizeCode
 *
 * PUBLIC. Returns the server-resolved, sanitized Application identity (never the
 * QR's self-asserted strings) plus the bound origin, purpose, delegated subject
 * and status, so the Commons approval screen renders the TRUE request. Never
 * leaks the secret `sessionToken`, tokens, or the PKCE binding.
 */
router.get(
  '/session/approve-info/:authorizeCode',
  authSessionApproveInfoLimiter,
  validate({ params: authorizeCodeParams }),
  asyncHandler(async (req, res) => {
    const { authorizeCode } = req.params;

    // Explicit columns: `session_token` is protected AND this endpoint is
    // PUBLIC, so it must never even load the secret it exists to keep hidden.
    const [authSession] = await getDb()
      .select({
        id: authSessions.id,
        status: authSessions.status,
        applicationId: authSessions.applicationId,
        boundOrigin: authSessions.boundOrigin,
        originVerified: authSessions.originVerified,
        requesterLabel: authSessions.requesterLabel,
        expiresAt: authSessions.expiresAt,
        purpose: authSessions.purpose,
        oauthRedirectUri: authSessions.oauthRedirectUri,
        oauthCodeChallenge: authSessions.oauthCodeChallenge,
        oauthCodeChallengeMethod: authSessions.oauthCodeChallengeMethod,
        oauthScopes: authSessions.oauthScopes,
        oauthSubjectAccountId: authSessions.oauthSubjectAccountId,
      })
      .from(authSessions)
      .where(eq(authSessions.authorizeCode, authorizeCode))
      .limit(1);
    if (!authSession) {
      throw new NotFoundError('Auth session not found');
    }

    let status = authSession.status;
    if (status === 'pending' && authSession.expiresAt < new Date()) {
      status = 'expired';
      await getDb()
        .update(authSessions)
        .set({ status: 'expired' })
        .where(eq(authSessions.id, authSession.id));
    }

    const oauthContext = resolveOAuthContext(authSession);

    let application = null;
    let scopes: string[] = [];
    const app = await findApplicationById(authSession.applicationId);
    if (app && app.status === 'active') {
      const developerName = await resolveDeveloperName(app);
      application = serializePublicApplication(app, developerName);
      const appScopes = Array.isArray(app.scopes) ? [...app.scopes] : [];
      // What the app will ACTUALLY receive if this is approved. For an OAuth
      // request that is the requested set narrowed to the app's registered
      // scopes (an app can never receive more than it is registered for); a
      // device sign-in has no per-request scope set, so it is the app's own.
      scopes =
        oauthContext && oauthContext.scopes.length > 0
          ? intersectScopes(oauthContext.scopes, appScopes)
          : appScopes;
    }

    // Delegated subject: "who will the app act as". Resolved SERVER-side from
    // the bound id — the QR/deep link never carries display data.
    let subjectAccount: SanitizedSubjectAccount | null = null;
    const subjectAccountId = oauthContext?.subjectAccountId;
    if (subjectAccountId) {
      const [subject] = await getDb()
        .select({
          id: users.id,
          username: users.username,
          nameFirst: users.nameFirst,
          nameLast: users.nameLast,
        })
        .from(users)
        .where(eq(users.id, subjectAccountId))
        .limit(1);
      if (subject) {
        const name = formatUserNameResponse({
          name: { first: subject.nameFirst, last: subject.nameLast },
          username: subject.username,
        });
        subjectAccount = {
          id: subject.id,
          username: subject.username ?? null,
          displayName: name.displayName ?? null,
        };
      }
    }

    sendSuccess(res, {
      application,
      scopes,
      boundOrigin: authSession.boundOrigin ?? null,
      // Authoritative anti-phishing signal. When false (native callers, or a
      // session NOT proven to originate from a trusted app's own registered
      // origin), Commons warns the approver that the source is unverifiable.
      originVerified: authSession.originVerified,
      // COARSE, display-only requester label ("Chrome on Windows"), captured
      // server-side at create time, or `null` (native callers, unidentifiable
      // User-Agents). This is the ONLY requester descriptor this endpoint
      // exposes: never the raw User-Agent, never an IP or location, never the
      // originating deviceId.
      requesterLabel: authSession.requesterLabel ?? null,
      // What approving this request does.
      purpose: authSession.purpose,
      subjectAccount,
      expiresAt: authSession.expiresAt.toISOString(),
      status,
    });
  }),
);

/**
 * POST /auth/session/authorize-signed/:authorizeCode
 *
 * NO bearer auth — this is the gap-filler. The Commons vault approves with its
 * local secp256k1 key: it proves key control with a single-use challenge
 * signature (`verifyChallengeResponse` + atomic burn), and the resolved signer
 * becomes the authorizing user. The session is bound by `authorizeCode`. The
 * waiting originator is notified over the socket on the row's `sessionToken`.
 */
router.post(
  '/session/authorize-signed/:authorizeCode',
  authSessionAuthorizeSignedLimiter,
  validate({ params: authorizeCodeParams, body: authSessionAuthorizeSignedSchema }),
  asyncHandler(async (req, res) => {
    const { authorizeCode } = req.params;
    const { publicKey, challenge, signature, timestamp, deviceName, deviceFingerprint } = req.body as {
      publicKey: string;
      challenge: string;
      signature: string;
      timestamp: number;
      deviceName?: string;
      deviceFingerprint?: string;
    };

    // The challenge verify + atomic burn + session binding live in the service
    // (mirrors claimAuthSession) so the AuthChallenge/model import chain stays
    // out of the route module's load path.
    const outcome = await authorizeSessionWithSignedChallenge({
      authorizeCode,
      publicKey,
      challenge,
      signature,
      timestamp,
      deviceName,
      deviceFingerprint,
      req,
    });

    if (!outcome.ok) {
      if (outcome.status === 401) throw new UnauthorizedError(outcome.message);
      if (outcome.status === 403) throw new ForbiddenError(outcome.message);
      if (outcome.status === 404) throw new NotFoundError(outcome.message);
      throw new BadRequestError(outcome.message);
    }

    logger.info('Auth session authorized (key-signed)', {
      authorizeCode: authorizeCode.substring(0, 8) + '...',
      userId: outcome.userId,
    });

    // Notify the waiting originator on its secret sessionToken channel.
    emitAuthSessionUpdate(outcome.sessionToken, {
      status: 'authorized',
      sessionId: outcome.sessionId,
      publicKey: outcome.publicKey,
      userId: outcome.userId,
      username: outcome.username,
    });

    // A1: a brand-new session was minted for the signer via the QR handoff —
    // signal all of their other connected sockets to refetch. No device mutation
    // happens here, so the revision hint is 0. An OAuth authorization request
    // mints no session, so there is nothing to refetch.
    if (outcome.sessionId) {
      broadcastSessionAccountsChanged(outcome.userId, 0, 'login');
    }

    sendSuccess(res, {
      success: true,
      sessionId: outcome.sessionId,
      user: {
        id: outcome.userId,
        username: outcome.username,
        publicKey: outcome.publicKey,
      },
    });
  }),
);

// Bearer approval keyed on the PUBLIC authorizeCode. Tight, like the
// sibling authorize-signed limiter — a legitimate approval hits this once
// per flow; the cap blunts brute force against the authorizeCode.
const authSessionAuthorizeCodeLimiter = rateLimit({
  prefix: 'rl:auth:session-authorize-code:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
});

/**
 * POST /auth/session/authorize-code/:authorizeCode
 *
 * Bearer-authed sibling of `POST /session/authorize/:sessionToken`, keyed on
 * the PUBLIC `authorizeCode` instead of the secret `sessionToken` — for an
 * approver that authenticates via bearer token (e.g. a passkey ceremony) but,
 * unlike the Oxy Accounts app, never holds the secret. This lets the caller
 * carry ONLY the public code (safe in a URL); the secret `sessionToken` never
 * has to leave the originating client. The authenticated principal (bearer)
 * is the sole source of "who is authorising" — mirrors `/session/authorize`.
 *
 * The claim + mint live in `authorizeSessionWithBearer` (atomic, see its
 * doc) so two concurrent authorizes of the same code can't both mint a
 * session — the route only resolves the bearer identity and maps the
 * outcome to a status code.
 */
router.post(
  '/session/authorize-code/:authorizeCode',
  authMiddleware,
  authSessionAuthorizeCodeLimiter,
  validate({ params: authorizeCodeParams, body: authorizeSessionBodySchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { authorizeCode } = req.params;
    const { deviceName, deviceFingerprint } = req.body;

    const authenticatedUser = req.user;
    if (!authenticatedUser?._id) {
      throw new UnauthorizedError('Authentication required');
    }
    const authenticatedUserId = authenticatedUser._id.toString();

    const outcome = await authorizeSessionWithBearer({
      authorizeCode,
      authenticatedUserId,
      authenticatedPublicKey: authenticatedUser.publicKey,
      deviceName,
      deviceFingerprint,
      req,
    });

    if (!outcome.ok) {
      if (outcome.status === 403) throw new ForbiddenError(outcome.message);
      if (outcome.status === 404) throw new NotFoundError(outcome.message);
      throw new BadRequestError(outcome.message);
    }

    logger.info('Auth session authorized (bearer, by code)', {
      authorizeCode: authorizeCode.substring(0, 8) + '...',
      userId: authenticatedUserId,
    });

    // Notify the waiting originator on its secret sessionToken channel — the
    // caller here only ever held the public authorizeCode.
    emitAuthSessionUpdate(outcome.sessionToken, {
      status: 'authorized',
      sessionId: outcome.sessionId,
      publicKey: authenticatedUser.publicKey,
      userId: authenticatedUserId,
      username: authenticatedUser.username,
    });

    // A1: a brand-new session was minted for this user — signal all of their
    // other connected sockets (across devices/origins) to refetch. No device
    // mutation happens here, so the revision hint is 0. An OAuth authorization
    // request mints no session, so there is nothing to refetch.
    if (outcome.sessionId) {
      broadcastSessionAccountsChanged(authenticatedUserId, 0, 'login');
    }

    sendSuccess(res, {
      success: true,
      sessionId: outcome.sessionId,
      user: {
        id: authenticatedUserId,
        username: authenticatedUser.username,
        publicKey: authenticatedUser.publicKey,
      },
    });
  }),
);

// Public denial keyed on the PUBLIC authorizeCode. Same tight budget as its
// approval siblings: a legitimate flow denies once, and the cap blunts brute
// force against the authorizeCode space through this endpoint — an unlimited
// denial route is an unauthenticated oracle AND a cancellation amplifier.
const authSessionDenyLimiter = rateLimit({
  prefix: 'rl:auth:session-deny:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
});

/**
 * POST /auth/session/deny/:authorizeCode
 *
 * The Commons vault denies a pending approval. It never holds the secret
 * `sessionToken`, so it cannot use `/session/cancel/:sessionToken`; it cancels
 * by the public `authorizeCode` instead. Only a PENDING session can be denied
 * (so a knower of the code cannot cancel an already-authorized session).
 *
 * The OPTIONAL `reason` comes from the closed `COMMONS_DENY_REASONS` set —
 * this endpoint is unauthenticated, so free-form text is rejected at the edge
 * rather than persisted. Recording it makes "This wasn't me" (`not_me`) a
 * distinguishable, honest record instead of an ordinary cancel.
 */
router.post(
  '/session/deny/:authorizeCode',
  authSessionDenyLimiter,
  validate({ params: authorizeCodeParams, body: authSessionDenySchema }),
  asyncHandler(async (req, res) => {
    const { authorizeCode } = req.params;
    // Whitelisted single field off the VALIDATED body — never a spread of
    // `req.body` onto the document.
    const { reason } = req.body as { reason?: CommonsDenyReason };

    // The denial IS the update, conditioned on `status = 'pending'` — so two
    // concurrent denials cannot both emit, and a request that was authorized
    // between read and write is no longer cancellable by a knower of the code.
    // `session_token` is a PROTECTED column and this is the one place in this
    // module that legitimately needs it: the waiting originator is notified on
    // its own secret channel, and the caller here only ever held the public
    // code. It is returned to the server, never to the client.
    const [denied] = await getDb()
      .update(authSessions)
      .set({ status: 'cancelled', ...(reason ? { deniedReason: reason } : {}) })
      .where(and(eq(authSessions.authorizeCode, authorizeCode), eq(authSessions.status, 'pending')))
      .returning({
        sessionToken: authSessions.sessionToken,
        applicationId: authSessions.applicationId,
      });

    if (!denied) {
      // Nothing was pending under this code. Distinguish "no such request" from
      // "already resolved": the former is a 404, the latter is the same
      // idempotent success the pre-port handler returned.
      const [existing] = await getDb()
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.authorizeCode, authorizeCode))
        .limit(1);
      if (!existing) {
        throw new NotFoundError('Auth session not found');
      }
      sendSuccess(res, { success: true });
      return;
    }

    if (reason === 'not_me') {
      // The "flag it as suspicious" half of the contract: someone was shown a
      // sign-in request they say they never started. Recorded as a coarse,
      // non-identifying fact — application + truncated approval handle, no
      // User-Agent, no IP, no location.
      logger.warn('Auth session denied as not-me', {
        authorizeCode: `${authorizeCode.substring(0, 8)}...`,
        applicationId: denied.applicationId,
      });
    }

    // The waiting originator learns only that it was cancelled. The reason is
    // the approver's report about the requester and is deliberately NOT
    // broadcast back to it — a hostile RP must not learn it was suspected.
    emitAuthSessionUpdate(denied.sessionToken, { status: 'cancelled' });

    sendSuccess(res, { success: true });
  }),
);

// ============================================
// Automatic delivery to the identity vault
// ============================================

// Push delivery of a pending request. A legitimate flow hits this once (with at
// most a retry or two if the user reloads the popup), so the cap is tight —
// push is an outbound side effect and must not be cheaply amplifiable.
const authSessionDeliverLimiter = rateLimit({
  prefix: 'rl:auth:session-deliver:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 15,
});

// Progress ping from the approval surface. Public (keyed on the approval
// handle), writes only a timestamp, so a slightly looser cap than the approval
// endpoints it accompanies.
const authSessionOpenedLimiter = rateLimit({
  prefix: 'rl:auth:session-opened:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
});

/**
 * POST /auth/session/deliver/:authorizeCode
 *
 * Bearer REQUIRED — and the bearer is the SECURITY CONTROL, not a convenience.
 * Delivery targets the AUTHENTICATED user's own approval-capable installs and
 * nothing else: the target identity is never resolved from the request body, the
 * QR payload, or the bound `AuthSession`. That makes it impossible to make Oxy
 * push a sign-in prompt at someone by typing their username or email into an
 * unauthenticated browser.
 *
 * Eligible installs are those registered by an `Application` carrying the
 * staff-controlled `identity:approval` capability — a registry decision, never a
 * hardcoded client id or bundle id.
 *
 * The payload is exactly `{ type, approvalUrl }`: a type discriminator plus the
 * PUBLIC approval handle. No application name, no origin, no scopes, no secrets
 * — the vault re-fetches all authoritative display data from
 * `GET /auth/session/approve-info/:authorizeCode`. The notification carries no
 * action buttons, so it can only be opened or dismissed; approval always happens
 * inside the vault, behind biometrics and a local-key signature.
 *
 * Responds with COUNTS only (`{ delivered, targets }`) — never device names,
 * platforms, or any other install detail. `targets: 0` is a normal outcome (no
 * vault install on any device) and the client falls back to the QR surface; a
 * push transport failure degrades to exactly the same shape and never fails the
 * auth flow.
 */
router.post(
  '/session/deliver/:authorizeCode',
  authMiddleware,
  authSessionDeliverLimiter,
  validate({ params: authorizeCodeParams }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { authorizeCode } = req.params;

    const authenticatedUser = req.user;
    if (!authenticatedUser?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const outcome = await deliverAuthRequestToIdentityApps({
      authorizeCode,
      identityUserId: authenticatedUser._id.toString(),
    });

    if (!outcome.ok) {
      if (outcome.status === 404) throw new NotFoundError(outcome.message);
      throw new BadRequestError(outcome.message);
    }

    if (outcome.delivered) {
      // Pure wake signal on the originator's secret channel — the authoritative
      // `pushSentAt` is read back from GET /auth/session/status.
      emitAuthSessionProgress(outcome.sessionToken);
    }

    sendSuccess(res, { delivered: outcome.delivered, targets: outcome.targets });
  }),
);

/**
 * POST /auth/session/opened/:authorizeCode
 *
 * NO bearer — like `approve-info`, the PUBLIC single-use approval handle IS the
 * credential. Records delivery progress only: `openedAt` is written at most once,
 * only while the request is still pending and unexpired, and NEVER touches
 * `status`. The authoritative state machine stays exactly
 * `pending -> authorized -> consumed` / `cancelled` / `expired`.
 */
router.post(
  '/session/opened/:authorizeCode',
  authSessionOpenedLimiter,
  validate({ params: authorizeCodeParams }),
  asyncHandler(async (req, res) => {
    const { authorizeCode } = req.params;

    const outcome = await markAuthRequestOpened(authorizeCode);

    if (!outcome.ok) {
      throw new NotFoundError(outcome.message);
    }

    if (outcome.recorded) {
      emitAuthSessionProgress(outcome.sessionToken);
    }

    sendSuccess(res, { success: true });
  }),
);

// Finalization of an OAuth-bound request. Tight, like the claim limiter — a
// legitimate flow hits this exactly once (the request is single-use), so the cap
// only blunts brute force against the 128-bit sessionToken.
const authSessionFinalizeLimiter = rateLimit({
  prefix: 'rl:auth:session-finalize:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
});

/**
 * @openapi
 * /auth/session/finalize/{sessionToken}:
 *   post:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Finalize an approved OAuth-bound auth session into an authorization code
 *     description: >
 *       Terminal step of an OAuth authorization request created with
 *       `POST /auth/session/create` + an `oauth` binding and approved through any
 *       delivery surface (popup, push, QR, verified app link). Mints the ONE
 *       single-use `AuthCode` the relying party redeems at
 *       `POST /auth/oauth/token` with its PKCE verifier.
 *
 *       No `Authorization` header: the 128-bit `sessionToken` — held only by the
 *       originating client, never echoed to observers — IS the credential,
 *       exactly as on `POST /auth/session/claim`. No access token is ever handed
 *       out here.
 *
 *       Atomic and single-use: the authorization code's identity is reserved by
 *       the same update that spends the request, so a request can never mint a
 *       second code, even under concurrent calls. Every failure mode collapses to
 *       one generic `invalid_grant` (RFC 6749 §5.2) — nothing enumerates which
 *       precondition failed.
 *     parameters:
 *       - name: sessionToken
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Authorization code issued.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code:
 *                   type: string
 *                 redirectUri:
 *                   type: string
 *                   format: uri
 *                 expiresIn:
 *                   type: integer
 *                   example: 60
 *       401:
 *         description: >
 *           Unknown, not an OAuth request, not approved, expired, already
 *           finalized, no longer permitted, or its application/redirect binding
 *           is no longer valid.
 */
router.post(
  '/session/finalize/:sessionToken',
  authSessionFinalizeLimiter,
  validate({ params: authSessionTokenParams }),
  asyncHandler(async (req, res) => {
    const { sessionToken } = req.params;

    const outcome = await finalizeOAuthAuthorization({ sessionToken });

    if (!outcome.ok) {
      // One generic error for every rejection — the precise reason stays in the
      // server log so a caller cannot probe the request's state.
      logger.warn('[AuthSession] Finalize rejected', {
        reason: outcome.reason,
        sessionToken: sessionToken.substring(0, 8) + '...',
      });
      throw new UnauthorizedError('invalid_grant');
    }

    sendSuccess(res, {
      code: outcome.code,
      redirectUri: outcome.redirectUri,
      expiresIn: outcome.expiresIn,
    });
  }),
);

// ============================================
// OAuth2 Authorization Code Flow (with PKCE)
// ============================================
//
// Tokenless browser authorization flow:
//
//   1. User signs into the auth UI.
//   2. UI calls POST /auth/oauth/authorize (Bearer auth) with `clientId`,
//      `redirectUri`, optional PKCE `codeChallenge` (S256) and `state`.
//   3. Server validates the `redirectUri` against the Application
//      `redirectUris` allowlist and mints a single-use authorization code.
//   4. UI redirects the browser to `redirectUri?code=<code>&state=<state>`.
//   5. The third-party app's backend (or a public client with the matching
//      PKCE `code_verifier`) POSTs `/auth/oauth/token` to exchange the code
//      for `{ access_token, deviceId, deviceSecret, session_id, user }`.
//
// Step 5 is the ONE endpoint in this file that speaks a standard rather than
// Oxy's conventions: it is RFC 6749 §4.1.3 verbatim — a form-urlencoded
// request with `grant_type=authorization_code`, a FLAT §5.1 response, and
// §5.2 `{ error, error_description }` failures. Steps 2–4 remain Oxy's own
// JSON API, because the browser leg is served by our own auth UI.
//
// Access tokens never appear in the URL bar.

/**
 * Resolve an OAuth `clientId` (= ApplicationCredential.publicKey) to its
 * usable credential. Accepts `active` OR `deprecated`-within-grace credentials;
 * rejects `revoked` and any whose rotation grace has elapsed. Returns null when
 * no usable credential exists. Mirrors the resolution in `/oauth/authorize`
 * and `/oauth/token`.
 */
async function resolveUsableCredential(clientId: string): Promise<ApplicationCredentialRow | null> {
  const [credential] = await getDb()
    .select({
      id: applicationCredentials.id,
      applicationId: applicationCredentials.applicationId,
      publicKey: applicationCredentials.publicKey,
      secretHash: applicationCredentials.secretHash,
      type: applicationCredentials.type,
      environment: applicationCredentials.environment,
      scopes: applicationCredentials.scopes,
      status: applicationCredentials.status,
      expiresAt: applicationCredentials.expiresAt,
    })
    .from(applicationCredentials)
    .where(
      and(
        eq(applicationCredentials.publicKey, clientId),
        ne(applicationCredentials.status, 'revoked')
      )
    )
    .limit(1);
  if (!credential || !isCredentialUsable(credential)) {
    return null;
  }
  return credential;
}

/**
 * Whether `userId` names an existing account.
 *
 * Only used where a nonexistent id would otherwise become a FOREIGN KEY
 * violation (a 500) instead of the endpoint's documented 400 — see the
 * `subjectAccountId` binding in `POST /auth/session/create`.
 */
async function userExists(userId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(row);
}

/** Parse the origin of a registered redirect URI, or null when malformed. */
function originFromRedirectUri(redirectUri: string): string | null {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return null;
  }
}

/** First (or only) value of a possibly-array header, trimmed to a string. */
function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

/** The browser-attached `Origin` of the request, or null when absent. */
function requestOrigin(req: express.Request): string | null {
  return firstHeaderValue(req.headers.origin);
}

/**
 * A browser/web context is detectable when the user agent attached an `Origin`
 * or `Referer` header. Native clients (Expo `deviceFlowSignIn`) attach neither,
 * so the absence of BOTH signals a genuine native sign-in that cannot prove an
 * origin and must not be rejected for lacking one.
 */
function hasBrowserContext(req: express.Request): boolean {
  return Boolean(requestOrigin(req) || firstHeaderValue(req.headers.referer));
}

/** True when `origin` is the origin of one of the app's registered redirect URIs. */
function applicationAllowsOrigin(app: Pick<ApplicationRow, 'redirectUris'>, origin: string): boolean {
  return (app.redirectUris ?? []).some((redirectUri) => originFromRedirectUri(redirectUri) === origin);
}

/**
 * Best-effort owner display name for the consent UI. Only meaningful for
 * non-official apps. Never throws — a missing/deleted owner yields undefined so
 * the serializer simply omits the attribution.
 *
 * `created_by_user_id` is NULLABLE here (`ON DELETE SET NULL`): it is pure
 * attribution, and Mongoose's `required` only ever guaranteed a creator was
 * recorded at INSERT — a deleted user left a dangling id with no error. A NULL
 * owner takes the same "no attribution" branch a deleted one already took.
 */
async function resolveDeveloperName(
  app: Pick<ApplicationRow, 'isOfficial' | 'createdByUserId'>
): Promise<string | undefined> {
  if (app.isOfficial || !app.createdByUserId) {
    return undefined;
  }
  const [owner] = await getDb()
    .select({
      username: users.username,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
    })
    .from(users)
    .where(eq(users.id, app.createdByUserId))
    .limit(1);
  if (!owner) {
    return undefined;
  }
  const display =
    composeDisplayName({
      name: { first: owner.nameFirst, last: owner.nameLast },
      username: owner.username,
    }) ?? (owner.username ?? '').trim();
  return display || undefined;
}

/**
 * Record (or refresh) a user's standing consent for a third-party application —
 * the "Connected apps" entry. Upsert on `(user_id, application_id)`.
 *
 * The scope merge is Mongo's `$addToSet: { scopes: { $each } }`: the granted set
 * is a UNION, and only genuinely new scopes are appended, so an existing grant
 * keeps the order it was written in. `first_granted_at` is deliberately absent
 * from the conflict branch — that is `$setOnInsert`, and re-stamping it would
 * erase when the user first consented.
 *
 * `updated_at` is set explicitly: drizzle's `$onUpdate` fires for `db.update()`,
 * not for the update arm of an upsert, so leaving it out would freeze the
 * column at the value the row was inserted with.
 */
async function recordAppGrant(
  userId: string,
  applicationId: string,
  requestedScopes: string[]
): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(appGrants)
    .values({
      userId,
      applicationId,
      scopes: requestedScopes,
      firstGrantedAt: now,
      lastUsedAt: now,
    })
    .onConflictDoUpdate({
      target: [appGrants.userId, appGrants.applicationId],
      set: {
        lastUsedAt: now,
        updatedAt: now,
        scopes: sql`${appGrants.scopes} || (
          select coalesce(array_agg(distinct incoming), '{}'::text[])
          from unnest(excluded.scopes) as incoming
          where not (incoming = any(${appGrants.scopes}))
        )`,
      },
    });
}

const oauthAuthorizeLimiter = rateLimit({
  prefix: 'rl:auth:oauth-authorize:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 20,
});

const oauthTokenLimiter = rateLimit({
  prefix: 'rl:auth:oauth-token:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
});

// Bearer-authenticated claim read. Sized like the other authenticated reads —
// a relying party calls it once per sign-in, not per request.
const oauthUserinfoLimiter = rateLimit({
  prefix: 'rl:auth:oauth-userinfo:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 200 : 60,
});

const oauthClientLookupLimiter = rateLimit({
  prefix: 'rl:auth:client-lookup:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 200 : 60,
});

const oauthConsentLimiter = rateLimit({
  prefix: 'rl:auth:oauth-consent:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 200 : 60,
});

const grantsReadLimiter = rateLimit({
  prefix: 'rl:auth:grants:read:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 200 : 60,
});

const grantsRevokeLimiter = rateLimit({
  prefix: 'rl:auth:grants:revoke:',
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 100 : 30,
});

/**
 * @openapi
 * /auth/oauth/authorize:
 *   post:
 *     tags:
 *       - Authentication
 *     summary: Issue an OAuth2 authorization code (after user consent)
 *     description: >
 *       Called by the Oxy auth UI after the user clicks "Allow" on a
 *       third-party app's consent screen. Requires the authenticated user's
 *       Bearer access token. Returns a short-lived single-use code that the
 *       client app exchanges for tokens via `POST /auth/oauth/token`.
 *
 *       The `redirectUri` MUST exactly match one of the Application's
 *       registered `redirectUris` — otherwise the request is rejected.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - clientId
 *               - redirectUri
 *             properties:
 *               clientId:
 *                 type: string
 *                 description: ApplicationCredential publicKey (OAuth client_id)
 *               redirectUri:
 *                 type: string
 *                 format: uri
 *               state:
 *                 type: string
 *                 description: Opaque CSRF token forwarded back to the client.
 *               codeChallenge:
 *                 type: string
 *                 description: PKCE code challenge (S256). Required for public clients.
 *               codeChallengeMethod:
 *                 type: string
 *                 enum: ['S256']
 *               scope:
 *                 type: string
 *     responses:
 *       200:
 *         description: Authorization code issued.
 *       400:
 *         description: Validation failed.
 *       401:
 *         description: Missing or invalid bearer token.
 *       403:
 *         description: Redirect URI is not registered for this client.
 */
router.post(
  '/oauth/authorize',
  authMiddleware,
  oauthAuthorizeLimiter,
  validate({ body: oauthAuthorizeSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { clientId, redirectUri, state, codeChallenge, codeChallengeMethod, scope } = req.body as {
      clientId: string;
      redirectUri: string;
      state?: string;
      codeChallenge?: string;
      codeChallengeMethod?: 'S256';
      scope?: string;
    };

    // PKCE: if a challenge is provided, the method must be S256. Plain is
    // explicitly rejected — only S256 is acceptable per current OAuth BCP.
    if (codeChallenge && codeChallengeMethod && codeChallengeMethod !== 'S256') {
      throw new BadRequestError('Only S256 code_challenge_method is supported');
    }

    // The ApplicationCredential.publicKey serves as the OAuth `client_id`.
    // Accept `active` OR `deprecated`-but-within-grace credentials; reject
    // `revoked` and any whose rotation grace window has expired.
    const credential = await resolveUsableCredential(clientId);
    if (!credential) {
      // Don't leak whether the client exists vs is revoked/expired.
      throw new BadRequestError('Invalid client');
    }

    const app = await findActiveApplicationById(credential.applicationId);
    if (!app) {
      throw new BadRequestError('Invalid client');
    }

    if (!isAllowedRedirectUri(app, redirectUri)) {
      // Per RFC 6749 §3.1.2.4 the server MUST NOT redirect when the URI is
      // not registered. Surface the error to the auth UI instead.
      logger.warn('[OAuth] Rejected unregistered redirect_uri', {
        clientId: clientId.substring(0, 12) + '...',
        redirectUri,
      });
      throw new ForbiddenError('redirect_uri is not registered for this client');
    }

    const requestedScopes = scope ? scope.split(/\s+/).filter(Boolean) : [];

    let oauthDeviceId: string | undefined;
    const bearerToken = extractTokenFromRequest(req);
    if (bearerToken) {
      try {
        const bearerDecoded = decodeToken(bearerToken);
        if (typeof bearerDecoded?.deviceId === 'string') {
          oauthDeviceId = bearerDecoded.deviceId;
        }
      } catch {
        // Optional device threading — authMiddleware already validated the bearer.
      }
    }

    // Mint a single-use opaque code. The service persists a hash, never
    // the raw value, so leakage of the AuthCode collection would not
    // allow an attacker to redeem outstanding codes.
    const { code: rawCode } = await issueAuthCode({
      userId: user._id.toString(),
      appId: app.id,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: codeChallenge ? 'S256' : undefined,
      scopes: requestedScopes,
      deviceId: oauthDeviceId,
    });

    // Record (or refresh) the user's consent so a returning user skips the
    // consent screen while the granted scopes still cover the request — the
    // standard OAuth returning-user model. TRUSTED apps are auto-approved and
    // never prompt, so a grant is normally pointless for them and would only
    // clutter the "Connected apps" management surface.
    //
    // EXCEPT when the request names a scope the user had to be asked about. Then
    // the grant is the whole point: it is what makes the authorization revocable,
    // and a permission the user granted but cannot find or withdraw is worse than
    // one they were never asked for. A trusted app therefore records a grant for
    // exactly the same reason a third-party one does — it was consented to.
    // Best-effort: a failure here must never block the issued code.
    const consentScopes = userConsentRequiredScopes(requestedScopes);
    if (!isTrustedApplication(app) || consentScopes.length > 0) {
      try {
        await recordAppGrant(user._id.toString(), app.id, requestedScopes);
      } catch (error) {
        logger.warn('[OAuth] Failed to record AppGrant', {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('[OAuth] Authorization code issued', {
      clientId: clientId.substring(0, 12) + '...',
      userId: user._id.toString(),
      hasPkce: Boolean(codeChallenge),
    });

    sendSuccess(res, {
      code: rawCode,
      state: state ?? null,
      redirectUri,
      expiresIn: Math.floor(AUTH_CODE_TTL_MS / 1000),
    });
  })
);

/**
 * @openapi
 * /auth/oauth/consent:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Server-authoritative decision on whether OAuth consent is needed
 *     description: >
 *       Called by the auth UI before rendering the consent screen. Resolves the
 *       `clientId` to an Application (validating the `redirectUri` exactly like
 *       `POST /auth/oauth/authorize`) and decides whether the user must consent:
 *
 *       - TRUSTED apps (first-party / internal / system / official) are
 *         auto-approved → `consentRequired: false, reason: 'trusted'`.
 *       - A prior grant whose scopes cover the requested `scope` →
 *         `consentRequired: false, reason: 'granted'`.
 *       - A prior grant missing some requested scope →
 *         `consentRequired: true, reason: 'scope_changed'`.
 *       - No prior grant → `consentRequired: true, reason: 'new'`.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: clientId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: redirectUri
 *         required: true
 *         schema: { type: string, format: uri }
 *       - in: query
 *         name: scope
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Consent decision.
 *       400:
 *         description: Invalid client.
 *       401:
 *         description: Missing or invalid bearer token.
 *       403:
 *         description: Redirect URI is not registered for this client.
 */
router.get(
  '/oauth/consent',
  authMiddleware,
  oauthConsentLimiter,
  validate({ query: oauthConsentQuerySchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { clientId, redirectUri, scope } = req.query as unknown as {
      clientId: string;
      redirectUri: string;
      scope?: string;
    };

    // Resolve credential → app EXACTLY like POST /oauth/authorize: a usable
    // (active or in-grace) credential pointing at an active application, with
    // the redirect_uri matched exactly (RFC 6749 §3.1.2).
    const credential = await resolveUsableCredential(clientId);
    if (!credential) {
      throw new BadRequestError('Invalid client');
    }
    const app = await findActiveApplicationById(credential.applicationId);
    if (!app) {
      throw new BadRequestError('Invalid client');
    }
    if (!isAllowedRedirectUri(app, redirectUri)) {
      throw new ForbiddenError('redirect_uri is not registered for this client');
    }

    const requestedScopes = scope ? scope.split(/\s+/).filter(Boolean) : [];
    // Scopes over the USER's own data — the follow graph — are never decided on
    // the user's behalf. They are the one thing platform trust does not answer
    // for: the relationships belong to the user, the people on the other end can
    // see them, and being first-party is not a reason to be handed them without
    // being asked. Everything else keeps the "Google with its own apps" model.
    const mustAsk = userConsentRequiredScopes(requestedScopes);

    // Trusted apps are auto-approved for the rest, regardless of scope.
    if (isTrustedApplication(app) && mustAsk.length === 0) {
      sendSuccess(res, { consentRequired: false, reason: 'trusted' });
      return;
    }
    const [grant] = await getDb()
      .select({ scopes: appGrants.scopes })
      .from(appGrants)
      .where(and(eq(appGrants.userId, user._id.toString()), eq(appGrants.applicationId, app.id)))
      .limit(1);

    if (grant) {
      const granted = new Set(grant.scopes ?? []);
      const covered = requestedScopes.every((s) => granted.has(s));
      if (covered) {
        sendSuccess(res, { consentRequired: false, reason: 'granted' });
        return;
      }
      sendSuccess(res, {
        consentRequired: true,
        reason: 'scope_changed',
        ...(mustAsk.length > 0 ? { userConsentScopes: mustAsk } : {}),
      });
      return;
    }

    // The scopes that FORCED the screen travel with the answer so the consent UI
    // can say which one it is asking about. A bare `true` cannot produce the
    // sentence the user needs to make the decision.
    sendSuccess(res, {
      consentRequired: true,
      reason: 'new',
      ...(mustAsk.length > 0 ? { userConsentScopes: mustAsk } : {}),
    });
  })
);

/**
 * Public summary of an application the user has connected via OAuth — what the
 * "Connected apps" management UI consumes. Built from AppGrant rows joined with
 * Application metadata.
 */
interface ConnectedAppSummary {
  applicationId: string;
  name: string;
  logoUrl?: string;
  scopes: string[];
  firstGrantedAt: string;
  lastUsedAt: string;
}

/**
 * @openapi
 * /auth/grants:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: List the third-party apps the user has authorized (Connected apps)
 *     description: >
 *       Returns the user's revocable OAuth grants joined with the application's
 *       name + logo + granted scopes + timestamps. Trusted (auto-approved) apps
 *       are never recorded as grants, so they never appear here.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The user's connected applications.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.get(
  '/grants',
  authMiddleware,
  grantsReadLimiter,
  asyncHandler(async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const grants = await getDb()
      .select({
        applicationId: appGrants.applicationId,
        scopes: appGrants.scopes,
        firstGrantedAt: appGrants.firstGrantedAt,
        lastUsedAt: appGrants.lastUsedAt,
      })
      .from(appGrants)
      .where(eq(appGrants.userId, user._id.toString()))
      .orderBy(desc(appGrants.lastUsedAt));

    const applicationIds = grants.map((grant) => grant.applicationId);
    // `inArray` with an empty list renders `false` in drizzle rather than
    // failing, but the round trip is pointless when the user has no grants.
    const apps = applicationIds.length
      ? await getDb()
          .select({ id: applications.id, name: applications.name, icon: applications.icon })
          .from(applications)
          .where(inArray(applications.id, applicationIds))
      : [];

    const appById = new Map(apps.map((app) => [app.id, app]));

    const data: ConnectedAppSummary[] = [];
    for (const grant of grants) {
      const app = appById.get(grant.applicationId);
      // Skip grants whose application no longer exists — effectively revoked.
      if (!app) continue;
      data.push({
        applicationId: grant.applicationId,
        name: app.name,
        logoUrl: app.icon ?? undefined,
        scopes: grant.scopes,
        firstGrantedAt: grant.firstGrantedAt.toISOString(),
        lastUsedAt: grant.lastUsedAt.toISOString(),
      });
    }

    sendSuccess(res, data);
  })
);

/**
 * @openapi
 * /auth/grants/{applicationId}:
 *   delete:
 *     tags:
 *       - Authentication
 *     summary: Revoke a connected app's OAuth grant
 *     description: >
 *       Deletes the user's AppGrant for the application so the next OAuth
 *       authorize for this app prompts for consent again.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: applicationId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: >
 *           Grant revoked. Idempotent, and total: an `applicationId` that names
 *           no application — or one the caller never granted — deletes nothing
 *           and answers the same way, so nothing here is an existence oracle.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.delete(
  '/grants/:applicationId',
  authMiddleware,
  grantsRevokeLimiter,
  validate({ params: grantApplicationIdParams }),
  asyncHandler(async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { applicationId } = req.params;

    // Drop the OAuth grant — the next authorize for this app re-prompts consent.
    //
    // The `isValidObjectId` guard is gone: it existed only to stop a malformed
    // id reaching Mongoose and raising a CastError, and it would additionally
    // have rejected every uuid v7 application id minted after the cutover. Revoke
    // is idempotent by design — an id that names nothing deletes nothing and
    // answers `{ revoked: true }`, exactly as an id with no grant already did.
    await getDb()
      .delete(appGrants)
      .where(
        and(eq(appGrants.userId, user._id.toString()), eq(appGrants.applicationId, applicationId))
      );

    sendSuccess(res, { revoked: true });
  })
);

/**
 * The only grant this endpoint implements. Oxy issues no refresh tokens — the
 * device-first `deviceId` + `deviceSecret` pair replaces them — so
 * `refresh_token`, `client_credentials` and `password` are all unsupported.
 */
const SUPPORTED_GRANT_TYPE = 'authorization_code';

/**
 * The ONE description every code-binding failure reports.
 *
 * `exchangeAuthCode` distinguishes internally between an unknown code, a
 * replayed one, an expired one, a code minted for another app, a mismatched
 * `redirect_uri`, and a failed PKCE verification — and the caller MUST NOT.
 * An attacker holding a stolen code would otherwise learn which precondition it
 * still satisfies, turning the endpoint into an oracle. One code, one sentence,
 * for all of them.
 */
const INVALID_GRANT_DESCRIPTION =
  'The authorization code is invalid, expired, already used, or was not issued for this client and redirect URI.';

/**
 * Read the RFC 6749 §4.1.3 token request off an `application/x-www-form-urlencoded`
 * body, mapping every rejection to the RFC error code the client expects.
 *
 * The generic `validate` middleware is deliberately NOT used here: it answers
 * with the house `{ error: 'BAD_REQUEST', message, details }` envelope, which no
 * OAuth client can interpret. Parsing inline keeps the endpoint's entire error
 * contract in one shape.
 */
function parseTokenRequest(req: express.Request): z.infer<typeof oauthTokenSchema> {
  // RFC 6749 §4.1.3 fixes the request encoding. Rejecting anything else keeps
  // the contract unambiguous instead of silently half-accepting a JSON body.
  if (!req.is('application/x-www-form-urlencoded')) {
    throw OAuthError.invalidRequest(
      'The token request must be application/x-www-form-urlencoded.',
    );
  }

  const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};

  // Checked before the schema so an unknown grant is reported as
  // `unsupported_grant_type` (RFC 6749 §5.2) instead of a generic
  // `invalid_request` about a missing `code`.
  if (body.grant_type !== SUPPORTED_GRANT_TYPE) {
    throw OAuthError.unsupportedGrantType(
      `Only grant_type=${SUPPORTED_GRANT_TYPE} is supported.`,
    );
  }

  const parsed = oauthTokenSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const parameter = issue?.path.join('.') || 'request';
    throw OAuthError.invalidRequest(`Invalid or missing parameter: ${parameter}.`);
  }
  return parsed.data;
}

/** True for a plain object body (an urlencoded body is always one, when present). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @openapi
 * /auth/oauth/token:
 *   post:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Exchange an OAuth2 authorization code for tokens (RFC 6749)
 *     description: >
 *       Standards-compliant RFC 6749 §4.1.3 token endpoint. Single-use exchange
 *       of an authorization code (from `POST /auth/oauth/authorize`) for a
 *       bearer access token, rotating device credentials, and session ID.
 *
 *       The request MUST be `application/x-www-form-urlencoded` with
 *       `grant_type=authorization_code`. Confidential clients authenticate with
 *       `client_secret` — either in the body (`client_secret_post`) or via HTTP
 *       Basic (`client_secret_basic`), never both. Public clients send
 *       `client_id` plus the PKCE `code_verifier`.
 *
 *       The response is a FLAT JSON document (no `data` wrapper) sent with
 *       `Cache-Control: no-store`, as RFC 6749 §5.1 requires. Alongside the
 *       standard `access_token` / `token_type` / `expires_in` it carries Oxy's
 *       device-first extras (`session_id`, `deviceId`, `deviceSecret`, `user`),
 *       which §5.1 permits as additional parameters.
 *
 *       Errors follow RFC 6749 §5.2 (`{ "error": ..., "error_description": ... }`).
 *       Replaying an already-used code, sending a code past its 60-second TTL,
 *       or mismatching the `redirect_uri` all return the same
 *       `400 invalid_grant` with no detail about which check failed.
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             required:
 *               - grant_type
 *               - code
 *               - redirect_uri
 *             properties:
 *               grant_type:
 *                 type: string
 *                 enum: [authorization_code]
 *               code:
 *                 type: string
 *               redirect_uri:
 *                 type: string
 *                 format: uri
 *               client_id:
 *                 type: string
 *                 description: Required unless supplied via HTTP Basic authentication.
 *               client_secret:
 *                 type: string
 *                 description: Confidential clients only. Mutually exclusive with HTTP Basic.
 *               code_verifier:
 *                 type: string
 *                 description: PKCE verifier. Required for public clients.
 *     responses:
 *       200:
 *         description: Access token issued.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 access_token:
 *                   type: string
 *                 token_type:
 *                   type: string
 *                   enum: [Bearer]
 *                 expires_in:
 *                   type: integer
 *                 scope:
 *                   type: string
 *                   description: Space-delimited granted scopes. Omitted when the grant carries none.
 *                 session_id:
 *                   type: string
 *                 deviceId:
 *                   type: string
 *                 deviceSecret:
 *                   type: string
 *                 user:
 *                   type: object
 *       400:
 *         description: >
 *           RFC 6749 §5.2 error — `invalid_request`, `invalid_grant`, or
 *           `unsupported_grant_type`.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OAuthError'
 *       401:
 *         description: >
 *           `invalid_client` — unknown client, or client authentication failed.
 *           Carries a `WWW-Authenticate: Basic` challenge.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OAuthError'
 */
router.post(
  '/oauth/token',
  oauthTokenLimiter,
  oauthHandler(async (req, res) => {
    const params = parseTokenRequest(req);
    const { clientId, clientSecret } = resolveClientAuthentication({
      authorizationHeader: req.headers.authorization,
      bodyClientId: params.client_id,
      bodyClientSecret: params.client_secret,
    });

    if (!clientId) {
      throw OAuthError.invalidRequest('client_id is required.');
    }
    // A caller that presents neither a client secret nor a PKCE verifier has
    // proven nothing. Rejected here, before any code lookup, so an unauthorised
    // caller cannot reach the exchange at all.
    if (!clientSecret && !params.code_verifier) {
      throw OAuthError.invalidRequest(
        'Either client_secret (confidential client) or code_verifier (PKCE) is required.',
      );
    }

    // Accept `active` OR `deprecated`-but-within-grace credentials; reject
    // `revoked` and any whose rotation grace window has expired.
    const credential = await resolveUsableCredential(clientId);
    if (!credential) {
      throw OAuthError.invalidClient('Client authentication failed.');
    }

    const app = await findActiveApplicationById(credential.applicationId);
    if (!app) {
      throw OAuthError.invalidClient('Client authentication failed.');
    }

    // If the caller asserts a confidential client secret, verify it in
    // constant time BEFORE we attempt the code exchange — that way an
    // attacker without a secret can't probe the code-binding outcomes. The
    // secret is compared as a SHA-256 hash against the stored `secretHash`.
    let clientSecretProvided = false;
    if (clientSecret) {
      if (!credential.secretHash) {
        throw OAuthError.invalidClient('Client authentication failed.');
      }
      const expected = Buffer.from(credential.secretHash);
      const provided = Buffer.from(
        crypto.createHash('sha256').update(clientSecret).digest('hex')
      );
      if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
        throw OAuthError.invalidClient('Client authentication failed.');
      }
      clientSecretProvided = true;
    }

    const exchange = await exchangeAuthCode({
      rawCode: params.code,
      appId: app.id,
      redirectUri: params.redirect_uri,
      clientSecretProvided,
      codeVerifier: params.code_verifier,
    });

    if (!exchange.ok) {
      logger.warn('[OAuth] Token exchange rejected', {
        reason: exchange.reason,
        clientId: clientId.substring(0, 12) + '...',
      });
      if (exchange.reason === 'invalid_client') {
        // The code carried no PKCE challenge and the caller presented no
        // secret — a client-authentication failure, not a bad code.
        throw OAuthError.invalidClient('Client authentication failed.');
      }
      throw OAuthError.invalidGrant(INVALID_GRANT_DESCRIPTION);
    }

    // Issue a session bound to the authenticated user from the code. The read
    // goes through `publicColumns`, so the protected columns cannot reach the
    // `user` field of the token response below.
    const userId = String(exchange.code.userId);
    const [user] = await getDb()
      .select(publicColumns(users))
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      throw OAuthError.invalidGrant(INVALID_GRANT_DESCRIPTION);
    }

    // A DELEGATED code authorises the app to act as `userId` on behalf of the
    // approving identity. Carry that operator onto the session so its validity
    // stays bound to their live `account:act_as` membership — revoking the
    // membership kills the session (re-checked on validate + refresh), exactly
    // like a managed-account switch.
    const operatedByUserId = exchange.code.operatedByUserId
      ? exchange.code.operatedByUserId.toString()
      : undefined;

    const session = await sessionService.createSession(
      userId,
      req,
      {
        deviceName: `${app.name} OAuth`,
        // OAuth clients are an authorization boundary, so their bearer must
        // live on an isolated device session. Reusing the authorizing app's
        // central deviceId would let the client operate every account already
        // registered on that shared device through /session/device/*.
        ...(operatedByUserId ? { operatedByUserId } : {}),
      },
    );

    const deviceExtras = await finalizeDeviceLogin({
      session: { sessionId: session.sessionId, deviceId: session.deviceId },
      userId,
    });
    if (!deviceExtras.deviceSecret) {
      logger.error('[OAuth] Token exchange succeeded but deviceSecret mint failed', {
        userId,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      });
      throw OAuthError.serverError('Failed to finalize the device session.');
    }

    await getDb()
      .update(applications)
      .set({ lastUsedAt: new Date() })
      .where(eq(applications.id, app.id));

    const userData = formatUserResponse(user);
    const grantedScopes = Array.isArray(exchange.code.scopes) ? exchange.code.scopes : [];

    // FLAT body, no `sendSuccess` wrapper — see `utils/oauthResponse.ts` for why
    // the OAuth surface is the one place that may not use the house envelope.
    sendOAuthSuccess(res, {
      access_token: session.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      // RFC 6749 §5.1: REQUIRED when the granted scope differs from the
      // requested one, which it can (the authorize step intersects the request
      // with the app's registered scopes). Omitted when the grant carries none.
      ...(grantedScopes.length > 0 ? { scope: grantedScopes.join(' ') } : {}),
      // Oxy's device-first extras, permitted by §5.1 as additional parameters.
      session_id: session.sessionId,
      deviceId: session.deviceId,
      deviceSecret: deviceExtras.deviceSecret,
      user: userData,
    });
  })
);

/** A claim value, or undefined when the source holds nothing usable. */
function stringClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the OpenID Connect `picture` claim to an ABSOLUTE URL.
 *
 * `User.avatar` holds either an Oxy file id or — for a mirrored federated
 * account — an already-absolute URL. File ids become an our-origin
 * `/assets/<id>/stream` URL, the same public, unauthenticated endpoint the
 * asset API itself advertises; it 302s to `cloud.oxy.so` for CDN-backed public
 * assets. Building the URL here costs no I/O, where resolving the CDN URL
 * directly would put an S3 probe on every userinfo call.
 */
function resolveUserinfoPicture(req: express.Request, avatar: unknown): string | undefined {
  const value = stringClaim(avatar);
  if (!value) {
    return undefined;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const host = req.get('host');
  if (!host) {
    return undefined;
  }
  return `${req.protocol}://${host}/assets/${encodeURIComponent(value)}/stream`;
}

/**
 * OpenID Connect userinfo (OIDC Core §5.3).
 *
 * Bearer-authenticated, and — like the token endpoint — answers with a FLAT
 * JSON document and RFC 6750 challenge headers rather than the house envelopes.
 * Registered for both GET and POST because OIDC Core §5.3.1 requires both.
 * The access token is read from the `Authorization` header, or — on POST only —
 * from an `application/x-www-form-urlencoded` `access_token` parameter.
 */
async function handleOAuthUserinfo(req: express.Request, res: express.Response): Promise<void> {
  // RFC 6750 §2.3 permits the token as a URI query parameter; Oxy does not.
  // Tokens in URLs leak into proxy access logs, browser history, and `Referer`
  // headers — the same rule `rejectQueryToken` enforces elsewhere, restated
  // here so this endpoint's error shape stays RFC-consistent.
  if (req.query.access_token !== undefined || req.query.token !== undefined) {
    throw OAuthError.invalidRequest(
      'The access token must be sent in the Authorization header, not the query string.',
    );
  }

  const token = extractOAuthUserinfoToken(req);
  let user = null;
  if (token) {
    const decoded = decodeToken(token);
    if (decoded?.sessionId) {
      user = await validateSessionToken(token);
    }
  }
  if (!user) {
    // RFC 6750 §3.1 says a request carrying NO credentials SHOULD omit the
    // error code. We report `invalid_token` for that case too, deliberately:
    // one indistinguishable answer for missing, malformed, expired, and revoked
    // tokens means the response never confirms that a token was recognised.
    throw OAuthError.invalidToken('The access token is invalid or expired.');
  }

  const rawName = isRecord(user.name) ? user.name : undefined;
  const preferredUsername = stringClaim(user.username);
  // The user's REAL name, or undefined when they have none — the API never
  // synthesizes one from the handle (see `composeDisplayName`). Relying parties
  // fall back to `preferred_username`.
  const displayName = composeDisplayName({
    name: {
      first: stringClaim(rawName?.first),
      last: stringClaim(rawName?.last),
      full: stringClaim(rawName?.full),
      displayName: stringClaim(rawName?.displayName),
    },
  });
  const picture = resolveUserinfoPicture(req, user.avatar);

  sendOAuthSuccess(res, {
    // `sub` is `users.id` — the account's PERMANENT identifier — and never the
    // username. Usernames are mutable and case-sensitive (`Nate` and `nate`
    // can be different accounts), so a username-derived `sub` would let a
    // renamed or re-registered handle inherit another user's identity in every
    // relying party that keyed on it. `normalizeUser` guarantees this is the
    // account id and never the publicKey.
    sub: user._id,
    ...(preferredUsername ? { preferred_username: preferredUsername } : {}),
    ...(displayName ? { name: displayName } : {}),
    ...(picture ? { picture } : {}),
  });
}

/**
 * @openapi
 * /auth/oauth/userinfo:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: OpenID Connect userinfo for the bearer's account
 *     description: >
 *       Returns the standard OpenID Connect claims for the account the access
 *       token belongs to. The response is a FLAT JSON document (no `data`
 *       wrapper) so any OIDC client can read it, and `sub` is the account's
 *       permanent id — NEVER the username, which is mutable and
 *       case-sensitive.
 *
 *       `name` is omitted for accounts with no real name (the API never
 *       synthesizes one from the handle) and `picture` is omitted for accounts
 *       with no avatar. Also accepts POST, as OIDC Core §5.3.1 requires; the
 *       token is read only from the `Authorization` header.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The bearer's claims.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [sub]
 *               properties:
 *                 sub:
 *                   type: string
 *                   description: Permanent, immutable account identifier.
 *                 preferred_username:
 *                   type: string
 *                 name:
 *                   type: string
 *                 picture:
 *                   type: string
 *                   format: uri
 *       400:
 *         description: '`invalid_request` — the token was sent in the query string.'
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OAuthError'
 *       401:
 *         description: >
 *           `invalid_token` — missing, malformed, or expired bearer token.
 *           Carries a `WWW-Authenticate: Bearer` challenge.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/OAuthError'
 */
router.get('/oauth/userinfo', oauthUserinfoLimiter, oauthHandler(handleOAuthUserinfo));
router.post('/oauth/userinfo', oauthUserinfoLimiter, oauthHandler(handleOAuthUserinfo));

/**
 * @openapi
 * /auth/oauth/client/{clientId}:
 *   get:
 *     tags:
 *       - Authentication
 *     security: []
 *     summary: Public lookup of an application's consent-UI metadata
 *     description: >
 *       Resolves an OAuth `client_id` (= ApplicationCredential public key) to
 *       the sanitized public metadata of its registered Application so the auth
 *       web consent screen can render the app's name, icon, official badge, and
 *       requested scopes. No bearer token is required. Secrets, webhook config,
 *       owner identity, and capabilities are never returned. Returns a generic
 *       404 for unknown, revoked, expired, or inactive clients (no enumeration).
 *     parameters:
 *       - name: clientId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sanitized application metadata.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 application:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     name:
 *                       type: string
 *                     description:
 *                       type: string
 *                     icon:
 *                       type: string
 *                     websiteUrl:
 *                       type: string
 *                     type:
 *                       type: string
 *                       enum: [first_party, third_party, internal, system]
 *                     isOfficial:
 *                       type: boolean
 *                     isInternal:
 *                       type: boolean
 *                     scopes:
 *                       type: array
 *                       items:
 *                         type: string
 *                     developerName:
 *                       type: string
 *                       description: Best-effort owner display name (non-official apps only).
 *       404:
 *         description: Application not found.
 */
router.get(
  '/oauth/client/:clientId',
  oauthClientLookupLimiter,
  validate({ params: oauthClientParams }),
  asyncHandler(async (req, res) => {
    const { clientId } = req.params;

    const credential = await resolveUsableCredential(clientId);
    if (!credential) {
      // Generic 404 — don't disclose existence vs revoked/expired.
      throw new NotFoundError('Application not found');
    }

    const app = await findActiveApplicationById(credential.applicationId);
    if (!app) {
      throw new NotFoundError('Application not found');
    }

    const developerName = await resolveDeveloperName(app);

    sendSuccess(res, {
      application: serializePublicApplication(app, developerName),
    });
  })
);

// ============================================
// Service Token Authentication (Internal Services)
// ============================================

const SERVICE_TOKEN_EXPIRY = 3600; // 1 hour in seconds

const serviceTokenLimiter = rateLimit({
  prefix: 'rl:auth:service-token:',
  windowMs: 5 * 60 * 1000, // 5-minute window
  max: process.env.NODE_ENV === 'development' ? 100 : 10 // 10 per 5 minutes (2/min avg)
});

/**
 * @openapi
 * /auth/service-token:
 *   post:
 *     tags:
 *       - Authentication
 *     summary: Exchange credentials for a service token
 *     description: >
 *       Internal service-to-service authentication endpoint.
 *       Exchange ApplicationCredential credentials (apiKey = publicKey,
 *       apiSecret = plaintext secret) for a short-lived service JWT (1 hour).
 *       Requires a usable credential of type `service` on an active
 *       application: either `active`, or `deprecated` but still within its
 *       rotation grace window (a credential rotated within the last 7 days keeps
 *       minting tokens until its grace `expiresAt`). `revoked` and grace-expired
 *       credentials are rejected. The minted JWT carries `appId` (Application
 *       `_id`) and `credentialId` (the minting ApplicationCredential `_id`).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - apiKey
 *               - apiSecret
 *             properties:
 *               apiKey:
 *                 type: string
 *                 description: ApplicationCredential publicKey
 *                 example: oxy_dk_abc123
 *               apiSecret:
 *                 type: string
 *                 description: ApplicationCredential plaintext secret
 *     responses:
 *       200:
 *         description: Service token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: Short-lived JWT for service-to-service calls
 *                 expiresIn:
 *                   type: integer
 *                   description: Token lifetime in seconds
 *                   example: 3600
 *                 appName:
 *                   type: string
 *                   description: Name of the authenticated app
 *       400:
 *         description: Missing apiKey or apiSecret
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Credential is not a service credential
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Rate limit exceeded
 */
router.post('/service-token', serviceTokenLimiter, validate({ body: serviceTokenSchema }), asyncHandler(async (req, res) => {
  const { apiKey, apiSecret } = req.body;

  if (!apiKey || !apiSecret) {
    throw new BadRequestError('apiKey and apiSecret are required');
  }

  if (!process.env.ACCESS_TOKEN_SECRET) {
    logger.error('[ServiceToken] ACCESS_TOKEN_SECRET not configured');
    throw new Error('Server configuration error');
  }

  // Find the credential by its public key (apiKey). The credential must be a
  // `service` credential that is currently usable: `active`, or `deprecated`
  // but still inside its rotation grace window. `revoked` and grace-expired
  // credentials are rejected.
  const credential = await resolveUsableCredential(apiKey);

  if (!credential) {
    logger.warn('[ServiceToken] Invalid apiKey attempt', { apiKey: apiKey.substring(0, 12) + '...' });
    throw new UnauthorizedError('Invalid credentials');
  }

  if (credential.type !== 'service') {
    logger.warn('[ServiceToken] Non-service credential attempted service token', {
      credentialId: credential.id,
      applicationId: credential.applicationId,
    });
    throw new ForbiddenError('Service tokens are only available to service credentials');
  }

  // Validate the secret as a SHA-256 hash with a timing-safe comparison.
  if (!credential.secretHash) {
    throw new UnauthorizedError('Invalid credentials');
  }
  const expectedBuffer = Buffer.from(credential.secretHash);
  const providedBuffer = Buffer.from(crypto.createHash('sha256').update(apiSecret).digest('hex'));

  if (expectedBuffer.length !== providedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    logger.warn('[ServiceToken] Invalid apiSecret attempt', {
      credentialId: credential.id,
      applicationId: credential.applicationId,
    });
    throw new UnauthorizedError('Invalid credentials');
  }

  // The owning application must be active and part of the platform-trusted set.
  // Service tokens are bearer credentials for Oxy-to-Oxy / internal routes;
  // self-service third-party applications must not be able to mint them even if
  // they somehow hold a historical `service` credential row — EXCEPT via the
  // same narrow Oxy Pay carve-out enforced at credential-creation time
  // (`applications.ts` POST /:appId/credentials): a non-trusted application MAY
  // mint a service token from a credential whose OWN scopes are a non-empty,
  // payments-only set ({@link isPaymentsScope}, i.e. `payments:read`/
  // `payments:write`). Keying this on `credential.scopes` (never `app.scopes`)
  // is deliberate: a credential requesting no scopes falls back below to the
  // app's FULL granted scope set (`intersectScopes` fallback), so a scopeless
  // credential must never qualify here — only an explicit, payments-only
  // credential does. Both payments scopes are already non-privileged/
  // self-grantable and tenant-scoped, and the Oxy Pay Gateway only honours
  // `payments:*`, so this lets external Oxy Pay merchants (WooCommerce,
  // Mercaria, etc.) mint the payments-scoped service token the `@oxyhq/pay`
  // SDK needs without ever letting a self-service app mint a token carrying
  // any other capability.
  const app = await findActiveApplicationById(credential.applicationId);
  if (!app) {
    logger.warn('[ServiceToken] Application inactive for service credential', {
      credentialId: credential.id,
      applicationId: credential.applicationId,
    });
    throw new UnauthorizedError('Invalid credentials');
  }

  const isPaymentsOnlyServiceCredential =
    credential.scopes.length > 0 && credential.scopes.every(isPaymentsScope);
  if (!isTrustedApplication(app) && !isPaymentsOnlyServiceCredential) {
    logger.warn('[ServiceToken] Untrusted application attempted service token', {
      credentialId: credential.id,
      applicationId: credential.applicationId,
    });
    throw new ForbiddenError('Service tokens are only available to trusted applications');
  }

  // Generate stateless service JWT — embed granted scopes so downstream
  // middleware can do per-scope authorisation without an extra DB lookup. The
  // `appId` claim is the Application `_id` (UNCHANGED claim name — see contract
  // §5). `credentialId` is the specific ApplicationCredential `_id` that minted
  // this token, so downstream can attribute calls to a credential (e.g. for
  // post-rotation revocation). `environment` (F2.0) mirrors the minting
  // credential's own `ApplicationCredential.environment` so downstream services
  // (e.g. the Oxy Pay Gateway) can enforce test/live isolation without a second
  // DB lookup. `issuer`/`audience` MUST match what `@oxyhq/core`'s `oxy.auth()`
  // / `oxy.serviceAuth()` verifies against (`OXY_JWT_ISSUER`/`OXY_JWT_AUDIENCE`
  // in `OxyServices.utility.ts`) — omitting them left every real service token
  // unverifiable by any external consumer of the SDK.
  //
  // SCOPE AUTHORITY: the effective scopes are the credential's requested scopes
  // INTERSECTED with the application's granted scopes — a credential can never
  // exceed its app's authority (a privileged scope like federation:write only
  // survives if BOTH the credential AND the app hold it). A credential that
  // requested no scopes inherits the app's full granted set (unchanged
  // behaviour for credentials provisioned without explicit scopes).
  const appScopes = app.scopes;
  const scopes =
    credential.scopes.length > 0 ? intersectScopes(credential.scopes, appScopes) : appScopes;
  const token = jwt.sign(
    {
      type: 'service',
      appId: app.id,
      appName: app.name,
      credentialId: credential.id,
      scopes,
      environment: credential.environment,
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: SERVICE_TOKEN_EXPIRY, issuer: 'oxy-auth', audience: 'oxy-api' }
  );

  // Update lastUsedAt on the credential and the application.
  const usedAt = new Date();
  await getDb()
    .update(applicationCredentials)
    .set({ lastUsedAt: usedAt })
    .where(eq(applicationCredentials.id, credential.id));
  await getDb()
    .update(applications)
    .set({ lastUsedAt: usedAt })
    .where(eq(applications.id, app.id));

  logger.info('[ServiceToken] Service token issued', {
    credentialId: credential.id,
    applicationId: app.id,
    appName: app.name,
    expiresIn: SERVICE_TOKEN_EXPIRY,
  });

  sendSuccess(res, {
    token,
    expiresIn: SERVICE_TOKEN_EXPIRY,
    appName: app.name,
  });
}));

export default router;
