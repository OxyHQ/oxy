import type { ClientSession } from '@oxy.so/core';

interface DeviceSession {
  sessionId: string;
  deviceId?: string;
  deviceName?: string;
  expiresAt?: string;
  lastActive?: string;
  user?: { id?: string; _id?: { toString(): string } };
  userId?: string;
  isCurrent?: boolean;
}

/**
 * Service type for session helpers.
 * Uses 'unknown' to work around TypeScript mixin composition type inference issues.
 * The OxyServices class has these methods but TypeScript can't see them due to the mixin pattern.
 * Methods are accessed dynamically, so callers must pass a properly typed instance.
 */
// biome-ignore lint/suspicious/noExplicitAny: OxyServices methods are accessed dynamically due to mixin composition; TypeScript cannot infer the full type
type OxyServicesAny = any;

export interface FetchSessionsWithFallbackOptions {
  fallbackDeviceId?: string;
  fallbackUserId?: string;
  logger?: (message: string, error?: unknown) => void;
}

/**
 * Normalize backend session payloads into `ClientSession` objects.
 *
 * @param sessions - Raw session array returned from the API
 * @param fallbackDeviceId - Device identifier to use when missing from payload
 * @param fallbackUserId - User identifier to use when missing from payload
 */
export const mapSessionsToClient = (
  sessions: DeviceSession[],
  fallbackDeviceId?: string,
  fallbackUserId?: string,
): ClientSession[] => {
  const now = new Date();

  return sessions.map((session) => ({
    sessionId: session.sessionId,
    deviceId: session.deviceId || fallbackDeviceId || '',
    expiresAt: session.expiresAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    lastActive: session.lastActive || now.toISOString(),
    userId:
      session.user?.id ||
      session.userId ||
      (session.user?._id ? session.user._id.toString() : undefined) ||
      fallbackUserId ||
      '',
    isCurrent: Boolean(session.isCurrent),
  }));
};

/**
 * Fetch device sessions, falling back to the per-user session endpoint
 * if the device endpoint is unavailable (older API versions or disabled
 * device-grouping feature flag).
 *
 * @param oxyServices - Oxy service instance
 * @param sessionId - Session identifier to fetch
 * @param options - Optional fallback options
 */
export const fetchSessionsWithFallback = async (
  oxyServices: OxyServicesAny,
  sessionId: string,
  {
    fallbackDeviceId,
    fallbackUserId,
    logger,
  }: FetchSessionsWithFallbackOptions = {},
): Promise<ClientSession[]> => {
  try {
    const deviceSessions = await oxyServices.getDeviceSessions(sessionId);
    return mapSessionsToClient(deviceSessions, fallbackDeviceId, fallbackUserId);
  } catch (error) {
    if (__DEV__ && logger) {
      logger('Failed to get device sessions, falling back to user sessions', error);
    }

    const userSessions = await oxyServices.getSessionsBySessionId(sessionId);
    return mapSessionsToClient(userSessions, fallbackDeviceId, fallbackUserId);
  }
};

