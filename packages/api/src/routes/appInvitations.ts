import { hasServiceAuthority } from '../utils/serviceAuthority';
/**
 * Invitation emails an application has Oxy send for it (`invitations:email`).
 *
 * Mounted at `/apps/invitations`. Service tokens only — a person's session never
 * reaches the handler — and the privileged scope, which staff grant per
 * application. What the email may say and where its link may point is decided
 * in `services/appInvitationEmail.service.ts`.
 */

import express, { type NextFunction, type Response } from 'express';
import type { z } from 'zod';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { parseValidatedRequestValue, validate } from '../middleware/validate';
import {
  type appInvitationEmailResponseSchema,
  appInvitationEmailSchema,
  appInvitationIdempotencyKeySchema,
  type AppInvitationEmailBody,
} from '../schemas/appInvitations.schemas';
import { acceptAppInvitationEmail } from '../services/appInvitationEmail.service';
import { APP_INVITATION_EMAIL_SCOPE } from '../utils/applicationScopes';
import { asyncHandler } from '../utils/asyncHandler';
import { serviceRateLimitKey } from '../utils/serviceRateLimitKey';

const router = express.Router();

/**
 * Refuse a token without `invitations:email` before the body is even parsed.
 * The service reads the application's live ceiling again; this is the token's.
 */
function requireInvitationEmailScope(req: ServiceAuthRequest, res: Response, next: NextFunction) {
  if (!hasServiceAuthority(req.serviceApp, APP_INVITATION_EMAIL_SCOPE)) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: `Missing required scope: ${APP_INVITATION_EMAIL_SCOPE}`,
    });
  }
  return next();
}

/**
 * A burst guard per credential, in front of the durable budgets the service
 * counts (one per recipient an hour, fifty per inviter and a thousand per
 * application a day). Those refuse a send; this refuses a loop.
 */
const invitationEmailLimiter = rateLimit({
  prefix: 'rl:apps:invitations:email:',
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => serviceRateLimitKey((req as ServiceAuthRequest).serviceApp),
});

/**
 * Send one invitation email for the calling application.
 *
 * The one template, "{inviter} invited you to {resourceName} on
 * {application}", with `acceptUrl` as its only link. `Idempotency-Key` is
 * required and is the application's own id for the invitation: a repeat answers
 * the first acceptance (200, `replayed: true`) and sends nothing.
 *
 * 202 when accepted (`state: 'sending'`). The inviter's name is read by Oxy from
 * `inviterUserId`; `acceptUrl` must be https on one of the application's
 * registered origins. 422 `details.reason` is `accept_url_not_registered`,
 * `inviter_unavailable`, `recipient_suppressed` or `idempotency_key_reused`;
 * 429 is a spent budget, with `Retry-After`; 503 no outbound relay.
 * @response 202 appInvitationEmailResponseSchema Accepted; delivery follows.
 * @response 200 appInvitationEmailResponseSchema The first acceptance under this key.
 */
router.post(
  '/email',
  serviceAuthMiddleware,
  requireInvitationEmailScope,
  invitationEmailLimiter,
  validate({ body: appInvitationEmailSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    const idempotencyKey = parseValidatedRequestValue(
      appInvitationIdempotencyKeySchema,
      req.header('Idempotency-Key'),
    );
    const body = req.body as AppInvitationEmailBody;
    const serviceApp = req.serviceApp;
    if (!serviceApp) throw new Error('serviceAuthMiddleware ran without a service principal');
    const accepted = await acceptAppInvitationEmail({
      applicationId: serviceApp.appId,
      idempotencyKey,
      ...body,
    });
    const answer: z.input<typeof appInvitationEmailResponseSchema> = {
      data: {
        ...accepted.invitation,
        createdAt: accepted.invitation.createdAt.toISOString(),
        replayed: accepted.replayed,
      },
    };
    res.status(accepted.replayed ? 200 : 202).json(answer);
  }),
);

export default router;
