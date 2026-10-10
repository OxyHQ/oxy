import crypto from 'crypto';
import type { Request, Response } from 'express';
import { and, asc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { publicColumns } from '@oxy.so/db/assert';
import { getDb } from '../config/postgres';
import { authChallenges } from '../db/schema/authChallenges';
import { notifications } from '../db/schema/notifications';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { sessions } from '../db/schema/sessions';
import { userAuthMethods } from '../db/schema/userAuthMethods';
import { userLinkMetadata } from '../db/schema/userLinkMetadata';
import { users } from '../db/schema/users';
import type { SessionAuthResponse, ClientSession } from '../types/session';
import { getDeviceActiveSessions, logoutAllDeviceSessions } from '../utils/deviceUtils';
import { emitSessionUpdate } from '../server';
import SignatureService from '../services/signature.service';
import sessionService from '../services/session.service';
import sessionCache from '../utils/sessionCache';
import { logger } from '../utils/logger';
import { formatUserResponse, type UserLike } from '../utils/userTransform';
import { userService } from '../services/user.service';
import securityActivityService from '../services/securityActivityService';
import { finalizeDeviceLogin } from '../services/deviceLogin.service';
import type { AuthRequest } from '../middleware/auth';
import {
  accountActorChainFromSession,
  isValidUsername,
  USERNAME_INVALID_MESSAGE,
} from '@oxy.so/contracts';
import {
  meetsRegistrationPowDifficulty,
  REGISTRATION_POW_DIFFICULTY_BITS,
  registrationPowMessage,
} from '@oxy.so/protocol';
import { normalizeUsername } from '../utils/username';
import type { SessionCreateOptions } from '../types/session.types';

/**
 * Session options an UNAUTHENTICATED sign-in body may set.
 *
 * Deliberately no `deviceId`. `createSession` documents its precedence as
 * `deviceId > stableDeviceKey > UA/IP > random` and stamps an explicit id
 * verbatim, so accepting one here let a caller who has only proved they are
 * THEMSELVES place that session on a device id they merely knew — and
 * `finalizeDeviceLogin` then mints a device secret against it. The callers that
 * legitimately pin a device id are server-side and already authorized (the
 * account-switch route threading the operator's own central device id); they
 * call `createSession` directly.
 */
export function sessionCreateOptionsFromBody(body: {
  deviceName?: string;
  deviceFingerprint?: string;
}): SessionCreateOptions {
  return {
    deviceName: body.deviceName,
    deviceFingerprint: body.deviceFingerprint,
  };
}

/**
 * Extract the authenticated user's id from an `AuthRequest` populated by
 * `authMiddleware`, so it can be compared against `sessions.user_id`.
 */
function getAuthenticatedUserId(req: AuthRequest): string | null {
  const user = req.user;
  if (!user) return null;
  if (user._id) return user._id.toString();
  return null;
}

/** The acting session of a session-management route, once it is proven. */
interface ActingSession {
  sessionId: string;
  userId: string;
  deviceId: string;
}

/**
 * Resolve the `:sessionId` a session-management route acts through, and prove
 * it with the bearer (#1372). A session id is an identifier that travels in
 * client state, logs and URLs, never an authenticator: the route runs behind
 * `authMiddleware`, and the acting session must be live AND belong to the
 * bearer's user. Anything else answers the same `401`, so the response says
 * nothing about whether the id exists or whose it is.
 */
async function resolveActingSession(
  req: AuthRequest,
  res: Response,
): Promise<ActingSession | null> {
  const { sessionId } = req.params;
  if (!sessionId) {
    res.status(400).json({ message: 'Session ID is required' });
    return null;
  }
  const authenticatedUserId = getAuthenticatedUserId(req);
  const result = authenticatedUserId
    ? await sessionService.validateSessionById(sessionId, false)
    : null;
  const session = result?.session;
  if (!session || session.userId?.toString() !== authenticatedUserId) {
    res.status(401).json({ message: 'Invalid session', code: 'INVALID_SESSION' });
    return null;
  }
  return { sessionId, userId: session.userId.toString(), deviceId: session.deviceId };
}

/**
 * The unique constraint a Postgres `23505` (unique_violation) names, or null
 * when `error` is not one.
 *
 * This is the port of the `E11000` / `keyPattern` handling below it: the
 * pre-checks in `register` cannot close the race between "does this identifier
 * exist" and the insert, so the database's own answer is what decides. Postgres
 * reports the INDEX name, which is why the identifier indexes in
 * `db/schema/users.ts` are named rather than left to drizzle's derivation.
 */
function violatedUniqueIndex(error: unknown): string | null {
  // Drizzle wraps the driver error, and only the driver's own error carries
  // `code`/`constraint_name` — so both levels are inspected rather than
  // whichever one happens to surface today.
  for (const level of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof level !== 'object' || level === null) continue;
    const candidate = level as { code?: unknown; constraint_name?: unknown };
    if (candidate.code !== '23505') continue;
    if (typeof candidate.constraint_name === 'string') return candidate.constraint_name;
  }
  return null;
}

// Challenge expiration time (5 minutes)
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function buildSessionAuthResponse(
  session: { sessionId: string; deviceId: string; expiresAt: Date; accessToken?: string },
  user: UserLike,
): SessionAuthResponse | null {
  const userData = formatUserResponse(user);
  if (!userData) {
    return null;
  }

  return {
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    expiresAt: session.expiresAt.toISOString(),
    accessToken: session.accessToken,
    user: {
      id: userData.id,
      username: userData.username,
      avatar: userData.avatar,
    },
  };
}

/**
 * Who acted, and as whom, on this session — read off the ROW, never off a
 * header or a token claim (issue #1520). A consumer's audit records
 * `actorAccountId` as the actor and `effectiveAccountId` as the account spoken
 * as; a bot acting unoperated is its own actor, never its owner.
 */
function sessionActorChain(session: { userId: string; operatedByUserId?: string | null }) {
  return accountActorChainFromSession({
    subjectAccountId: session.userId,
    operatedByAccountId: session.operatedByUserId ?? null,
  });
}

export class SessionController {
  /**
   * Register a new user with public key authentication
   * No passwords needed - identity is verified via signature
   */
  static async register(req: Request, res: Response) {
    try {
      const { publicKey, signature, timestamp, username } = req.body;
      const db = getDb();

      // Validate required fields
      if (!publicKey || !signature || !timestamp) {
        return res.status(400).json({
          message: 'Public key, signature, and timestamp are required',
        });
      }

      // The username is required and written with the key in one insert: an
      // account never exists without one (the email sign-up path in
      // `routes/signIn.ts` holds the same invariant).
      const normalizedUsername = typeof username === 'string' ? normalizeUsername(username) : '';
      if (!isValidUsername(normalizedUsername)) {
        return res.status(400).json({ message: USERNAME_INVALID_MESSAGE });
      }

      // Validate public key format
      if (!SignatureService.isValidPublicKey(publicKey)) {
        return res.status(400).json({ message: 'Invalid public key format' });
      }

      // Verify the registration signature
      const isValidSignature = SignatureService.verifyRegistrationSignature(
        publicKey,
        signature,
        timestamp,
      );

      if (!isValidSignature) {
        return res.status(401).json({
          message: 'Invalid signature. Please sign the registration request with your private key.',
        });
      }

      // Registration proof-of-work — ADVISORY ONLY for now, never rejects.
      // `powNonce` is optional on the wire (`registerPublicKeySchema`) and every
      // Oxy app consumes the SDK as a PUBLISHED package, not this monorepo
      // live — hard-rejecting a missing/invalid nonce today would break signup
      // in any app still pinned to an SDK build older than the one that starts
      // sending it. This only logs the outcome so there is telemetry for when
      // that stops being true. TO HARD-ENFORCE LATER: turn the two
      // `logger.warn` branches below into `return res.status(400).json(...)`.
      const { powNonce } = req.body as { powNonce?: unknown };
      if (typeof powNonce !== 'string' || powNonce.length === 0) {
        logger.warn('Registration proof-of-work missing', {
          component: 'SessionController',
          method: 'register',
          powResult: 'missing',
        });
      } else {
        const digest = crypto
          .createHash('sha256')
          .update(registrationPowMessage(publicKey, timestamp, powNonce))
          .digest('hex');
        if (!meetsRegistrationPowDifficulty(digest, REGISTRATION_POW_DIFFICULTY_BITS)) {
          logger.warn('Registration proof-of-work invalid', {
            component: 'SessionController',
            method: 'register',
            powResult: 'invalid',
          });
        }
      }

      // Check if user already exists (by publicKey only - that's the identity).
      // `lower(btrim(...))` is the expression `users_lower_public_key_key` is
      // built on — a plain equality would be case-sensitive and would not use it.
      const [existingUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(btrim(${users.publicKey})) = lower(btrim(${publicKey}))`)
        .limit(1);

      if (existingUser) {
        return res.status(409).json({
          message: 'Identity already registered',
        });
      }

      // The Mongo-era `exactCaseInsensitiveUsernameRegex` scan becomes the
      // expression `users_lower_username_key` indexes.
      const [existingUsername] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(btrim(${users.username})) = lower(btrim(${normalizedUsername}))`)
        .limit(1);
      if (existingUsername) {
        return res.status(409).json({ message: 'Username already taken' });
      }

      // Create the account (identity is the publicKey) together with the origin
      // auth method, so the account's provenance is captured consistently with
      // the social-auth path. One transaction: an account whose only credential
      // failed to insert could never be signed into, and Mongo's embedded array
      // made that atomicity implicit.
      const user = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({
            publicKey,
            username: normalizedUsername,
          })
          .returning(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE));
        await tx.insert(userAuthMethods).values({
          userId: created.id,
          type: 'identity',
          methodPublicKey: publicKey,
        });
        return created;
      });

      // Create welcome notification (non-blocking - don't fail registration if this fails)
      try {
        await db.insert(notifications).values({
          recipientId: user.id,
          actorId: user.id,
          type: 'welcome',
          entityId: user.id,
          entityType: 'profile',
          read: false,
        });
      } catch (notificationError) {
        logger.error(
          'Failed to create welcome notification during registration',
          notificationError,
          {
            component: 'SessionController',
            method: 'register',
            userId: user.id,
          },
        );
      }

      const userData = formatUserResponse(user);
      if (!userData) {
        return res.status(500).json({ message: 'Failed to format user data' });
      }

      return res.status(201).json({
        message: 'Identity registered successfully',
        user: userData,
      });
    } catch (error) {
      // The identifier pre-checks above cannot close the race between the check
      // and the insert; the unique indexes do, and this maps each to the same
      // 409 the pre-check would have returned.
      const violated = violatedUniqueIndex(error);
      if (violated === 'users_lower_public_key_key') {
        return res.status(409).json({ message: 'Identity already registered' });
      }
      if (violated === 'users_lower_username_key') {
        return res.status(409).json({ message: 'Username already taken' });
      }
      // One identity key authenticates exactly one account — a guarantee the
      // Mongo array could not make, so it has no `E11000` counterpart above.
      if (violated === 'user_auth_methods_lower_method_public_key_key') {
        return res.status(409).json({ message: 'Identity already registered' });
      }

      logger.error('Registration error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Internal server error';
      logger.error('Registration error details:', { errorMessage });

      res.status(500).json({ message: 'Internal server error' });
    }
  }

  /**
   * Request an authentication challenge
   * The client will sign this challenge to prove ownership of the private key
   */
  static async requestChallenge(req: Request, res: Response) {
    try {
      const { publicKey } = req.body;
      const db = getDb();

      if (!publicKey) {
        return res.status(400).json({ message: 'Public key is required' });
      }

      if (!SignatureService.isValidPublicKey(publicKey)) {
        return res.status(400).json({ message: 'Invalid public key format' });
      }

      // Check if user exists (optional - can allow challenges for unregistered keys)
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(btrim(${users.publicKey})) = lower(btrim(${publicKey}))`)
        .limit(1);
      if (!user) {
        return res.status(404).json({ message: 'User not found. Please register first.' });
      }

      // Generate challenge
      const challenge = SignatureService.generateChallenge();
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

      // Store challenge in database. `purpose` defaults to `'signin'`, which is
      // the only purpose `verifyChallenge` will spend.
      await db.insert(authChallenges).values({
        publicKey,
        challenge,
        expiresAt,
        used: false,
      });

      return res.json({
        challenge,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      logger.error('Request challenge error:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  /**
   * Verify a signed challenge and create a session
   * This is the main authentication endpoint
   */
  static async verifyChallenge(req: Request, res: Response) {
    try {
      const { publicKey, challenge, signature, timestamp, deviceName, deviceFingerprint } =
        req.body;
      const db = getDb();

      if (!publicKey || !challenge || !signature || !timestamp) {
        return res.status(400).json({
          message: 'Public key, challenge, signature, and timestamp are required',
        });
      }

      // Find and validate the challenge. Scoped to signin-purpose challenges so
      // a `rotate_key` challenge cannot be spent to mint a session; `purpose` is
      // NOT NULL DEFAULT 'signin' here, so the Mongo-era `{ $in: ['signin',
      // null] }` legacy branch does not travel. `expires_at > now()` is filtered
      // HERE rather than left to the `db/expiry.ts` sweep — the sweep lags one
      // interval, and a challenge spendable past its deadline is a live
      // credential.
      const [authChallenge] = await db
        .select({ id: authChallenges.id })
        .from(authChallenges)
        .where(
          and(
            eq(authChallenges.publicKey, publicKey),
            eq(authChallenges.challenge, challenge),
            eq(authChallenges.used, false),
            eq(authChallenges.purpose, 'signin'),
            gt(authChallenges.expiresAt, new Date()),
          ),
        )
        .limit(1);

      if (!authChallenge) {
        return res.status(401).json({
          message: 'Invalid or expired challenge. Please request a new one.',
        });
      }

      // Verify the cryptographic signature
      const isValid = SignatureService.verifyChallengeResponse(
        publicKey,
        challenge,
        signature,
        timestamp,
      );

      if (!isValid) {
        return res.status(401).json({ message: 'Invalid signature' });
      }

      // Atomically burn the challenge. `used = false` is part of the FILTER, so
      // two concurrent verifications of one challenge cannot both mint a
      // session — the loser updates no row. Mongo matched on `_id` alone, which
      // made the "prevents race conditions" comment above it aspirational; the
      // sibling key-signed approval path (`authSession.service.ts`) already
      // guards this way, and single-use is the whole point of a challenge.
      const burned = await db
        .update(authChallenges)
        .set({ used: true })
        .where(and(eq(authChallenges.id, authChallenge.id), eq(authChallenges.used, false)))
        .returning({ id: authChallenges.id });
      if (burned.length === 0) {
        return res.status(401).json({
          message: 'Invalid or expired challenge. Please request a new one.',
        });
      }

      // Find user by public key
      const [user] = await db
        .select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE))
        .from(users)
        .where(sql`lower(btrim(${users.publicKey})) = lower(btrim(${publicKey}))`)
        .limit(1);
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Create session
      const session = await sessionService.createSession(
        user.id,
        req,
        sessionCreateOptionsFromBody({ deviceName, deviceFingerprint }),
      );
      const sessionAfterCreate = Date.now();

      // Log security event for sign-in only if this is a new session
      // More reliable detection: check if session was created during this request
      // New sessions will have createdAt very close to current time
      // Reused sessions will have createdAt much older
      const sessionCreatedAt = new Date(session.createdAt).getTime();
      const sessionAge = sessionAfterCreate - sessionCreatedAt;
      const isNewSession = sessionAge < 10000; // If session was created within last 10 seconds, it's new

      if (isNewSession) {
        try {
          await securityActivityService.logSignIn(user.id, req, session.deviceId, {
            // `|| undefined` because the columns are nullable and the
            // metadata field is `string | undefined`, never `null`.
            deviceName: deviceName || session.deviceName || undefined,
            deviceType: session.deviceType,
            platform: session.platform,
          });
        } catch (error) {
          // Don't fail the sign-in if logging fails
          logger.error(
            'Failed to log security event for sign-in',
            error instanceof Error ? error : new Error(String(error)),
            {
              component: 'SessionController',
              method: 'verifyChallenge',
              userId: user.id,
            },
          );
        }
      }

      // Emit session update for real-time updates
      emitSessionUpdate(user.id, {
        type: 'session_created',
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      });

      const userData = formatUserResponse(user);
      if (!userData) {
        return res.status(500).json({ message: 'Failed to format user data' });
      }

      const response: SessionAuthResponse & { deviceSecret?: string } = {
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        expiresAt: session.expiresAt.toISOString(),
        accessToken: session.accessToken,
        user: {
          id: userData.id,
          username: userData.username,
          avatar: userData.avatar,
        },
      };

      // Register into the device set (add-only) + broadcast, and mint the
      // deviceSecret the client persists first-party. Best-effort.
      const verifyDeviceExtras = await finalizeDeviceLogin({
        session,
        userId: user.id,
      });
      if (verifyDeviceExtras.deviceSecret) {
        response.deviceSecret = verifyDeviceExtras.deviceSecret;
      }
      const boundToken = await sessionService.getAccessToken(session.sessionId);
      if (!boundToken) {
        return res.status(500).json({ message: 'Failed to mint the bound access token' });
      }
      response.accessToken = boundToken.accessToken;
      response.expiresAt = boundToken.expiresAt.toISOString();

      res.json(response);
    } catch (error) {
      logger.error('Verify challenge error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Get user data by session ID. Requires bearer auth (see route mount) and
  // verifies the authenticated user owns the requested session — otherwise
  // returns 404 (do NOT use 403 here, that would leak session existence
  // across user boundaries). Fixes C1 / H3.
  static async getUserBySession(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const authenticatedUserId = getAuthenticatedUserId(req);

      if (!sessionId) {
        return res.status(400).json({ message: 'Session ID is required' });
      }
      if (!authenticatedUserId) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      // Use session service for optimized lookup with caching
      const result = await sessionService.validateSessionById(sessionId, true);

      if (!result?.session || !result.user) {
        return res.status(404).json({ message: 'Session not found' });
      }

      const sessionOwnerId = result.session.userId?.toString();
      if (sessionOwnerId !== authenticatedUserId) {
        // Treat cross-user lookups as "not found" so callers can't probe.
        return res.status(404).json({ message: 'Session not found' });
      }

      const userData = formatUserResponse(result.user);
      if (!userData) {
        return res.status(500).json({ message: 'Failed to format user data' });
      }

      res.json(userData);
    } catch (error) {
      logger.error('Get user by session error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Get all sessions for a user. Requires bearer auth and verifies the
  // authenticated user owns the referenced session — otherwise an attacker
  // with a stolen sessionId could enumerate every active session for the
  // owner (C1 / H3).
  static async getUserSessions(req: AuthRequest, res: Response) {
    try {
      const { sessionId } = req.params;
      const authenticatedUserId = getAuthenticatedUserId(req);

      if (!sessionId) {
        return res.status(400).json({ message: 'Session ID is required' });
      }
      if (!authenticatedUserId) {
        return res.status(401).json({ message: 'Authentication required' });
      }

      // Find current session to get user ID
      const currentSessionResult = await sessionService.validateSessionById(sessionId, false);

      if (!currentSessionResult?.session) {
        return res.status(404).json({ message: 'Session not found' });
      }

      const sessionOwnerId = currentSessionResult.session.userId?.toString();
      if (sessionOwnerId !== authenticatedUserId) {
        return res.status(404).json({ message: 'Session not found' });
      }

      // Get all active sessions for this user using service
      const sessions = await sessionService.getUserActiveSessions(sessionOwnerId);

      // Transform sessions for client
      const clientSessions: ClientSession[] = sessions.map((session) => ({
        sessionId: session.sessionId,
        deviceId: session.deviceId,
        deviceName: session.deviceName ?? undefined,
        isActive: session.isActive,
        userId: session.userId.toString(),
      }));

      res.json(clientSessions);
    } catch (error) {
      logger.error('Get user sessions error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Logout from a specific session
  static async logoutSession(req: AuthRequest, res: Response) {
    try {
      // An app-bound OAuth bearer may revoke only itself (ADR 0029). The
      // middleware already verified this identity against its session row.
      if (
        req.oxyToken?.applicationId &&
        (req.sessionId !== req.oxyToken.sessionId ||
          req.params.sessionId !== req.oxyToken.sessionId ||
          (req.params.targetSessionId && req.params.targetSessionId !== req.oxyToken.sessionId))
      ) {
        return res.status(403).json({
          code: 'third_party_session_access_denied',
          message: 'An application session may sign out only itself',
        });
      }
      const acting = await resolveActingSession(req, res);
      if (!acting) return;

      // The acting session signs itself out, or — with `:targetSessionId` — one
      // of its owner's sessions, or a session on its own device (the device's
      // holder can already sign out every account there via
      // `/session/device/logout-all`). Any other target is "not found", so the
      // route cannot probe sessions it has no claim to.
      const targetSessionId = req.params.targetSessionId || acting.sessionId;
      let target: { userId: string; deviceId: string } = acting;
      if (targetSessionId !== acting.sessionId) {
        const targetSession = (await sessionService.validateSessionById(targetSessionId, false))
          ?.session;
        const reachable =
          targetSession &&
          (targetSession.userId?.toString() === acting.userId ||
            targetSession.deviceId === acting.deviceId);
        if (!targetSession || !reachable) {
          return res.status(404).json({ message: 'Session not found' });
        }
        target = { userId: targetSession.userId.toString(), deviceId: targetSession.deviceId };
      }

      const success = await sessionService.deactivateSession(targetSessionId);
      if (!success) {
        return res.status(404).json({ message: 'Session not found' });
      }

      // Emit socket notification to notify remote devices
      emitSessionUpdate(target.userId, {
        type: 'session_removed',
        sessionId: targetSessionId,
        deviceId: target.deviceId,
      });

      // Log security event for sign-out
      try {
        await securityActivityService.logSignOut(target.userId, req, target.deviceId);
      } catch (error) {
        // Don't fail the logout if logging fails
        logger.error('Failed to log security event for sign-out:', error);
      }

      logger.info(`Logged out session: ${targetSessionId.substring(0, 8)}...`);
      res.json({ success: true, message: 'Session logged out successfully' });
    } catch (error) {
      logger.error('Logout session error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Logout all sessions for current user
  static async logoutAllSessions(req: AuthRequest, res: Response) {
    try {
      if (req.oxyToken?.applicationId) {
        return res.status(403).json({
          code: 'third_party_session_access_denied',
          message: 'An application session cannot revoke other sessions',
        });
      }
      const acting = await resolveActingSession(req, res);
      if (!acting) return;
      const { sessionId, userId } = acting;

      // Get list of sessionIds that will be deactivated before deactivating.
      // `is_active` + `expires_at > now()` stay in the predicate: the broadcast
      // must name exactly the sessions the deactivation below touches.
      const now = new Date();
      const sessionsToDeactivate = await getDb()
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            eq(sessions.isActive, true),
            ne(sessions.sessionId, sessionId),
            gt(sessions.expiresAt, now),
          ),
        );

      const sessionIds = sessionsToDeactivate.map((s) => s.sessionId);

      // Deactivate all sessions for this user except the current one
      const count = await sessionService.deactivateAllUserSessions(userId, sessionId);

      // Emit socket notification with list of removed sessionIds
      if (sessionIds.length > 0) {
        emitSessionUpdate(userId, {
          type: 'sessions_removed',
          sessionIds: sessionIds,
        });
      }

      logger.info(`Logged out ${count} sessions for user ${userId}`);

      res.json({
        success: true,
        message: `Logged out ${count} sessions`,
        sessionsLoggedOut: count,
      });
    } catch (error) {
      logger.error('Logout all sessions error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Validate session with user data included
  static async validateSession(req: Request, res: Response) {
    try {
      // Try to get session ID from header first, then fallback to URL parameter
      const sessionId = req.header('x-session-id') || req.params.sessionId;

      if (!sessionId) {
        return res.status(400).json({
          message: 'Session ID is required',
          hint: 'Provide sessionId in URL parameter or x-session-id header',
        });
      }

      // Remote validation is an authority decision: read the live row and membership.
      const result = await sessionService.validateSessionById(sessionId, true, { useCache: false });

      if (!result || !result.session || !result.user) {
        return res.status(401).json({
          message: 'Invalid or expired session',
          sessionId: sessionId.substring(0, 8) + '...',
        });
      }

      const userData = formatUserResponse(result.user);
      if (!userData) {
        return res.status(500).json({ message: 'Failed to format user data' });
      }

      res.json({
        valid: true,
        expiresAt: result.session.expiresAt.toISOString(),
        lastActivity: result.session.lastActiveAt.toISOString(),
        deviceId: result.session.deviceId,
        user: userData,
        actor: sessionActorChain(result.session),
      });
    } catch (error) {
      logger.error('Validate session error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Validate session from header with device fingerprint validation
  static async validateSessionFromHeader(req: Request, res: Response) {
    try {
      const sessionId = req.params.sessionId;

      if (!sessionId) {
        return res.status(400).json({
          message: 'Session ID is required',
          hint: 'Provide sessionId as URL parameter',
        });
      }

      // Remote validation is an authority decision: read the live row and membership.
      const result = await sessionService.validateSessionById(sessionId, true, { useCache: false });

      if (!result || !result.session || !result.user) {
        return res.status(401).json({
          message: 'Invalid or expired session',
          sessionId: sessionId.substring(0, 8) + '...',
        });
      }

      // Optional device fingerprint validation. Advisory only — it logs and
      // never gates, so a plain comparison is the whole of it.
      const deviceFingerprint = req.header('x-device-fingerprint');
      if (deviceFingerprint && result.session.deviceFingerprint) {
        if (deviceFingerprint !== result.session.deviceFingerprint) {
          logger.debug(`Device fingerprint mismatch for session ${sessionId.substring(0, 8)}...`);
        }
      }

      const userData = formatUserResponse(result.user);
      if (!userData) {
        return res.status(500).json({ message: 'Failed to format user data' });
      }

      res.json({
        valid: true,
        expiresAt: result.session.expiresAt.toISOString(),
        lastActivity: result.session.lastActiveAt.toISOString(),
        deviceId: result.session.deviceId,
        user: userData,
        sessionId: result.session.sessionId,
        actor: sessionActorChain(result.session),
      });
    } catch (error) {
      logger.error('Validate session from header error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Get device sessions for a specific device
  static async getDeviceSessions(req: AuthRequest, res: Response) {
    try {
      if (req.oxyToken?.applicationId) {
        return res.status(403).json({
          message: 'Third-party sessions cannot access shared device metadata',
          code: 'third_party_device_access_denied',
        });
      }
      const acting = await resolveActingSession(req, res);
      if (!acting) return;

      const deviceSessions = await getDeviceActiveSessions(acting.deviceId, acting.sessionId);
      res.json(deviceSessions);
    } catch (error) {
      logger.error('Get device sessions error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Batch endpoint to get multiple user profiles by session IDs
  static async getUsersBySessions(req: Request, res: Response) {
    try {
      const { sessionIds } = req.body;

      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return res.status(400).json({ message: 'sessionIds array is required' });
      }

      // Deduplicate sessionIds before processing
      const uniqueSessionIds = Array.from(new Set<string>(sessionIds));

      // Limit batch size to prevent abuse
      const MAX_BATCH_SIZE = 20;
      const limitedSessionIds = uniqueSessionIds.slice(0, MAX_BATCH_SIZE);

      // Mongo's `.populate('userId', 'username email avatar name publicKey')`
      // becomes a real join, and the projection becomes named columns:
      // `sessions` carries two live bearer tokens and `users` the
      // contact-discovery hashes, none of which this DTO may see
      // (`db/schema/protectedColumns.ts`).
      const now = new Date();
      const rows = await getDb()
        .select({
          sessionId: sessions.sessionId,
          id: users.id,
          username: users.username,
          email: users.email,
          avatar: users.avatar,
          nameFirst: users.nameFirst,
          nameLast: users.nameLast,
          publicKey: users.publicKey,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(
          and(
            inArray(sessions.sessionId, limitedSessionIds),
            eq(sessions.isActive, true),
            gt(sessions.expiresAt, now),
          ),
        );

      // Transform to user data format
      type FormattedUser = NonNullable<ReturnType<typeof formatUserResponse>>;
      const usersMap = new Map<string, FormattedUser>();

      for (const row of rows) {
        // `formatUserResponse` reads the flat Drizzle row directly (`id` +
        // `nameFirst`/`nameLast`); it is the ONE serializer that owns
        // `name.displayName`, so nothing is recomposed here.
        const userData = formatUserResponse(row);
        if (!userData?.id) continue;

        usersMap.set(row.sessionId, userData);
      }

      // Return array matching input order, with null for missing sessions
      const result = limitedSessionIds.map((sessionId) => ({
        sessionId,
        user: usersMap.get(sessionId) || null,
      }));

      res.json(result);
    } catch (error) {
      logger.error('Get users by sessions batch error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Logout all sessions for a specific device
  static async logoutAllDeviceSessions(req: AuthRequest, res: Response) {
    try {
      if (req.oxyToken?.applicationId) {
        return res.status(403).json({
          code: 'third_party_device_access_denied',
          message: 'An application session cannot sign out a shared device',
        });
      }
      const acting = await resolveActingSession(req, res);
      if (!acting) return;

      // Logout all sessions for this device
      const result = await logoutAllDeviceSessions(acting.deviceId);

      res.json(result);
    } catch (error) {
      logger.error('Logout all device sessions error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Update device name for a session
  static async updateDeviceName(req: AuthRequest, res: Response) {
    try {
      if (req.oxyToken?.applicationId) {
        return res.status(403).json({
          message: 'Third-party sessions cannot access shared device metadata',
          code: 'third_party_device_access_denied',
        });
      }
      const { deviceName } = req.body;
      if (!deviceName) {
        return res.status(400).json({ message: 'Device name is required' });
      }

      const acting = await resolveActingSession(req, res);
      if (!acting) return;
      const { sessionId } = acting;

      // Update device name in database. `updated_at` is maintained by the
      // schema's `$onUpdate`, so it is no longer set by hand.
      await getDb().update(sessions).set({ deviceName }).where(eq(sessions.sessionId, sessionId));

      // Invalidate cache so next lookup gets fresh data
      sessionCache.invalidate(sessionId);

      res.json({
        success: true,
        message: 'Device name updated successfully',
        deviceName: deviceName,
      });
    } catch (error) {
      logger.error('Update device name error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  /**
   * Get user by public key
   * Useful for looking up users without a session
   */
  static async getUserByPublicKey(req: Request, res: Response) {
    try {
      const { publicKey } = req.params;

      if (!publicKey) {
        return res.status(400).json({ message: 'Public key is required' });
      }

      if (!SignatureService.isValidPublicKey(publicKey)) {
        return res.status(400).json({ message: 'Invalid public key format' });
      }

      // The public-profile projection (`PUBLIC_USER_PROFILE_SELECT`) becomes an
      // explicit column list: inclusion-only for the same reason it was there —
      // every unnamed column (`phone`, the contact hashes, the private half of
      // the privacy settings) is dropped by the query itself rather than by a
      // serializer remembering to.
      const [user] = await getDb()
        .select({
          id: users.id,
          username: users.username,
          nameFirst: users.nameFirst,
          nameLast: users.nameLast,
          avatar: users.avatar,
          color: users.color,
          bio: users.bio,
          description: users.description,
          links: users.links,
          verified: users.verified,
          type: users.type,
          // Gate-only: read to decide discoverability, never serialized.
          accountStatus: users.accountStatus,
          reputationTier: users.reputationTier,
          // The one PUBLIC, derived consent leaf the projection exposed.
          privacyFediverseSharing: users.privacyFediverseSharing,
          privacyIsPrivateAccount: users.privacyIsPrivateAccount,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(sql`lower(btrim(${users.publicKey})) = lower(btrim(${publicKey}))`)
        .limit(1);

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // The `linksMetadata` array is a child table now, and the projection
      // named it, so the preview list is joined back in its author-chosen order.
      const previews = await getDb()
        .select({
          url: userLinkMetadata.url,
          title: userLinkMetadata.title,
          description: userLinkMetadata.description,
          image: userLinkMetadata.image,
        })
        .from(userLinkMetadata)
        .where(eq(userLinkMetadata.userId, user.id))
        .orderBy(asc(userLinkMetadata.position));
      // A preview with no image OMITS the key, as the Mongo subdocument did —
      // `null` would be a new value on the wire.
      const linksMetadata = previews.map(({ image, ...preview }) => ({
        ...preview,
        ...(image === null ? {} : { image }),
      }));

      const userData = userService.formatUserResponse({
        ...user,
        linksMetadata,
        // `UserService.formatUserResponse` reads `privacySettings.fediverseSharing`
        // to derive the PUBLIC sharing flag, and treats anything but an explicit
        // `false` as opted in — so handing it only the flat column would report
        // every opted-out account as sharing. The two leaves the projection
        // exposed are re-nested here until that serializer is ported to read the
        // columns directly.
        privacySettings: {
          fediverseSharing: user.privacyFediverseSharing,
          isPrivateAccount: user.privacyIsPrivateAccount,
        },
        // The projection's `federation` leaf is deliberately NOT selected or
        // re-nested: a federated actor is created with no `public_key`
        // (`federation.service.ts:1095`, `:1137`), so it can never be the row
        // this endpoint resolves, and the serializer's `if (userAny.federation)`
        // was already false for every row it can return.
      });
      res.json(userData);
    } catch (error) {
      logger.error('Get user by public key error:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}
