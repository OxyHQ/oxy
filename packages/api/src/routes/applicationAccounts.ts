/**
 * Registered-account aggregate for the calling first-party deployment
 * (`/application-accounts/self`).
 *
 * Only an attested first-party workload may call: the application is the
 * verified workload's (`req.serviceApp.appId`), never a request value, so a
 * managed Mention instance and the main deployment never see each other's
 * ledger or total. No scope, consent or customer API key is accepted (ADR 0049),
 * and neither route lists or confirms individual accounts.
 */

import { Router, type Response } from 'express';
import {
  applicationAccountRegistrationRequestSchema,
  applicationAccountRegistrationResponseSchema,
  applicationAccountTotalSchema,
} from '@oxy.so/contracts';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { ForbiddenError } from '../utils/error';
import {
  readApplicationAccountTotal,
  registerApplicationAccounts,
} from '../services/applicationAccountTotals.service';

const router = Router();

const readLimiter = rateLimit({
  prefix: 'rl:application-accounts:read:',
  windowMs: 60 * 1000,
  max: 120,
});
const writeLimiter = rateLimit({
  prefix: 'rl:application-accounts:write:',
  windowMs: 60 * 1000,
  max: 120,
});

function firstPartyApplicationId(req: ServiceAuthRequest): string {
  const principal = req.serviceApp;
  if (principal?.authority !== 'first_party' || !principal.appId)
    throw new ForbiddenError('A first-party deployment workload is required.');
  return principal.appId;
}

/**
 * Register accounts the deployment provisioned locally as its users. Idempotent;
 * unknown, federated, non-personal and archived ids are skipped and not reported.
 * @response 200 applicationAccountRegistrationResponseSchema Newly registered count only.
 * @response 403 Error Caller is not a first-party deployment workload.
 */
router.post(
  '/self/registrations',
  writeLimiter,
  serviceAuthMiddleware,
  validate({ body: applicationAccountRegistrationRequestSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    const applicationId = firstPartyApplicationId(req);
    const registered = await registerApplicationAccounts(applicationId, req.body.accountIds);
    res.set('Cache-Control', 'no-store');
    res.json(applicationAccountRegistrationResponseSchema.parse({ registered }));
  }),
);

/**
 * The deployment's eligible registered-account total, from a bounded snapshot
 * (`computedAt`, `maxAgeSeconds`, `stale`, `exact`). Never a per-request count.
 * @response 200 applicationAccountTotalSchema The snapshot.
 * @response 403 Error Caller is not a first-party deployment workload.
 * @response 503 Error No snapshot exists yet and none could be produced.
 */
router.get(
  '/self/total',
  readLimiter,
  serviceAuthMiddleware,
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    const total = await readApplicationAccountTotal(firstPartyApplicationId(req));
    res.set('Cache-Control', 'no-store');
    res.json(applicationAccountTotalSchema.parse(total));
  }),
);

export default router;
