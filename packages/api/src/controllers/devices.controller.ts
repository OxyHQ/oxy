/**
 * Device management — the account's signed-in devices, derived from its live
 * sessions.
 *
 * A "device" is not a row: it is the set of sessions sharing one `device_id`,
 * collapsed to the most recently active one. Mongo's `deviceInfo` subdocument is
 * flattened into columns here (`device_name`, `device_type`, `last_active_at`),
 * so the grouping reads the columns directly.
 *
 * ## Why the "keep the more recent one" comparison is gone
 *
 * The Mongo version sorted by `deviceInfo.lastActive` descending and THEN
 * re-compared each session against the one already in the map, because
 * `lastActive` was optional on the subdocument and a missing value sorts
 * unpredictably. `sessions.last_active_at` is `NOT NULL DEFAULT now()`, so
 * `order by last_active_at desc` is total: the first row seen for a device IS
 * the most recently active one, and the second pass could only ever confirm
 * that. It is dropped rather than transliterated.
 *
 * ## Expiry is filtered on the READ, not left to the sweep
 *
 * `expires_at > now()` travels verbatim from the Mongo query. The expiry sweep
 * (`db/expiry.ts`) lags by one interval, so dropping this filter would let an
 * expired session keep listing a device the user believes they signed out of.
 */

import type { Response } from 'express';
import { and, desc, eq, gt } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { sessions } from '../db/schema/sessions';
import { logger } from '../utils/logger';
import { extractTokenFromRequest, decodeToken } from '../middleware/authUtils';
import sessionService from '../services/session.service';
import type { AuthRequest } from '../middleware/auth';
import { emitSessionUpdate } from '../server';

/**
 * The `device_id` of the session the request itself is authenticated with, or
 * `null` when the token names no resolvable session.
 */
async function currentDeviceIdOf(req: AuthRequest): Promise<string | null> {
  const token = extractTokenFromRequest(req);
  if (!token) {
    return null;
  }
  const decoded = decodeToken(token);
  if (!decoded?.sessionId) {
    return null;
  }
  try {
    const sessionResult = await sessionService.validateSessionById(decoded.sessionId, false);
    return sessionResult?.session?.deviceId ?? null;
  } catch (error) {
    logger.debug('Could not get current session for device identification', { error });
    return null;
  }
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

      const currentDeviceId = await currentDeviceIdOf(req);

      const rows = await getDb()
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
            eq(sessions.userId, user._id),
            eq(sessions.isActive, true),
            gt(sessions.expiresAt, new Date())
          )
        )
        .orderBy(desc(sessions.lastActiveAt));

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

        // `||` rather than `??`, deliberately: Mongoose stored these as free
        // strings, so `''` is representable and has always rendered as the
        // placeholder. `??` would start serving an empty name.
        deviceMap.set(row.deviceId, {
          id: row.deviceId,
          deviceId: row.deviceId,
          name: row.deviceName || 'Unknown Device',
          deviceName: row.deviceName || 'Unknown Device',
          type: row.deviceType || 'unknown',
          deviceType: row.deviceType || 'unknown',
          lastActive: row.lastActiveAt,
          createdAt: row.createdAt,
          isCurrent: currentDeviceId ? row.deviceId === currentDeviceId : false,
        });
      }

      res.json(Array.from(deviceMap.values()));
    } catch (error) {
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

      const currentDeviceId = await currentDeviceIdOf(req);

      // Prevent removing current device
      if (currentDeviceId && deviceId === currentDeviceId) {
        return res.status(400).json({
          error: 'Cannot remove current device',
          message: 'You cannot remove your current device. Please use another device to remove this one.'
        });
      }

      // Only query and remove sessions belonging to the requesting user on this device
      const userDeviceSessions = await getDb()
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, user._id),
            eq(sessions.deviceId, deviceId),
            eq(sessions.isActive, true),
            gt(sessions.expiresAt, new Date())
          )
        );

      if (userDeviceSessions.length === 0) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Get sessionIds for the requesting user's sessions on this device
      const sessionIds = userDeviceSessions.map((row) => row.sessionId);

      // Logout only the requesting user's sessions on this device
      // Use sessionService to properly deactivate each session
      for (const sessionId of sessionIds) {
        await sessionService.deactivateSession(sessionId);
      }

      // Emit socket notification only for the requesting user
      emitSessionUpdate(user._id, {
        type: 'device_removed',
        deviceId: deviceId,
        sessionIds: sessionIds
      });

      res.json({
        success: true,
        message: 'Device removed successfully'
      });
    } catch (error) {
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
