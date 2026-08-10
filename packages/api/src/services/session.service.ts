import { and, desc, asc, eq, gt, gte, ne } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { sessions } from '../db/schema/sessions';
/**
 * The user half of `getSessionWithUser` — the value that becomes `req.user`.
 *
 * `userService.readAccountDocument` is the SAME serializer `GET /users/me/data`
 * and `PUT /users/resolve` return, so the authenticated request's view of an
 * account and the API's own document view of it cannot describe it differently.
 * It reads through `publicColumns(users)`, which is strictly narrower than the
 * `.select('-password')` this replaces: the contact-discovery hashes, the raw
 * phone number and the refresh token no longer ride on `req.user` at all.
 */
import { userService, type AccountDocument } from './user.service';
import { logger } from '../utils/logger';
import sessionCache, { type CachedSession } from '../utils/sessionCache';
import userCache from '../utils/userCache';
import securityActivityService from './securityActivityService';
import {
  extractDeviceInfo,
  generateDeviceFingerprint,
  registerDevice,
  deriveServiceDeviceId,
  DeviceFingerprint
} from '../utils/deviceUtils';
import {
  checkAccessTokenBinding,
  generateSessionTokens,
  validateAccessToken,
  validateRefreshToken,
  type AccessTokenBinding,
  type SessionTokenBindingRow,
} from '../utils/sessionUtils';
import deviceSessionService from './deviceSession.service';
import { broadcastDeviceState } from '../utils/socket';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type {
  SessionValidationResult,
  SessionCreateOptions,
  SessionRefreshResult,
} from '../types/session.types';

const SESSION_EXPIRES_IN = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_ROTATION_GRACE_PERIOD_MS = 30_000; // 30 seconds grace period for concurrent tab refreshes

/**
 * How often a managed-account session (one minted by switching INTO an account,
 * carrying `operatedByUserId`) re-verifies that the operator still holds
 * `account:act_as`, on the per-request VALIDATE path. The REFRESH path always
 * re-checks (bypassing this throttle) so a revoked operator can never refresh
 * indefinitely. 60s caps the per-request membership lookups while keeping
 * revocation latency on the read path bounded.
 */
const MANAGED_SESSION_RECHECK_MS = 60_000;

/**
 * Last time (epoch ms) a managed session's operator membership was re-verified
 * on the validate path, keyed by sessionId. Only managed sessions are tracked;
 * entries are removed when the session is deactivated.
 */
const managedSessionRecheckAt = new Map<string, number>();

/**
 * The columns of a `sessions` row this service reads.
 *
 * Named EXPLICITLY rather than `select()`-ing the table: `access_token`,
 * `refresh_token` and `previous_refresh_token` are registered in
 * `db/schema/protectedColumns.ts`, and a bare `select()` against `sessions`
 * fails the repo-wide gate in `schema/__tests__/protectedColumns.test.ts`. This
 * service is the one place that legitimately needs the token columns — it mints
 * and rotates them — so it opts in by naming them, which is exactly the
 * greppable shape that registry asks for.
 */
const SESSION_COLUMNS = {
  id: sessions.id,
  sessionId: sessions.sessionId,
  userId: sessions.userId,
  deviceId: sessions.deviceId,
  deviceName: sessions.deviceName,
  deviceType: sessions.deviceType,
  platform: sessions.platform,
  browser: sessions.browser,
  os: sessions.os,
  lastActiveAt: sessions.lastActiveAt,
  userAgent: sessions.userAgent,
  deviceFingerprint: sessions.deviceFingerprint,
  accessToken: sessions.accessToken,
  refreshToken: sessions.refreshToken,
  previousRefreshToken: sessions.previousRefreshToken,
  tokenRotatedAt: sessions.tokenRotatedAt,
  operatedByUserId: sessions.operatedByUserId,
  // The access-token v2 binding. Selected on every read because it is what
  // `validateSession` checks the presented token's claims against and what
  // every re-mint reproduces — a session read that omitted it would mint a
  // token asserting less than the row knows.
  applicationId: sessions.applicationId,
  clientId: sessions.clientId,
  scopes: sessions.scopes,
  deviceSessionId: sessions.deviceSessionId,
  deviceContextId: sessions.deviceContextId,
  isActive: sessions.isActive,
  expiresAt: sessions.expiresAt,
  lastRefresh: sessions.lastRefresh,
  createdAt: sessions.createdAt,
  updatedAt: sessions.updatedAt,
} as const;

/**
 * An id column's value, or `undefined` when it holds none.
 *
 * Both columns this reads (`sessions.user_id`, `sessions.operated_by_user_id`)
 * are `text`, so this is now only the empty-string/NULL check. The ObjectId
 * branches are gone with the 24-hex length check that used to sit beside them
 * — a 24-char test would REJECT every uuid v7 id minted after the cutover — and
 * so are the "value may be a populated user document" branches: Mongo replaced
 * `session.userId` with the user doc, and `getSessionWithUser` no longer does
 * (see its closing note), so a document can no longer reach here.
 */
function extractUserId(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > 0 ? value : undefined;
}

/**
 * The access-token v2 binding a live session row describes (issue #937,
 * Phase 6). The ROW is the authority in both directions: this is what a re-mint
 * puts into the claims, and what `validateSession` checks a presented token's
 * claims back against.
 *
 * `principalUserId` is `operated_by_user_id` when the session is delegated and
 * the subject itself otherwise. That single line is the actor/subject
 * separation the whole phase turns on — collapsing it would make a delegated
 * session's token claim the organization authorised itself.
 */
function tokenBindingOf(session: CachedSession): AccessTokenBinding {
  return {
    subjectAccountId: session.userId,
    principalUserId: session.operatedByUserId ?? session.userId,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceSessionId: session.deviceSessionId,
    deviceContextId: session.deviceContextId,
    clientId: session.clientId,
    scopes: session.scopes,
  };
}

/** The same row, in the shape `checkAccessTokenBinding` validates against. */
function bindingRowOf(session: CachedSession): SessionTokenBindingRow {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    operatedByUserId: session.operatedByUserId,
    applicationId: session.applicationId,
    clientId: session.clientId,
    deviceSessionId: session.deviceSessionId,
    deviceContextId: session.deviceContextId,
    scopes: session.scopes,
  };
}

/**
 * Whether a stored access token still describes the binding its row now
 * carries. Read by `getAccessToken`, which is the one seam that hands back a
 * STORED token instead of minting a fresh one — so it is also the only place a
 * token can go stale relative to its row (the binding is written after the
 * mint on the device-login lane, and a v1 token predates the binding
 * entirely). A mismatch means re-mint, never "serve it anyway".
 */
function storedTokenMatchesBinding(session: CachedSession): boolean {
  const validation = validateAccessToken(session.accessToken);
  if (!validation.valid || !validation.payload) return false;
  return checkAccessTokenBinding(validation.payload, bindingRowOf(session)).ok
    && validation.payload.ver === 2;
}

class SessionService {
  /**
   * For a managed-account session (minted by switching INTO an account, carrying
   * `operatedByUserId`), confirm the operator STILL holds `account:act_as` over
   * the account (`userId`). If membership was revoked/downgraded, the session is
   * deactivated and `false` is returned so the caller treats it as invalid —
   * this is what makes a managed-account session REVOCABLE and bounded.
   *
   * Ordinary first-party sessions (no `operatedByUserId`) pass through untouched.
   * On the per-request validate path the check is throttled to
   * `MANAGED_SESSION_RECHECK_MS`; pass `force` (the refresh path) to bypass it so
   * a revoked operator can never refresh indefinitely.
   *
   * `account.service` is imported LAZILY so the session-service module graph does
   * not statically load the Account* models (which breaks suites that mock
   * mongoose wholesale, and would couple every session consumer to them).
   */
  private async ensureManagedSessionAuthorized(
    session: Pick<CachedSession, 'sessionId' | 'userId' | 'operatedByUserId'>,
    opts: { force?: boolean } = {}
  ): Promise<boolean> {
    const operatorId = extractUserId(session.operatedByUserId);
    if (!operatorId) {
      return true; // ordinary session (no operator) — nothing to bind
    }

    const sessionId = session.sessionId;
    if (!opts.force) {
      const last = managedSessionRecheckAt.get(sessionId);
      if (last && Date.now() - last < MANAGED_SESSION_RECHECK_MS) {
        return true; // re-verified recently on the validate path
      }
    }

    // The account this session belongs to. Mongo could hand back a populated
    // user document here (the validate path swapped one in); `sessions.user_id`
    // is a plain `text` foreign key now, so the id is the id.
    const accountId = extractUserId(session.userId);
    if (!accountId) {
      return true;
    }

    try {
      const { accountService } = await import('./account.service.js');
      const role = await accountService.verifyActingAs(operatorId, accountId);
      if (!role) {
        await this.deactivateSession(sessionId);
        managedSessionRecheckAt.delete(sessionId);
        logger.info('[SessionService] Managed-account session revoked — operator lost act_as', {
          sessionId: sessionId.substring(0, 8),
          operatorId,
          accountId,
        });
        return false;
      }
      managedSessionRecheckAt.set(sessionId, Date.now());
      return true;
    } catch (error) {
      // FAIL CLOSED. This used to return `true` — "never hard-fail auth on a
      // transient lookup error" — which made a database fault an ANSWER: for as
      // long as the membership read was broken, every managed-account session on
      // the platform authorized itself, including the ones whose `account:act_as`
      // had just been revoked. That is the whole grant this check exists to be
      // able to withdraw, and it is not a grant that may be extended by an
      // outage. `verifyActingAs` already fails closed on every negative it can
      // establish; an unanswerable question is not weaker evidence than "no
      // membership", it is no evidence at all.
      //
      // The session is NOT deactivated: an unanswered question is not a
      // revocation, and destroying a session on a flaky read would turn a blip
      // into a sign-out the user has to recover from. The recheck timestamp is
      // deliberately not written either, so the very next request re-asks rather
      // than inheriting this failure for the throttle window.
      logger.error('[SessionService] Managed-session act_as re-check failed — failing closed', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'ensureManagedSessionAuthorized',
        sessionId: sessionId.substring(0, 8),
      });
      return false;
    }
  }

  /**
   * Get session by sessionId with caching
   * 
   * Optimized for high-scale usage with in-memory caching to minimize database queries.
   * Cache is automatically managed with TTL and cleanup.
   * 
   * @param sessionId - The session ID to lookup
   * @param useCache - Whether to use cache (default: true)
   * @returns Session object or null if not found or expired
   */
  async getSession(sessionId: string, useCache = true): Promise<CachedSession | null> {
    try {
      // Try cache first
      if (useCache) {
        const cached = sessionCache.get(sessionId);
        if (cached) {
          return cached;
        }
      }

      // Fallback to database. `is_active` + `expires_at > now()` are filtered
      // HERE, exactly as Mongo did — the expiry sweep is housekeeping only, and
      // relying on it would turn its interval into a live-credential window.
      const [session] = await getDb()
        .select(SESSION_COLUMNS)
        .from(sessions)
        .where(
          and(
            eq(sessions.sessionId, sessionId),
            eq(sessions.isActive, true),
            gt(sessions.expiresAt, new Date())
          )
        )
        .limit(1);

      if (!session) {
        return null;
      }

      // Cache the session
      if (useCache) {
        sessionCache.set(sessionId, session);
      }

      return session;
    } catch (error) {
      logger.error('[SessionService] Failed to get session', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'getSession',
      });
      // Return null on error to allow graceful degradation
      // Caller should handle null case appropriately
      return null;
    }
  }

  /**
   * Get session with user populated
   * 
   * Optimized for high-scale usage with caching. When cache hit occurs,
   * still requires a user lookup as user data is not cached with session
   * (by design, to keep cache size manageable and user data fresh).
   * 
   * @param sessionId - The session ID to lookup
   * @param options - Configuration options
   * @param options.useCache - Whether to use cache (default: true)
   * @returns Session and user object, or null if not found
   */
  async getSessionWithUser(
    sessionId: string,
    options: { useCache?: boolean } = {}
  ): Promise<{ session: CachedSession; user: AccountDocument } | null> {
    try {
      const { useCache = true } = options;
      // Mongoose projection strings do not travel to Postgres, and the only
      // caller ever passed the default, so the `select` option is dropped
      // rather than translated. `readAccountDocument` reads through
      // `publicColumns(users)`, which withholds strictly more than
      // `-password` did.

      // Try cache first for session (fast path)
      if (useCache) {
        const cached = sessionCache.get(sessionId);
        if (cached) {
          // Extract userId from cached session (handles various formats)
          const userId = extractUserId(cached.userId);

          if (!userId) {
            sessionCache.invalidate(sessionId);
          } else {
            const cachedUser = userCache.get(userId);
            if (cachedUser) {
              return { session: cached, user: cachedUser };
            }

            const user = await userService.readAccountDocument(userId);
            if (user) {
              userCache.set(userId, user);
              return { session: cached, user };
            }

            sessionCache.invalidate(sessionId);
            return null;
          }
        }
      }

      const [sessionRow] = await getDb()
        .select(SESSION_COLUMNS)
        .from(sessions)
        .where(
          and(
            eq(sessions.sessionId, sessionId),
            eq(sessions.isActive, true),
            gt(sessions.expiresAt, new Date())
          )
        )
        .limit(1);

      if (!sessionRow?.userId) {
        return null;
      }

      if (useCache) {
        sessionCache.set(sessionId, sessionRow);
      }

      const userId = sessionRow.userId;
      let user = userCache.get(userId);

      if (!user) {
        const userDoc = await userService.readAccountDocument(userId);
        if (!userDoc) {
          return null;
        }
        user = userDoc;
        if (useCache) {
          userCache.set(userId, user);
        }
      }

      // Mongo replaced `session.userId` with the populated user document here.
      // That swap does NOT travel: `sessions.user_id` is a `text` foreign key
      // and the user rides beside the session in the returned pair instead, so
      // `session.userId` stays the id it is declared to be.
      return { session: sessionRow, user };
    } catch (error) {
      logger.error('[SessionService] Failed to get session with user', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'getSessionWithUser',
        sessionId,
      });
      // Return null on error for graceful degradation - consistent error handling pattern
      // Caller should handle null case appropriately
      return null;
    }
  }

  /**
   * Validate session by access token
   * 
   * High-performance session validation with caching and token verification.
   * Returns session and user data for use in authentication middleware.
   * 
   * @param accessToken - The JWT access token to validate
   * @returns Validation result with session, user, and payload, or null if invalid
   */
  async validateSession(accessToken: string): Promise<SessionValidationResult | null> {
    try {
      const validationResult = validateAccessToken(accessToken);
      if (!validationResult.valid || !validationResult.payload?.sessionId) {
        return null;
      }

      const sessionId = validationResult.payload.sessionId;
      const result = await this.getSessionWithUser(sessionId, { useCache: true });
      if (!result) {
        return null;
      }

      const { session } = result;

      // A managed-account session is only valid while its operator still holds
      // act_as over the account. Revoked membership → deactivate + reject.
      if (!(await this.ensureManagedSessionAuthorized(session))) {
        return null;
      }

      // Resource-server validation (issue #937, Phase 6). The signature and
      // expiry were proven above; this proves the token still describes THIS
      // session — issuer, audience, `sid`, subject, actor, authorized party,
      // device context and scopes, all against the row. A v1 token asserted
      // none of it and resolves to the row's own binding while the migration
      // window is open.
      const binding = checkAccessTokenBinding(validationResult.payload, bindingRowOf(session));
      if (!binding.ok) {
        logger.warn('[SessionService] Access token rejected by binding check', {
          component: 'SessionService',
          method: 'validateSession',
          sessionId: sessionId.substring(0, 8),
          reason: binding.reason,
        });
        return null;
      }

      if (sessionCache.shouldUpdateLastActive(sessionId)) {
        this.updateLastActivity(sessionId).catch(() => {
          // Silently fail - non-critical operation
        });
      }

      return {
        session,
        user: result.user,
        payload: validationResult.payload,
        token: binding.identity,
      };
    } catch (error) {
      logger.error('[SessionService] Session validation failed', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'validateSession',
      });
      return null;
    }
  }

  /**
   * Update session last activity (non-blocking, batched)
   * 
   * Optimized for high-scale usage - updates are batched and throttled
   * to reduce database load while maintaining accurate last activity tracking.
   */
  async updateLastActivity(sessionId: string): Promise<void> {
    try {
      const now = new Date();

      // `updated_at` is maintained by drizzle's `$onUpdate`, so it is no longer
      // set by hand here (Mongoose needed the explicit `$set`).
      await getDb()
        .update(sessions)
        .set({ lastActiveAt: now })
        .where(and(eq(sessions.sessionId, sessionId), eq(sessions.isActive, true)));

      const cached = sessionCache.get(sessionId);
      if (cached) {
        cached.lastActiveAt = now;
        sessionCache.set(sessionId, cached);
      }
    } catch (error) {
      logger.error('[SessionService] Failed to update last activity', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'updateLastActivity',
        sessionId,
      });
      sessionCache.clearPendingLastActive(sessionId);
    }
  }

  /**
   * Create a new session for a user
   * 
   * Optimized for high-scale usage:
   * - Reuses existing active sessions on the same device to reduce session proliferation
   * - Automatically caches new sessions for fast subsequent lookups
   * - Handles device fingerprinting and registration
   * 
   * @param userId - The user ID to create session for
   * @param req - Express request object for extracting device info
   * @param options - Session creation options (deviceName, deviceFingerprint)
   * @returns The created or reused session
   * @throws Error if session creation fails
   */
  async createSession(
    userId: string,
    req: Request,
    options: SessionCreateOptions = {}
  ): Promise<CachedSession> {
    try {
      const {
        deviceName,
        deviceFingerprint,
        stableDeviceKey,
        deviceId: explicitDeviceId,
        operatedByUserId,
        application,
        deviceContext,
      } = options;
      // For a server-to-server session mint where the request itself carries no
      // stable client identity (UA = 'unknown', egress IP varies per call), the
      // UA/IP-derived deviceId would be random every time and sprawl a new
      // session per exchange. When a `stableDeviceKey` is supplied, derive a
      // deterministic deviceId from (userId, key) and feed it as the provided
      // deviceId so `extractDeviceInfo` skips the UA/IP derivation entirely —
      // one (user, RP) then reuses a single session via the lookup below (no
      // current caller passes `stableDeviceKey`; see `SessionCreateOptions`).
      // An explicit `deviceId` — e.g. the account-switch route threading the
      // operator's own central deviceId onto the minted managed-account
      // session — wins over the derived stable id, letting the caller stamp a
      // unified central device id verbatim. Precedence: deviceId > stableDeviceKey > UA/IP > random.
      // The origin-derived stable id (per (user, RP)). Kept SEPARATELY from the
      // attribution id below so we can still locate a LEGACY per-origin session
      // — one minted before deviceId unification, pinned to this synthetic
      // origin device — and MIGRATE it onto the caller's central device instead
      // of orphaning it (which sprawled one graveyard doc per historical mint).
      const originDeviceId = stableDeviceKey
        ? deriveServiceDeviceId(userId, stableDeviceKey)
        : undefined;
      const stableId = explicitDeviceId ?? originDeviceId;
      // Pass userId so the derived deviceId is scoped per-user — two users
      // behind the same NAT on the same Chrome no longer collide on the same
      // device-id (security review H1).
      let deviceInfo = extractDeviceInfo(req, stableId, deviceName, userId);

      // Mutual exclusion: when a `stableDeviceKey` is supplied, the derived
      // stable deviceId MUST win. Running the `deviceFingerprint` →
      // `registerDevice` override below would call `findExistingDeviceId` and
      // could silently replace the stable id with a fingerprint-matched one,
      // re-introducing the per-exchange session-sprawl this branch exists to
      // prevent. So we skip that path entirely on the stable-key branch. If a
      // future caller passes BOTH, `stableDeviceKey` takes precedence and the
      // `deviceFingerprint` is ignored (with a single dev warning).
      if (stableId) {
        if (deviceFingerprint) {
          logger.warn(
            '[SessionService] deviceFingerprint ignored because stableDeviceKey was provided; stable deviceId wins',
            {
              component: 'SessionService',
              method: 'createSession',
              userId,
            }
          );
        }
      } else if (deviceFingerprint) {
        // Real device-login path (no stableDeviceKey) — unchanged.
        // Pass userId to optimize device lookup - reduces Session collection scan.
        deviceInfo = await registerDevice(deviceInfo, generateDeviceFingerprint(deviceFingerprint), userId);
      }

      // Check if this is a new device for this user (no previous sessions on this device)
      const priorOnDevice = await getDb()
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), eq(sessions.deviceId, deviceInfo.deviceId)))
        .limit(1);
      const isNewDevice = priorOnDevice.length === 0;

      // Reuse an existing active session. Prefer one already attributed to the
      // caller's (central) device; fall back to a LEGACY per-origin session so a
      // pre-unification session HOPS onto the central device (below) instead of
      // orphaning. Once migrated it's found by the primary lookup on subsequent
      // mints — the fallback can't re-sprawl.
      const reusableOn = async (candidateDeviceId: string) => {
        const [row] = await getDb()
          .select({
            id: sessions.id,
            sessionId: sessions.sessionId,
            deviceId: sessions.deviceId,
            deviceName: sessions.deviceName,
          })
          .from(sessions)
          .where(
            and(
              eq(sessions.userId, userId),
              eq(sessions.deviceId, candidateDeviceId),
              eq(sessions.isActive, true),
              gt(sessions.expiresAt, new Date()),
              // A DELEGATED mint may only reuse a session belonging to the SAME
              // operator. One device can legitimately hold two people who both
              // act as the same organization (issue #937, ADR 0001), and without
              // this the second one silently takes over the first one's session
              // row: `operated_by_user_id` is rewritten below, so the audit actor
              // changes underneath a live session and removing either person
              // revokes the other's access.
              //
              // The reverse is deliberately NOT tightened. A mint with no
              // operator reuses whatever is there, including a delegated row,
              // because the alternative — minting a second, operator-less session
              // for a managed account — would create exactly the unbounded org
              // session the `account:act_as` re-check exists to prevent.
              ...(operatedByUserId ? [eq(sessions.operatedByUserId, operatedByUserId)] : []),
              // An APPLICATION-bound mint may only reuse a session already
              // bound to that same application (issue #937, Phase 6). Without
              // this, an OAuth exchange on the user's central device finds the
              // device's ordinary first-party session and hands the client a
              // token for it — the third party would literally receive the
              // shared device session, and renaming the row `"<App> OAuth"` is
              // all that would record it happened.
              //
              // The reverse is deliberately NOT tightened: an unbound mint may
              // still reuse whatever is there. An untrusted client's session
              // lives on its own derived deviceId (see the OAuth exchange), so
              // an unbound mint on the central device never reaches one, and
              // adding the symmetric predicate would only mint spare rows.
              ...(application ? [eq(sessions.applicationId, application.applicationId)] : [])
            )
          )
          .limit(1);
        return row;
      };

      let existingSession = await reusableOn(deviceInfo.deviceId);

      if (!existingSession && originDeviceId && originDeviceId !== deviceInfo.deviceId) {
        existingSession = await reusableOn(originDeviceId);
      }

      if (existingSession) {
        const sessionId = existingSession.sessionId;
        const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN);
        const now = new Date();
        // Tokens are re-minted with the ATTRIBUTION deviceId (the explicit
        // central id when supplied), so the reused access token's `deviceId`
        // claim addresses the caller's real device — the room the client's
        // SessionClient joins and where cross-domain broadcasts land.
        const { accessToken, refreshToken } = generateSessionTokens({
          subjectAccountId: userId,
          principalUserId: operatedByUserId ?? userId,
          sessionId,
          deviceId: deviceInfo.deviceId,
          deviceSessionId: deviceContext?.deviceSessionId ?? null,
          deviceContextId: deviceContext?.deviceContextId ?? null,
          clientId: application?.clientId ?? null,
          scopes: application?.scopes ?? [],
        });

        // Migrate a reused session onto the caller's central device when an
        // explicit deviceId was supplied and the reused session still sits on a
        // different (legacy per-origin) device. Without this the session — and
        // thus the RP's socket room + DeviceSession doc — stays pinned to a
        // stale synthetic device and never receives the real device's
        // cross-domain broadcasts. No explicit deviceId ⇒ no hop (UA/IP/random
        // fallbacks must never move a session).
        const previousDeviceId = existingSession.deviceId;
        const migrateToDeviceId = explicitDeviceId && previousDeviceId !== explicitDeviceId
          ? explicitDeviceId
          : null;

        const [updated] = await getDb()
          .update(sessions)
          .set({
            accessToken,
            refreshToken,
            expiresAt,
            lastRefresh: now,
            ...(migrateToDeviceId ? { deviceId: migrateToDeviceId } : {}),
            lastActiveAt: now,
            deviceName: deviceName || existingSession.deviceName,
            userAgent: deviceInfo.userAgent,
            // Bind the reused session to the CURRENT operator when this is an
            // account switch (keeps the act_as re-check pointed at whoever just
            // switched in); leave it untouched for ordinary sessions.
            ...(operatedByUserId ? { operatedByUserId } : {}),
            // The token minted just above already asserts these, so the row has
            // to agree or the very next request fails its own binding check.
            // Scopes are re-applied on every reuse because a later grant can
            // widen or narrow them.
            ...(application
              ? {
                  applicationId: application.applicationId,
                  clientId: application.clientId,
                  scopes: application.scopes,
                }
              : {}),
            ...(deviceContext
              ? {
                  deviceSessionId: deviceContext.deviceSessionId,
                  deviceContextId: deviceContext.deviceContextId,
                }
              : {}),
          })
          .where(eq(sessions.id, existingSession.id))
          .returning(SESSION_COLUMNS);

        if (updated) {
          sessionCache.set(sessionId, updated);
          if (migrateToDeviceId) {
            logger.info('[SessionService] Migrated reused session onto caller device', {
              component: 'SessionService',
              method: 'createSession',
              userId,
              sessionId: sessionId.substring(0, 8),
              fromDeviceId: previousDeviceId.substring(0, 8),
              toDeviceId: migrateToDeviceId.substring(0, 8),
            });
            // Best-effort: drop this account's entry from the OLD device doc so
            // the graveyard doc stops advertising a live-looking account. The
            // migrated session is preserved (it now lives on the caller's
            // device); detach only deactivates a DIFFERENT stale session the old
            // doc referenced. Never fail the mint on cleanup errors.
            try {
              // The detach advances the OLD device's `revision`, so it has to be
              // announced: without this the clients still listening on that
              // device room hold a revision the server has moved past, with no
              // event that would ever tell them to re-fetch.
              const detached = await deviceSessionService.detachMigratedAccount(
                previousDeviceId,
                userId,
                sessionId
              );
              if (detached) broadcastDeviceState(detached);
            } catch (error) {
              logger.warn('[SessionService] Failed to detach migrated account from old device doc', {
                component: 'SessionService',
                method: 'createSession',
                userId,
                fromDeviceId: previousDeviceId.substring(0, 8),
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return updated;
        }
      }

      const sessionId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + SESSION_EXPIRES_IN);
      const now = new Date();
      const { accessToken, refreshToken } = generateSessionTokens({
        subjectAccountId: userId,
        principalUserId: operatedByUserId ?? userId,
        sessionId,
        deviceId: deviceInfo.deviceId,
        deviceSessionId: deviceContext?.deviceSessionId ?? null,
        deviceContextId: deviceContext?.deviceContextId ?? null,
        clientId: application?.clientId ?? null,
        scopes: application?.scopes ?? [],
      });

      // `deviceInfo` was a nested subdocument in Mongo; the eight fields are
      // real columns now (see the table in `db/schema/sessions.ts`).
      const [session] = await getDb()
        .insert(sessions)
        .values({
          sessionId,
          userId,
          deviceId: deviceInfo.deviceId,
          deviceName: deviceInfo.deviceName,
          deviceType: deviceInfo.deviceType,
          platform: deviceInfo.platform,
          browser: deviceInfo.browser,
          os: deviceInfo.os,
          userAgent: deviceInfo.userAgent,
          deviceFingerprint: deviceInfo.fingerprint,
          lastActiveAt: now,
          accessToken,
          refreshToken,
          // NULL, not a placeholder: NULL here means "not a delegated session",
          // and that is what the `account:act_as` re-check keys off.
          operatedByUserId: operatedByUserId || null,
          // NULL likewise means "not one application's session" and "no device
          // context yet" — both first-class states, not missing data.
          applicationId: application?.applicationId ?? null,
          clientId: application?.clientId ?? null,
          scopes: application?.scopes ?? [],
          deviceSessionId: deviceContext?.deviceSessionId ?? null,
          deviceContextId: deviceContext?.deviceContextId ?? null,
          isActive: true,
          expiresAt,
          lastRefresh: now,
        })
        .returning(SESSION_COLUMNS);

      sessionCache.set(sessionId, session);

      // Log security event for new device (only if this is the first session on this device)
      if (isNewDevice) {
        try {
          await securityActivityService.logDeviceAdded(
            userId,
            deviceInfo.deviceId,
            deviceInfo.deviceName || 'Unknown Device',
            req
          );
        } catch (error) {
          // Don't fail session creation if logging fails
          logger.error('Failed to log security event for device added:', error);
        }
      }

      return session;
    } catch (error) {
      logger.error('[SessionService] Failed to create session', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'createSession',
        userId,
      });
      throw error;
    }
  }

  /**
   * Refresh session tokens
   * 
   * Security-optimized: Always bypasses cache to ensure fresh token validation.
   * Invalidates old cache entry and caches new tokens after successful refresh.
   * 
   * @param refreshToken - The refresh token to validate and use for token refresh
   * @returns New access and refresh tokens with session, or null if refresh fails
   */
  async refreshTokens(refreshToken: string): Promise<SessionRefreshResult | null> {
    try {
      const validationResult = validateRefreshToken(refreshToken);
      if (!validationResult.valid || !validationResult.payload?.sessionId) {
        return null;
      }

      const payload = validationResult.payload;
      const sessionId = payload.sessionId;

      // First, try matching the current refresh token (fast path)
      const [session] = await getDb()
        .select(SESSION_COLUMNS)
        .from(sessions)
        .where(
          and(
            eq(sessions.sessionId, sessionId),
            eq(sessions.refreshToken, refreshToken),
            eq(sessions.isActive, true),
            gt(sessions.expiresAt, new Date())
          )
        )
        .limit(1);

      // If no match on current token, check if this is a recently-rotated token (grace period).
      // This handles the multi-tab race condition: Tab A rotates the token, Tab B still holds
      // the old token. If within the grace period, return the already-rotated tokens.
      if (!session) {
        const now = new Date();
        const graceWindowStart = new Date(now.getTime() - TOKEN_ROTATION_GRACE_PERIOD_MS);

        // Serves the partial index on (previous_refresh_token, token_rotated_at).
        const [graceSession] = await getDb()
          .select(SESSION_COLUMNS)
          .from(sessions)
          .where(
            and(
              eq(sessions.sessionId, sessionId),
              eq(sessions.previousRefreshToken, refreshToken),
              gte(sessions.tokenRotatedAt, graceWindowStart),
              eq(sessions.isActive, true),
              gt(sessions.expiresAt, now)
            )
          )
          .limit(1);

        if (graceSession) {
          // A managed-account session must re-prove operator act_as on EVERY
          // refresh — even the grace path — so a revoked operator can never
          // ride a refresh. `force` bypasses the validate-path throttle.
          if (!(await this.ensureManagedSessionAuthorized(graceSession, { force: true }))) {
            return null;
          }

          // Another tab already rotated. Return the current (already-rotated) tokens
          // without generating new ones, making this idempotent within the grace window.
          logger.info('[SessionService] Refresh token grace period used', {
            sessionId: sessionId.substring(0, 8),
          });

          sessionCache.invalidate(sessionId);
          sessionCache.set(sessionId, graceSession);

          return {
            accessToken: graceSession.accessToken,
            refreshToken: graceSession.refreshToken,
            session: graceSession
          };
        }

        // No grace period match either -- token is truly invalid
        return null;
      }

      // A managed-account session must re-prove operator act_as on every refresh
      // (revoked membership → kill the session, never refresh independently).
      if (!(await this.ensureManagedSessionAuthorized(session, { force: true }))) {
        return null;
      }

      // Standard rotation: generate new tokens and store the old one for grace period
      const now = new Date();
      // The rotation re-mints from the ROW's binding, not from the presented
      // token's claims: a v1 refresh token carries none of them, and this is
      // precisely how a session in the migration window graduates to v2.
      const { accessToken: newAccessToken, refreshToken: newRefreshToken } = generateSessionTokens({
        ...tokenBindingOf(session),
        deviceId: payload.deviceId || session.deviceId,
      });

      // Mongo mutated the document field by field and called `.save()`. Here it
      // is ONE conditional update, and the condition is what makes the rotation
      // single-use: it still requires the presented `refresh_token` to be the
      // current one, so two tabs racing the same token cannot both rotate — the
      // loser matches nothing and falls to the grace path on its next attempt.
      const [rotated] = await getDb()
        .update(sessions)
        .set({
          previousRefreshToken: session.refreshToken,
          tokenRotatedAt: now,
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          lastRefresh: now,
          lastActiveAt: now,
          // Sliding (idle) session window: a successful rotation is a USE of the
          // session, so push the absolute expiry forward. In the zero-cookie
          // device-first model the durable credential is the never-expiring
          // deviceSecret; `expiresAt` must therefore be an IDLE timeout (a
          // session dies only after SESSION_EXPIRES_IN of NO use), not a hard
          // absolute cap measured from the last interactive sign-in. Renewed
          // here alongside the token rotation so it is a single write.
          expiresAt: new Date(now.getTime() + SESSION_EXPIRES_IN),
        })
        .where(
          and(eq(sessions.id, session.id), eq(sessions.refreshToken, session.refreshToken))
        )
        .returning(SESSION_COLUMNS);

      if (!rotated) {
        // A concurrent rotation won. Never hand back a token pair this call did
        // not actually persist.
        return null;
      }

      sessionCache.invalidate(sessionId);
      sessionCache.set(sessionId, rotated);

      return {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        session: rotated
      };
    } catch (error) {
      logger.error('[SessionService] Failed to refresh tokens', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'refreshTokens',
      });
      return null;
    }
  }

  /**
   * Deactivate a session
   * 
   * Consistent error handling: Returns false on error (non-throwing pattern)
   * for operations that should gracefully degrade.
   * 
   * @param sessionId - The session ID to deactivate
   * @returns true if session was deactivated, false otherwise
   */
  async deactivateSession(sessionId: string): Promise<boolean> {
    try {
      // `deactivate` never DELETES — only the expiry sweep removes a row, which
      // is what keeps every `session_id` reference from another table
      // lifecycle-independent.
      const deactivated = await getDb()
        .update(sessions)
        .set({ isActive: false })
        .where(and(eq(sessions.sessionId, sessionId), eq(sessions.isActive, true)))
        .returning({ id: sessions.id });

      // Invalidate cache
      sessionCache.invalidate(sessionId);
      managedSessionRecheckAt.delete(sessionId);

      logger.info('[SessionService] Deactivated session', { sessionId: sessionId.substring(0, 8) });
      return deactivated.length > 0;
    } catch (error) {
      logger.error('[SessionService] Failed to deactivate session', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'deactivateSession',
        sessionId,
      });
      // Return false on error for graceful degradation - consistent with other non-critical operations
      return false;
    }
  }

  /**
   * Deactivate all sessions for a user
   * 
   * Consistent error handling: Returns 0 on error (non-throwing pattern)
   * for operations that should gracefully degrade.
   * 
   * @param userId - The user ID whose sessions should be deactivated
   * @param excludeSessionId - Optional session ID to exclude from deactivation
   * @returns Number of sessions deactivated (0 on error)
   */
  async deactivateAllUserSessions(userId: string, excludeSessionId?: string): Promise<number> {
    try {
      const deactivated = await getDb()
        .update(sessions)
        .set({ isActive: false })
        .where(
          and(
            eq(sessions.userId, userId),
            eq(sessions.isActive, true),
            ...(excludeSessionId ? [ne(sessions.sessionId, excludeSessionId)] : [])
          )
        )
        .returning({ id: sessions.id });

      // Invalidate all cached sessions for this user
      sessionCache.invalidateUserSessions(userId);

      logger.info('[SessionService] Deactivated sessions for user', { count: deactivated.length, userId });
      return deactivated.length;
    } catch (error) {
      logger.error('[SessionService] Failed to deactivate all user sessions', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'deactivateAllUserSessions',
        userId,
      });
      // Return 0 on error for graceful degradation - consistent error handling pattern
      return 0;
    }
  }

  /**
   * Get all active sessions for a user
   * 
   * Consistent error handling: Returns empty array on error (non-throwing pattern)
   * for operations that should gracefully degrade.
   * 
   * @param userId - The user ID to get sessions for
   * @returns Array of active sessions (empty array on error)
   */
  async getUserActiveSessions(userId: string): Promise<CachedSession[]> {
    try {
      // Serves the (user_id, is_active, expires_at) index.
      return await getDb()
        .select(SESSION_COLUMNS)
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            eq(sessions.isActive, true),
            gt(sessions.expiresAt, new Date())
          )
        )
        .orderBy(
          desc(sessions.lastActiveAt), // Most recent first
          asc(sessions.sessionId) // Secondary sort for stability
        );
    } catch (error) {
      logger.error('[SessionService] Failed to get user active sessions', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'getUserActiveSessions',
        userId,
      });
      // Return empty array on error for graceful degradation - consistent error handling pattern
      return [];
    }
  }

  /**
   * Validate session and get user by sessionId (for direct sessionId lookups)
   * 
   * Consistent error handling: Returns null on error (non-throwing pattern)
   * for operations that should gracefully degrade.
   * 
   * @param sessionId - The session ID to validate
   * @param populateUser - Whether to populate user data (default: true)
   * @returns Session and optional user, or null if not found or error
   */
  async validateSessionById(
    sessionId: string, 
    populateUser = true
  ): Promise<{ session: CachedSession; user?: AccountDocument } | null> {
    try {
      if (populateUser) {
        const result = await this.getSessionWithUser(sessionId, { useCache: true });
        if (result && !(await this.ensureManagedSessionAuthorized(result.session))) {
          return null;
        }
        return result;
      }

      const session = await this.getSession(sessionId, true);
      if (!session) {
        return null;
      }

      // Bind managed-account sessions to the operator's act_as membership here too.
      if (!(await this.ensureManagedSessionAuthorized(session))) {
        return null;
      }

      return { session };
    } catch (error) {
      logger.error('[SessionService] Failed to validate session by ID', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'validateSessionById',
        sessionId,
      });
      // Return null on error for graceful degradation - consistent error handling pattern
      return null;
    }
  }

  /**
   * Get access token by session ID (with auto-refresh if expired)
   * 
   * Consistent error handling: Returns null on error (non-throwing pattern)
   * for operations that should gracefully degrade.
   * 
   * @param sessionId - The session ID to get access token for
   * @returns Access token and expiration date, or null if not found or error
   */
  async getAccessToken(sessionId: string): Promise<{ accessToken: string; expiresAt: Date } | null> {
    try {
      const session = await this.getSession(sessionId, true);
      if (!session) {
        return null;
      }

      // The stored token no longer describes its row — a v1 token minted before
      // this session was bound, or one minted before `bindSessionToContext`
      // wrote the device context on the login lane. Rotating is what upgrades
      // it; handing it back would keep the session on v1 forever, since this
      // branch is the one an unexpired session takes on every mint.
      if (!storedTokenMatchesBinding(session)) {
        const rebound = await this.refreshTokens(session.refreshToken);
        if (!rebound) {
          return null;
        }
        return {
          accessToken: rebound.accessToken,
          expiresAt: rebound.session.expiresAt,
        };
      }

      // Check if access token is expired
      try {
        const decoded = jwt.verify(session.accessToken, process.env.ACCESS_TOKEN_SECRET!) as jwt.JwtPayload;
        const currentTime = Math.floor(Date.now() / 1000);

        if (decoded.exp && decoded.exp < currentTime) {
          // Token expired, refresh it
          const refreshResult = await this.refreshTokens(session.refreshToken);
          if (!refreshResult) {
            return null;
          }
          
          return {
            accessToken: refreshResult.accessToken,
            expiresAt: refreshResult.session.expiresAt
          };
        }
      } catch (tokenError) {
        // Token invalid, try to refresh
        const refreshResult = await this.refreshTokens(session.refreshToken);
        if (!refreshResult) {
          return null;
        }
        
        return {
          accessToken: refreshResult.accessToken,
          expiresAt: refreshResult.session.expiresAt
        };
      }

      // Sliding (idle) session window — mint-path chokepoint.
      //
      // Reaching here means the stored access token is still valid, so we hand
      // it back WITHOUT rotating. This is the ONE seam where a session is
      // successfully used to issue a token without going through
      // `refreshTokens` (both getAccessToken's expired/invalid branches above
      // delegate to it, and it slides the window itself). Sliding exactly here
      // — and nowhere higher up the mint path (resolveActiveToken / the route
      // handler) — means every successful mint advances the window EXACTLY once
      // with no double-write: the no-rotation reads slide here, the rotations
      // slide in refreshTokens. A truly idle session (no mint/refresh for
      // SESSION_EXPIRES_IN) is never renewed and still expires via the TTL index.
      //
      // Best-effort: a transient failure to persist the slide must NOT break an
      // otherwise-valid mint — fall through and return the still-valid token.
      try {
        const slidExpiresAt = new Date(Date.now() + SESSION_EXPIRES_IN);
        await getDb()
          .update(sessions)
          .set({ expiresAt: slidExpiresAt })
          .where(and(eq(sessions.sessionId, sessionId), eq(sessions.isActive, true)));
        session.expiresAt = slidExpiresAt;
        sessionCache.set(sessionId, session);
      } catch (slideError) {
        logger.warn('[SessionService] Failed to slide session expiry on token mint', {
          component: 'SessionService',
          method: 'getAccessToken',
          sessionId,
          error: slideError instanceof Error ? slideError.message : String(slideError),
        });
      }

      return {
        accessToken: session.accessToken,
        expiresAt: session.expiresAt
      };
    } catch (error) {
      logger.error('[SessionService] Failed to get access token', error instanceof Error ? error : new Error(String(error)), {
        component: 'SessionService',
        method: 'getAccessToken',
        sessionId,
      });
      // Return null on error for graceful degradation - consistent error handling pattern
      return null;
    }
  }
}

// Export singleton instance
const sessionService = new SessionService();
export default sessionService;

