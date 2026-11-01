/**
 * Device management — the account's signed-in devices, derived from its live
 * sessions.
 *
 * A "device" is not a row: it is the set of sessions sharing one `device_id`,
 * collapsed to the most recently active one. The device fields are columns
 * (`device_name`, `device_type`, `last_active_at`), so the grouping reads the
 * columns directly.
 *
 * ## No "keep the more recent one" comparison
 *
 * `sessions.last_active_at` is `NOT NULL DEFAULT now()`, so
 * `order by last_active_at desc` is total: the first row seen for a device IS
 * the most recently active one, and a second comparison could only ever
 * confirm that.
 *
 * ## Expiry is filtered on the READ, not left to the sweep
 *
 * `expires_at > now()` is filtered here. The expiry sweep
 * (`db/expiry.ts`) lags by one interval, so dropping this filter would let an
 * expired session keep listing a device the user believes they signed out of.
 */

import type { Response } from 'express';
import { and, desc, eq, gt } from 'drizzle-orm';
import { sessions } from '../db/schema/sessions';
import { logger } from '../utils/logger';
import sessionService, { ActingSessionChangedError } from '../services/session.service';
import { sessionActorScope } from '../services/sessionActorScope';
import type { AuthRequest } from '../middleware/auth';

/**
 * Resolve the bearer session without a cached session snapshot.
 */
async function actingSessionOf(req: AuthRequest) {
  const subjectId = req.user?._id?.toString();
  const sessionId = req.sessionId;
  const token = req.oxyToken;
  if (!subjectId || !sessionId || !token) return null;
  const result = await sessionService.validateSessionById(sessionId, false, { useCache: false });
  const session = result?.session;
  const principalId = session?.operatedByUserId?.toString() ?? session?.userId?.toString();
  if (
    !session?.deviceId ||
    !principalId ||
    session.userId?.toString() !== subjectId ||
    token.subjectAccountId !== subjectId ||
    token.sessionId !== sessionId ||
    token.principalUserId !== principalId ||
    (token.applicationId ?? null) !== (session.applicationId ?? null)
  )
    return null;
  return {
    sessionId,
    subjectId,
    principalId,
    deviceId: session.deviceId,
    applicationId: token.applicationId ?? null,
  };
}

export class DevicesController {
  /**
   * Get all unique devices for the authenticated user
   * GET /api/devices
   */
  static async getUserDevices(req: AuthRequest, res: Response) {
    try {
      const user = req.user;
      if (!user || !user._id) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const acting = await actingSessionOf(req);
      if (!acting) return res.status(401).json({ error: 'Invalid session' });

      const rows = await sessionService.withActingSession(acting, (tx) =>
        tx
          .select({
            deviceId: sessions.deviceId,
            deviceName: sessions.deviceName,
            deviceType: sessions.deviceType,
            lastActiveAt: sessions.lastActiveAt,
            createdAt: sessions.createdAt,
          })
          .from(sessions)
          .where(
            and(
              sessionActorScope(acting.subjectId, acting.principalId),
              eq(sessions.isActive, true),
              gt(sessions.expiresAt, new Date()),
              // App-bound sessions have no proven shared-device provenance.
              ...(req.oxyToken?.applicationId ? [eq(sessions.sessionId, acting.sessionId)] : []),
            ),
          )
          .orderBy(desc(sessions.lastActiveAt)),
      );

      interface DeviceEntry {
        id: string;
        deviceId: string;
        name: string;
        deviceName: string;
        type: string;
        deviceType: string;
        lastActive: Date;
        createdAt: Date;
        isCurrent: boolean;
      }

      const deviceMap = new Map<string, DeviceEntry>();

      for (const row of rows) {
        // Ordered most-recently-active first, so the first row for a device wins.
        if (deviceMap.has(row.deviceId)) {
          continue;
        }

        // `||` rather than `??`, deliberately: these are free strings, so `''`
        // is representable and renders as the placeholder. `??` would serve an
        // empty name.
        deviceMap.set(row.deviceId, {
          id: row.deviceId,
          deviceId: row.deviceId,
          name: row.deviceName || 'Unknown Device',
          deviceName: row.deviceName || 'Unknown Device',
          type: row.deviceType || 'unknown',
          deviceType: row.deviceType || 'unknown',
          lastActive: row.lastActiveAt,
          createdAt: row.createdAt,
          isCurrent: row.deviceId === acting.deviceId,
        });
      }

      res.json(Array.from(deviceMap.values()));
    } catch (error) {
      if (error instanceof ActingSessionChangedError)
        return res
          .status(403)
          .json({ error: 'Acting session changed', code: 'ACTING_SESSION_MISMATCH' });
      logger.error('Get user devices error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Remove a device (logout all sessions on that device)
   * DELETE /api/devices/:deviceId
   */
  static async removeDevice(req: AuthRequest, res: Response) {
    try {
      const user = req.user;
      if (!user || !user._id) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const { deviceId } = req.params;
      if (!deviceId) {
        return res.status(400).json({ error: 'Device ID is required' });
      }

      if (req.oxyToken?.applicationId)
        return res.status(403).json({
          code: 'third_party_device_access_denied',
          error: 'An application session cannot revoke other sessions',
        });
      const acting = await actingSessionOf(req);
      if (!acting) return res.status(401).json({ error: 'Invalid session' });

      // Prevent removing current device
      if (deviceId === acting.deviceId) {
        return res.status(400).json({
          error: 'Cannot remove current device',
          message:
            'You cannot remove your current device. Please use another device to remove this one.',
        });
      }

      const revoked = await sessionService.deactivateActorSessionsOnDevice(acting, deviceId);
      if (revoked.length === 0) {
        return res.status(404).json({ error: 'Device not found' });
      }

      res.json({
        success: true,
        message: 'Device removed successfully',
      });
    } catch (error) {
      if (error instanceof ActingSessionChangedError)
        return res
          .status(403)
          .json({ error: 'Acting session changed', code: 'ACTING_SESSION_MISMATCH' });
      logger.error('Remove device error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Get security information
   * GET /api/devices/security
   */
  static async getSecurityInfo(req: AuthRequest, res: Response) {
    try {
      const user = req.user;
      if (!user || !user._id) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      res.json({
        recoveryEmail: user.email || null,
      });
    } catch (error) {
      logger.error('Get security info error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
