/**
 * App-signal ingest routes (`/app-signals`).
 *
 * Consuming apps report cross-app recommendation signals (endorsements +
 * interest) here using a SERVICE TOKEN granted the `signals:write` scope. The
 * source application is the token's `appId` (never a client-supplied value), so
 * an app can only write signals scoped to itself.
 */

import { Router, type Response } from 'express';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { ForbiddenError, BadRequestError } from '../utils/error';
import { appSignalsService } from '../services/appSignals.service';
import { appUserSignalIngestSchema, appAffinityEventsIngestSchema } from '@oxy.so/contracts';

const router = Router();

const REQUIRED_SCOPE = 'signals:write';

const WINDOW_1_MIN = 60 * 1000;

/**
 * Ingest limiter. Uniquely-prefixed (per the `rate-limit-redis` shared-store
 * rule) so it never collides with another limiter's counter.
 */
const ingestLimiter = rateLimit({
  prefix: 'rl:app-signals:ingest:',
  windowMs: WINDOW_1_MIN,
  max: 120,
});

/** Assert the requesting credential carries the signals:write scope. */
function assertSignalsScope(req: ServiceAuthRequest): void {
  const scopes = req.serviceApp?.scopes ?? [];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new ForbiddenError(`Missing required scope: ${REQUIRED_SCOPE}`);
  }
}

/**
 * POST /app-signals/ingest
 *
 * Ingest endorsement and/or interest signals for the requesting application.
 * Idempotent — re-ingesting the same edges is a no-op; an interest signal is
 * last-write-wins.
 */
router.post(
  '/ingest',
  ingestLimiter,
  serviceAuthMiddleware,
  validate({ body: appUserSignalIngestSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertSignalsScope(req);

    const applicationId = req.serviceApp?.appId;
    if (!applicationId) {
      throw new BadRequestError('Service token is missing an application id');
    }

    const { endorsements, interests } = req.body;

    const endorsementResult =
      endorsements && endorsements.length > 0
        ? await appSignalsService.ingestEndorsements(applicationId, endorsements)
        : { added: 0, removed: 0, skipped: 0, invalid: 0 };

    const interestResult =
      interests && interests.length > 0
        ? await appSignalsService.ingestInterests(applicationId, interests)
        : { upserted: 0, invalid: 0 };

    sendSuccess(res, {
      endorsements: endorsementResult,
      interests: interestResult,
    });
  })
);

/**
 * POST /app-signals/events
 *
 * Ingest a batch of directed interaction-affinity events for the requesting
 * application (`fromUserId → toUserId`, typed, optionally weighted). Each event
 * is folded into a per-app, time-decayed affinity edge; self-edges are dropped
 * and a supplied `eventId` is deduped. Idempotent for events carrying an
 * `eventId`; at-least-once (additive/decayed) for events without one.
 */
router.post(
  '/events',
  ingestLimiter,
  serviceAuthMiddleware,
  validate({ body: appAffinityEventsIngestSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    assertSignalsScope(req);

    const applicationId = req.serviceApp?.appId;
    if (!applicationId) {
      throw new BadRequestError('Service token is missing an application id');
    }

    const { events } = req.body;

    const affinityResult = await appSignalsService.ingestAffinityEvents(applicationId, events);

    sendSuccess(res, { affinity: affinityResult });
  })
);

export default router;
