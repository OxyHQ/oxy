import { type Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import securityActivityService from '../services/securityActivityService';
// The audit vocabulary comes from the TABLE, not from the mongoose model — the
// schema module declares its own copy precisely so a consumer needs no mongoose
// import, and `db/schema/__tests__/authSession.test.ts` holds the two copies in
// agreement until the model is deleted.
import { SECURITY_EVENT_TYPES } from '../db/schema/securityActivities';
import { validatePagination } from '../utils/validation';
import { sendPaginated } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Log private key exported event
 * POST /api/security/activity/private-key-exported
 */
export const logPrivateKeyExported = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userId = req.user._id.toString();
    const deviceId = req.body.deviceId as string | undefined;

    await securityActivityService.logPrivateKeyExported(userId, req, deviceId);

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Failed to log private key exported event', error instanceof Error ? error : new Error(String(error)), {
      component: 'SecurityActivityController',
      method: 'logPrivateKeyExported',
      userId: req.user?._id.toString(),
    });
    res.status(500).json({ error: 'Failed to log security event' });
  }
};

/**
 * Log backup created event
 * POST /api/security/activity/backup-created
 */
export const logBackupCreated = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userId = req.user._id.toString();
    const deviceId = req.body.deviceId as string | undefined;

    await securityActivityService.logBackupCreated(userId, req, deviceId);

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Failed to log backup created event', error instanceof Error ? error : new Error(String(error)), {
      component: 'SecurityActivityController',
      method: 'logBackupCreated',
      userId: req.user?._id.toString(),
    });
    res.status(500).json({ error: 'Failed to log security event' });
  }
};

/**
 * Get user's security activity with pagination
 * GET /api/security/activity
 */
export const getSecurityActivity = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const userId = req.user._id.toString();
    const { limit: parsedLimit, offset: parsedOffset } = validatePagination(
      req.query.limit,
      req.query.offset,
      MAX_LIMIT,
      DEFAULT_LIMIT
    );

    // Resolve the filter by LOOKING IT UP in the closed set rather than
    // asserting a query-string value into it: `find` both validates and narrows,
    // so no unchecked cast of user input is needed. An absent or empty
    // `eventType` means "no filter" — unchanged from before.
    const requestedEventType = req.query.eventType;
    const eventType = requestedEventType
      ? SECURITY_EVENT_TYPES.find((value) => value === requestedEventType)
      : undefined;
    if (requestedEventType && !eventType) {
      res.status(400).json({ error: 'Invalid event type' });
      return;
    }

    const result = await securityActivityService.getUserSecurityActivity(userId, {
      limit: parsedLimit,
      offset: parsedOffset,
      eventType,
    });

    // Transform activities for response.
    //
    // `occurredAt` is emitted as `timestamp`: the table renames the Mongoose
    // field (see `db/schema/securityActivities.ts` for why), and that rename
    // must never reach a client — every Oxy app consuming `GET
    // /security/activity` reads `timestamp`. The DTO is also a FIXED field set
    // rather than a spread of the row, so nothing a writer smuggled into the
    // open `metadata` column can surface as a new top-level field.
    const activities = result.activities.map((activity) => ({
      id: activity.id,
      userId: activity.userId,
      eventType: activity.eventType,
      eventDescription: activity.eventDescription,
      metadata: activity.metadata,
      userAgent: activity.userAgent,
      deviceId: activity.deviceId,
      timestamp: activity.occurredAt,
      severity: activity.severity,
      createdAt: activity.createdAt,
    }));

    logger.debug('Security activity fetched', {
      userId,
      limit: parsedLimit,
      offset: parsedOffset,
      eventType,
      total: result.total,
    });

    sendPaginated(res, activities, result.total, parsedLimit, parsedOffset);
  } catch (error) {
    logger.error('Error fetching security activity', error instanceof Error ? error : new Error(String(error)), {
      component: 'SecurityActivityController',
      method: 'getSecurityActivity',
      userId: req.user?._id?.toString(),
    });
    res.status(500).json({ error: 'Failed to fetch security activity' });
  }
};

