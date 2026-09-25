/**
 * `GET /account-events` — the pull feed of account events addressed to the
 * calling application (OxyHQ/Mention#1169).
 *
 * The reconciliation safety net behind the webhook push: a relying party that
 * missed a push — it was down past the retry window, it registered no webhook,
 * the delivery was dead-lettered — reads the same signed tokens from a cursor
 * and erases. See `services/accountEvents.service.ts` and
 * `docs/identity/account-events.md`.
 *
 * Any application with a valid service token may call it, and each sees ONLY
 * the events it was a recipient of, so the feed discloses nothing the push did
 * not already send it. A user session is refused: this is server-to-server.
 */

import express from 'express';
import { z } from 'zod';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import {
  ACCOUNT_EVENT_FEED_MAX_LIMIT,
  listAccountEventsForApplication,
} from '../services/accountEvents.service';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { UnauthorizedError } from '../utils/error';

const router = express.Router();

/** Keyed on the calling application (verified off the token), never an IP. */
const accountEventFeedLimiter = rateLimit({
  prefix: 'rl:account-events:',
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => (req as ServiceAuthRequest).serviceApp?.appId ?? 'unknown',
});

const accountEventFeedQuery = z.object({
  /** An event id previously returned as `nextCursor`. Opaque to the caller. */
  after: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(ACCOUNT_EVENT_FEED_MAX_LIMIT).optional(),
});

router.get(
  '/',
  serviceAuthMiddleware,
  accountEventFeedLimiter,
  validate({ query: accountEventFeedQuery }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    const appId = req.serviceApp?.appId;
    if (!appId) throw new UnauthorizedError('Service authentication required');
    const { after, limit } = accountEventFeedQuery.parse(req.query);
    sendSuccess(res, await listAccountEventsForApplication(appId, { after, limit }));
  }),
);

export default router;
