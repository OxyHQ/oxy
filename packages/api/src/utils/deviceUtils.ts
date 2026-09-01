import crypto from 'crypto';
import type { Request } from 'express';
import { and, asc, desc, eq, gt, ne } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { sessions } from '../db/schema/sessions';
import { users } from '../db/schema/users';
import { logger } from './logger';
import { formatUserResponse } from './userTransform';
import sessionCache from './sessionCache';

export interface DeviceFingerprint {
  userAgent: string;
  platform: string;
  language?: string;
  timezone?: string;
  screen?: {
    width: number;
    height: number;
    colorDepth: number;
  };
}

export type DeviceFingerprintInput = DeviceFingerprint | string;

const CLIENT_FINGERPRINT_HEX_RE = /^[a-f0-9]{64}$/i;

export interface DeviceInfo {
  deviceId: string;
  deviceName?: string;
  deviceType: string;
  platform: string;
  browser?: string;
  os?: string;
  userAgent?: string;
  fingerprint?: string;
  /**
   * How `deviceId` was sourced. Diagnostic only — never persisted on the
   * Session document. Useful when debugging multi-account device grouping.
   */
  deviceIdSource?: 'provided' | 'fingerprint-derived' | 'random';
}

const PRE_AUTH_USER_SCOPE = 'pre-auth';

/**
 * The bucket both User-Agent parsers fall back to when nothing matches. Callers
 * that must not display a guess (see {@link deriveCoarseClientLabel}) compare
 * against this instead of the bare string.
 */
const UNKNOWN_USER_AGENT_BUCKET = 'Unknown';

/**
 * Resolve the server-side device-id salt at call time.
 *
 * Read at call time (not module load) so tests and runtime config reloads
 * pick up `process.env.DEVICE_ID_SALT` changes without re-importing. The
 * env layer (`validateRequiredEnvVars`) is responsible for enforcing that
 * a salt is set in production and meets the minimum length; this function
 * MUST refuse to derive an id without a salt rather than fall back to an
 * empty string (which would silently weaken the hash to the legacy
 * pre-salt form across two users behind the same NAT).
 */
function getDeviceIdSalt(): string | null {
  const salt = process.env.DEVICE_ID_SALT;
  if (!salt || salt.length === 0) {
    return null;
  }
  return salt;
}

/**
 * Derive a stable, non-PII deviceId from a request's User-Agent +
 * Accept-Language, scoped by a server-side salt and (optionally) the
 * authenticated `userId`. The output is the first 32 hex chars of
 * `sha256("${salt}|${userScope}|${ua}|${lang}")`, which gives roughly
 * 128 bits of entropy in the digest space.
 *
 * **IP is deliberately NOT an input.** The platform stores no user IP addresses
 * at rest (privacy invariant — see
 * docs/superpowers/specs/2026-07-14-no-ip-storage-design.md). Beyond the privacy
 * requirement, a salted hash over the tiny IPv4 space is brute-forceable by
 * anyone with server access, and IP churn (mobile networks, NAT re-lease) made
 * IP-seeded ids unstable — a single physical device kept minting fresh session
 * rows as its IP rotated. Dropping IP fixes both.
 *
 * **Why salt + userId?** Without them, two distinct users on the same browser
 * (same Chrome version + Accept-Language) would derive the SAME deviceId —
 * leaking the existence of one user's sessions to the other via
 * `getDeviceActiveSessions`, and enabling cross-tenant session termination via
 * `logoutAllDeviceSessions`. Scoping by `userId` makes the device-grouping
 * per-user. The accepted trade-off is that the same user + same UA + same
 * language on two physical devices dedupe to one deviceId — acceptable because
 * device-first auth uses the client-persisted deviceId as the authority.
 *
 * Pre-auth callers (e.g. signup, before the user record exists) MAY pass
 * `userId = null`; the resulting id is stable for the pre-auth phase but
 * deterministically distinct from any post-auth id derived from the same
 * UA/lang.
 *
 * Falls back to `null` when:
 *   - the server-side salt is unset (caller should fall back to a random id);
 *   - the User-Agent is missing or the literal string `'unknown'`.
 */
export function deriveStableDeviceId(
  userAgent: string,
  acceptLanguage: string,
  userId?: string | null
): string | null {
  if (!userAgent || userAgent === 'unknown') {
    return null;
  }
  const salt = getDeviceIdSalt();
  if (!salt) {
    return null;
  }
  const userScope = userId && userId.length > 0 ? userId : PRE_AUTH_USER_SCOPE;
  return crypto
    .createHash('sha256')
    .update(`${salt}|${userScope}|${userAgent}|${acceptLanguage}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Derive a stable, non-PII deviceId for a session minted server-to-server on
 * behalf of a caller with no stable client identity of its own, keyed by
 * `(userId, key)` instead of the request's UA/IP. The output is the first 32
 * hex chars of `sha256("${salt}|${userId}|idp|${key}")`. The `idp` hash
 * segment is FIXED cryptographic derivation material for server-minted sessions.
 *
 * **Why a separate helper?** A server-to-server mint has no meaningful
 * User-Agent (`'unknown'`), so `deriveStableDeviceId` returns null for it → the
 * caller would fall back to a fresh random id every call → a brand-new session
 * row each time. Keying off a stable per-caller key (`key`) instead makes one
 * `(user, RP)` reuse a single session that simply refreshes its tokens/expiry.
 *
 * **Why the `'idp'` namespace segment?** It guarantees the output can never
 * collide with a UA-derived id from `deriveStableDeviceId` (whose hash input
 * never contains the literal `idp` in that position), so the two device-id
 * spaces stay disjoint.
 *
 * **Per-user scoping is MANDATORY (security review H1):** `userId` is mixed
 * into the hash so two users with the same RP `key` can never derive the same
 * deviceId, which would otherwise leak/terminate one user's session via the
 * other.
 *
 * **Fail-closed on missing salt:** production ALWAYS has `DEVICE_ID_SALT` set
 * (`validateRequiredEnvVars` enforces it). Unlike `deriveStableDeviceId`
 * (which falls back to a random id when the salt is unset), this path MUST NOT
 * silently sprawl a new session per call, so it THROWS instead of returning a
 * weak/unsalted id.
 *
 * @param userId - Authenticated user id. Required for per-user scoping.
 * @param key - Stable per-RP key (e.g. the RP client origin / token audience).
 * @throws Error when `DEVICE_ID_SALT` is unset (fail-closed).
 */
export function deriveServiceDeviceId(userId: string, key: string): string {
  const salt = getDeviceIdSalt();
  if (!salt) {
    throw new Error(
      'deriveServiceDeviceId: DEVICE_ID_SALT is not set. ' +
        'Refusing to derive an unsalted IdP device id (would sprawl one session per request).'
    );
  }
  return crypto
    .createHash('sha256')
    .update(`${salt}|${userId}|idp|${key}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Generate a device fingerprint for device identification
 * This helps identify if it's the same physical device
 */
export const generateDeviceFingerprint = (fingerprint: DeviceFingerprintInput): string => {
  if (typeof fingerprint === 'string') {
    const clientFingerprint = fingerprint.trim();
    if (CLIENT_FINGERPRINT_HEX_RE.test(clientFingerprint)) {
      return clientFingerprint.toLowerCase();
    }

    return crypto.createHash('sha256').update(clientFingerprint).digest('hex');
  }

  const fingerprintString = [
    fingerprint.userAgent,
    fingerprint.platform,
    fingerprint.language,
    fingerprint.timezone,
    fingerprint.screen ? `${fingerprint.screen.width}x${fingerprint.screen.height}x${fingerprint.screen.colorDepth}` : '',
    // Don't include IP in fingerprint as it can change
  ].filter(Boolean).join('|');
  
  return crypto.createHash('sha256').update(fingerprintString).digest('hex');
};

/**
 * Extract device information from request.
 *
 * @param req - Express request to read headers from.
 * @param providedDeviceId - Optional explicit deviceId supplied by the client.
 * @param deviceName - Optional explicit device name supplied by the client.
 * @param userId - Optional authenticated user id. When set, the derived
 *   deviceId is scoped to this user so two distinct users on the same browser
 *   do NOT collide on the same id. Pre-auth callers (signup, device bootstrap
 *   before a session exists) should pass `null` / omit.
 */
export const extractDeviceInfo = (
  req: Request,
  providedDeviceId?: string,
  deviceName?: string,
  userId?: string | null
): DeviceInfo => {
  const userAgent = req.headers['user-agent'] || 'unknown';
  const platformHeader = req.headers['sec-ch-ua-platform'];
  const platform = (typeof platformHeader === 'string' ? platformHeader.replace(/"/g, '') : 'unknown');

  // Parse user agent for browser and OS info
  const browser = parseUserAgentBrowser(userAgent);
  const os = parseUserAgentOS(userAgent);
  const deviceType = parseDeviceType(userAgent);

  const acceptLanguageHeader = req.headers['accept-language'];
  const acceptLanguage = typeof acceptLanguageHeader === 'string' ? acceptLanguageHeader : '';

  // Stable deviceId fallback. The derived id is salted + user-scoped (see
  // `deriveStableDeviceId`) so device-grouping is per-user; the multi-account
  // browser switcher is driven by indexed refresh cookies, not by this id.
  // We fall back to a random id when the UA is unresolvable or the salt is unset.
  let resolvedDeviceId = providedDeviceId;
  let deviceIdSource: DeviceInfo['deviceIdSource'] = providedDeviceId ? 'provided' : 'random';
  if (!resolvedDeviceId) {
    const derived = deriveStableDeviceId(userAgent, acceptLanguage, userId);
    if (derived) {
      resolvedDeviceId = derived;
      deviceIdSource = 'fingerprint-derived';
    } else {
      resolvedDeviceId = generateDeviceId();
      deviceIdSource = 'random';
    }
  }

  return {
    deviceId: resolvedDeviceId,
    deviceName: deviceName || generateDefaultDeviceName(browser, os),
    deviceType,
    platform,
    browser,
    os,
    userAgent,
    deviceIdSource,
  };
};

/**
 * Generate a device ID
 */
export const generateDeviceId = (): string => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Generate a default device name based on browser and OS
 */
export const generateDefaultDeviceName = (browser?: string, os?: string): string => {
  const browserName = browser || 'Browser';
  const osName = os || 'Unknown OS';
  return `${browserName} on ${osName}`;
};

/**
 * Derive a COARSE, display-only client label (`"Chrome on Windows"`) from a
 * request User-Agent, for approval surfaces that must tell the approver WHERE a
 * request came from without trusting anything the requester can assert.
 *
 * **Privacy invariant (owner-mandated).** The output is one of the small closed
 * set of labels composable from the buckets {@link parseUserAgentBrowser} and
 * {@link parseUserAgentOS} recognise. The raw User-Agent is NEVER returned and
 * never persisted, and no IP address, geolocation, or country ever enters this
 * path (see `docs/superpowers/specs/2026-07-14-no-ip-storage-design.md`). It is
 * deliberately too coarse to fingerprint with — do NOT widen it with versions,
 * device models, screen data, or locale.
 *
 * Returns `null` — never a guessed or half-filled label — whenever no browser
 * can be identified. Native callers (whose User-Agent is an HTTP client string,
 * not a browser) and absent/garbage User-Agents both land there, and the UI
 * simply omits the line.
 */
export function deriveCoarseClientLabel(userAgent: string | undefined | null): string | null {
  if (typeof userAgent !== 'string') {
    return null;
  }
  const ua = userAgent.trim();
  if (!ua || ua === 'unknown') {
    return null;
  }
  const browser = parseUserAgentBrowser(ua);
  // No recognisable browser → native client or junk UA. Never invent a label.
  if (browser === UNKNOWN_USER_AGENT_BUCKET) {
    return null;
  }
  const os = parseUserAgentOS(ua);
  // A known browser on an unrecognised platform is still useful ("Firefox"),
  // and is strictly less specific than the two-part label — never "X on Unknown".
  return os === UNKNOWN_USER_AGENT_BUCKET ? browser : generateDefaultDeviceName(browser, os);
}

/**
 * Find existing device ID for a device fingerprint
 * This helps reuse device IDs for the same physical device
 */
export const findExistingDeviceId = async (fingerprint: string, userId?: string): Promise<string | null> => {
  if (!fingerprint) return null;

  try {
    // `is_active` + `expires_at > now()` are filtered HERE, not left to the
    // expiry sweep: the sweep lags one interval, and reusing a dead session's
    // device id would silently regroup a new sign-in onto it.
    const [session] = await getDb()
      .select({ deviceId: sessions.deviceId })
      .from(sessions)
      .where(
        and(
          eq(sessions.deviceFingerprint, fingerprint),
          eq(sessions.isActive, true),
          gt(sessions.expiresAt, new Date()),
          ...(userId ? [eq(sessions.userId, userId)] : [])
        )
      )
      .orderBy(desc(sessions.lastActiveAt))
      .limit(1);

    return session?.deviceId ?? null;
  } catch (error) {
    logger.error('[DeviceUtils] Error finding existing device ID', error instanceof Error ? error : new Error(String(error)));
    return null;
  }
};

/**
 * Register or update device information
 * @param deviceInfo - Device information to register
 * @param fingerprint - Optional device fingerprint for device reuse
 * @param userId - Optional user ID to optimize device lookup queries
 */
export const registerDevice = async (
  deviceInfo: DeviceInfo, 
  fingerprint?: string,
  userId?: string
): Promise<DeviceInfo> => {
  try {
    // If fingerprint provided, try to find existing device ID
    // Pass userId to optimize query - reduces Session collection scan
    if (fingerprint) {
      const existingDeviceId = await findExistingDeviceId(fingerprint, userId);
      if (existingDeviceId) {
        deviceInfo.deviceId = existingDeviceId;
      }
      deviceInfo.fingerprint = fingerprint;
    }
    
    logger.info(`[DeviceUtils] Registered device: ${deviceInfo.deviceId} (${deviceInfo.deviceName})`);
    return deviceInfo;
  } catch (error) {
    logger.error('[DeviceUtils] Error registering device:', error);
    return deviceInfo;
  }
};

/** One deduplicated device session row returned by {@link getDeviceActiveSessions}. */
interface DeviceSessionEntry {
  sessionId: string;
  user: ReturnType<typeof formatUserResponse>;
  lastActive: string | Date;
  createdAt: Date;
  deviceId: string;
  expiresAt: Date;
  isCurrent: boolean;
}

/**
 * Get all active sessions for a specific device
 * Deduplicates by userId - returns only one session per user (most recent)
 * Marks current session with isCurrent flag
 */
export const getDeviceActiveSessions = async (deviceId: string, currentSessionId?: string) => {
  try {
    const now = new Date();
    // Mongo's `.populate('userId', …)` becomes a real join. Columns are named
    // explicitly rather than `select()`-ing whole tables: `sessions` carries two
    // live bearer tokens and `users` carries the contact-discovery hashes, none
    // of which this DTO may see (`db/schema/protectedColumns.ts`).
    // Serves the `(device_id, is_active, expires_at)` index.
    const rows = await getDb()
      .select({
        sessionId: sessions.sessionId,
        deviceId: sessions.deviceId,
        lastActiveAt: sessions.lastActiveAt,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        username: users.username,
        email: users.email,
        avatar: users.avatar,
        nameFirst: users.nameFirst,
        nameLast: users.nameLast,
        color: users.color,
        publicKey: users.publicKey,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.deviceId, deviceId),
          eq(sessions.isActive, true),
          gt(sessions.expiresAt, now)
        )
      )
      // Most recent first; `session_id` breaks a tie so the page is stable.
      .orderBy(desc(sessions.lastActiveAt), asc(sessions.sessionId))
      .limit(50);

    // Deduplicate by user — keep only the most recent session per user.
    const userSessionMap = new Map<string, DeviceSessionEntry>();

    for (const row of rows) {
      // `formatUserResponse` reads the flat Drizzle row directly (`id` +
      // `nameFirst`/`nameLast`); it is the ONE serializer that owns
      // `name.displayName`, so nothing is recomposed here.
      const formattedUser = formatUserResponse({
        id: row.userId,
        username: row.username,
        email: row.email,
        avatar: row.avatar,
        nameFirst: row.nameFirst,
        nameLast: row.nameLast,
        color: row.color,
        publicKey: row.publicKey,
      });
      if (!formattedUser?.id) continue;

      const userId = formattedUser.id;

      const existing = userSessionMap.get(userId);
      if (existing) {
        const existingTime = new Date(existing.lastActive || existing.createdAt || 0).getTime();
        const currentTime = new Date(row.lastActiveAt || row.createdAt || 0).getTime();
        if (currentTime <= existingTime) {
          continue; // Keep existing (more recent)
        }
      }

      userSessionMap.set(userId, {
        sessionId: row.sessionId,
        user: formattedUser,
        lastActive: row.lastActiveAt || row.createdAt || new Date().toISOString(),
        createdAt: row.createdAt,
        deviceId: row.deviceId,
        expiresAt: row.expiresAt,
        isCurrent: currentSessionId ? row.sessionId === currentSessionId : false
      });
    }

    return Array.from(userSessionMap.values());
  } catch (error) {
    logger.error('[DeviceUtils] Error getting device sessions:', error);
    return [];
  }
};

/**
 * Logout all sessions for a specific device
 */
export const logoutAllDeviceSessions = async (deviceId: string, excludeSessionId?: string) => {
  try {
    const match = and(
      eq(sessions.deviceId, deviceId),
      eq(sessions.isActive, true),
      ...(excludeSessionId ? [ne(sessions.sessionId, excludeSessionId)] : [])
    );

    // One statement instead of Mongo's read-then-updateMany: `returning` gives
    // back exactly the rows this update deactivated, so the cache invalidation
    // below can no longer act on a row a concurrent writer changed in between.
    //
    // The Mongo version also wrote `loggedOutAt` here. That field is on NO
    // schema — Mongoose strict mode silently dropped it on every call, so it has
    // never been persisted or read. There is deliberately no `logged_out_at`
    // column; the write is dropped rather than reproduced.
    const deactivated = await getDb()
      .update(sessions)
      .set({ isActive: false })
      .where(match)
      .returning({ sessionId: sessions.sessionId });

    for (const row of deactivated) {
      sessionCache.invalidate(row.sessionId);
    }

    logger.info(`[DeviceUtils] Logged out ${deactivated.length} sessions for device: ${deviceId}`);
    return deactivated.length;
  } catch (error) {
    logger.error('[DeviceUtils] Error logging out device sessions:', error);
    return 0;
  }
};

// Helper functions for parsing user agent
function parseUserAgentBrowser(userAgent: string): string {
  // ORDER IS SIGNIFICANT — same rationale as `parseUserAgentOS` below.
  // Chromium Edge advertises `Edg/`, not `Edge`; Opera uses `OPR/`. All three
  // also contain `Chrome`, so the generic Chrome bucket must come last.
  if (userAgent.includes('Edg/')) return 'Edge';
  if (userAgent.includes('OPR/') || userAgent.includes('Opera')) return 'Opera';
  if (userAgent.includes('CriOS/')) return 'Chrome';
  if (userAgent.includes('FxiOS/')) return 'Firefox';
  if (userAgent.includes('Firefox')) return 'Firefox';
  if (userAgent.includes('Chrome')) return 'Chrome';
  if (userAgent.includes('Safari')) return 'Safari';
  return UNKNOWN_USER_AGENT_BUCKET;
}

/**
 * ORDER IS SIGNIFICANT. Mobile platforms are checked BEFORE the desktop
 * platform whose token their User-Agent also contains, because both nest:
 * every iPhone/iPad UA carries `like Mac OS X`, and every Android UA carries
 * `Linux`. Checking desktop first reported an iPhone as macOS and an Android
 * phone as Linux — a wrong label, not merely a coarse one, on surfaces (device
 * lists, the sign-in approval screen) where the user is being asked to
 * recognise their own device.
 */
function parseUserAgentOS(userAgent: string): string {
  if (userAgent.includes('Windows')) return 'Windows';
  if (
    userAgent.includes('iPhone') ||
    userAgent.includes('iPad') ||
    userAgent.includes('iPod') ||
    userAgent.includes('iOS')
  ) {
    return 'iOS';
  }
  if (userAgent.includes('Android')) return 'Android';
  if (userAgent.includes('Mac OS')) return 'macOS';
  if (userAgent.includes('Linux')) return 'Linux';
  return UNKNOWN_USER_AGENT_BUCKET;
}

function parseDeviceType(userAgent: string): string {
  if (userAgent.includes('Mobile')) return 'mobile';
  if (userAgent.includes('Tablet')) return 'tablet';
  return 'desktop';
}
