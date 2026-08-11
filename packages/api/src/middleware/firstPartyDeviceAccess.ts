/**
 * Refuse a bearer that belongs to a THIRD-PARTY application (issue #937,
 * Phase 6).
 *
 * Everything behind this guard operates on the shared Oxy device: reading who is
 * signed in on it, activating the globally active context, adding or removing an
 * account, minting a long-lived background credential, issuing the browser hub
 * handle. Those are the device's own controls, and a third-party OAuth client
 * must not hold any of them — a leaked third-party token must not let an
 * attacker change what every other Oxy app on that device is signed in as, nor
 * enumerate the people on it.
 *
 * The decision is the REGISTRY's, re-read per request rather than frozen into
 * the token: flipping an application out of official status must lock it out
 * immediately, and an application row that has gone away must fail closed rather
 * than read as "unbound, therefore first-party". `application_id` is NULL for
 * every shared device session, so the ordinary path does no query at all.
 *
 * Lives here rather than beside one router because two mount points need the
 * same verdict — `/session/device/*` and `/session/browser-hub/*` — and a
 * security check that exists twice is a security check that will differ once.
 */

import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import type { AuthRequest } from './auth';
import { isTrustedApplication } from '../utils/trustedApplication';
import { asyncHandler } from '../utils/asyncHandler';
import { logger } from '../utils/logger';

export const requireFirstPartyDeviceAccess = asyncHandler(
  async (req: AuthRequest, res: Response, next: () => void) => {
    const applicationId = req.oxyToken?.applicationId;
    if (!applicationId) {
      next();
      return;
    }

    const [app] = await getDb()
      .select({
        status: applications.status,
        type: applications.type,
        isOfficial: applications.isOfficial,
        isInternal: applications.isInternal,
      })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);

    if (!app || app.status !== 'active' || !isTrustedApplication(app)) {
      logger.warn('device.lane.third_party_refused', {
        applicationId,
        path: req.path,
      });
      res.status(403).json({ error: 'third_party_device_access_denied' });
      return;
    }

    next();
  }
);
