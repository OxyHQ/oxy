/**
 * `/internal` — endpoints only another Oxy service may call.
 *
 * ## Who may reach this router
 *
 * Two gates, applied to the whole router rather than per endpoint, so a new
 * endpoint added here cannot forget one:
 *
 *  1. **A valid service token.** `serviceAuthMiddleware` — not `authMiddleware`.
 *     A user session, however privileged the user, is refused: nothing here is a
 *     user-facing surface, and admitting a session token would make every
 *     endpoint below reachable from a browser holding a stolen one.
 *  2. **A platform-TRUSTED calling application.** The service-token mint has a
 *     deliberate carve-out — a non-trusted application MAY mint a service token
 *     from a payments-only credential, so external Oxy Pay merchants can use
 *     `@oxyhq/pay` (`routes/auth.ts`, `POST /auth/service-token`). "Holds a valid
 *     service token" is therefore NOT the same set as "is a first-party Oxy
 *     service", and this router needs the second. Without this check a
 *     WooCommerce merchant's payments credential would reach the delegation
 *     oracle below.
 *
 * The router is deliberately absent from the generated OpenAPI document. It is
 * not part of the public API contract, and publishing it would advertise an
 * endpoint whose whole purpose is to be unreachable to the callers reading that
 * document.
 *
 * ## What is still disclosed, stated plainly
 *
 * A trusted first-party application can ask whether some user has granted some
 * other application offline delegation, and gets a truthful yes or no. That is a
 * real disclosure to a real audience, and it is accepted rather than overlooked:
 * the set of trusted applications is staff-controlled, already holds
 * cross-tenant authority through scopes like `federation:write`, and is
 * precisely the set of first-party services that legitimately verify each
 * other's delegated calls. The verifier is not the application being asked
 * about — Syra asks about Alia — so narrowing this to "may only ask about
 * itself" would break the mechanism rather than tighten it.
 *
 * The available tightening, if that audience is ever judged too wide, is a
 * dedicated `acting-as:verify` scope so only staff-designated resource servers
 * may ask. It is not taken here because it adds a per-verifier staff action for
 * a disclosure bounded to first-party services; it is a one-line change to this
 * router if the trade is ever re-weighed.
 */

import express from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { resolveServiceActingAsGrant } from '../services/serviceActingAs.service';
import { isTrustedApplication } from '../utils/trustedApplication';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { ForbiddenError, UnauthorizedError } from '../utils/error';
import { logger } from '../utils/logger';

const router = express.Router();

/**
 * Keyed on the CALLING application, never on an IP.
 *
 * Every request to this router arrives from a server, so an IP key would put
 * every caller behind one NAT or one ECS task into a single bucket and let a
 * misconfigured service starve an unrelated one. The application id is both the
 * right blast radius and already verified — it comes off the signed token, not
 * off the request.
 *
 * The limit is sized for the SDK's caching. `@oxyhq/core` caches a positive
 * grant for 5 minutes and a negative for 60 seconds per (appId, userId), so a
 * healthy verifier makes roughly one call per distinct user per five minutes.
 * 600/minute is far above that and far below what an enumeration sweep needs.
 */
const serviceActingAsVerifyLimiter = rateLimit({
  prefix: 'rl:internal:service-acting-as-verify:',
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req) => {
    const appId = (req as ServiceAuthRequest).serviceApp?.appId;
    // The limiter is mounted AFTER the two gates below, so `serviceApp` is
    // always present by the time this runs. `unknown` is the fail-closed answer
    // if that order is ever changed: unattributable callers share one bucket
    // rather than each getting a fresh one.
    return appId ?? 'unknown';
  },
});

/**
 * Both gates, as one handler, so the ordering between them cannot be reordered
 * apart by a later edit. `serviceAuthMiddleware` runs first and has already
 * populated `req.serviceApp`; this only decides whether that principal belongs
 * on this router at all.
 */
const requireTrustedServiceApp = asyncHandler(
  async (req: ServiceAuthRequest, _res, next) => {
    const serviceApp = req.serviceApp;
    if (!serviceApp) {
      throw new UnauthorizedError('Service authentication required');
    }

    // Re-read the application rather than trusting a claim about its trust: the
    // token lives an hour, and an application demoted out of the trusted set
    // must lose this router immediately rather than when its last token expires.
    // The token carries `scopes` but nothing about trust, so there is no claim
    // to read even if that were acceptable.
    const [app] = await getDb()
      .select({
        type: applications.type,
        isOfficial: applications.isOfficial,
        isInternal: applications.isInternal,
      })
      .from(applications)
      .where(and(eq(applications.id, serviceApp.appId), eq(applications.status, 'active')))
      .limit(1);

    if (!app || !isTrustedApplication(app)) {
      logger.warn('[internal] Untrusted application refused', {
        appId: serviceApp.appId,
        credentialId: serviceApp.credentialId,
      });
      throw new ForbiddenError('This endpoint is restricted to trusted Oxy services');
    }

    next();
  }
);

router.use(serviceAuthMiddleware);
router.use(requireTrustedServiceApp);

/**
 * Both ids are opaque strings the caller supplies, and neither is trusted for
 * anything beyond being looked up. The bounds exist so an arbitrarily long
 * string never reaches a query; they are not a format contract, because this API
 * carries two live id shapes (24-char ObjectId hex preserved from Mongo, and
 * uuid v7 for everything created since) and a format check that admits only one
 * of them would silently deny every user created on the wrong side of the
 * cutover.
 */
const serviceActingAsVerifyQuery = z.object({
  appId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
});

/**
 * `GET /internal/service-acting-as/verify?appId=&userId=`
 *
 * Answers the one question `@oxyhq/core`'s `oxy.auth()` asks before it will let
 * a service token name a user in `X-Oxy-User-Id`: does `appId` hold live,
 * user-granted authority to act as `userId`?
 *
 * `appId` is the application being asked ABOUT, which is not the caller. A
 * verifier (Syra) receives a token minted by another application (Alia) and asks
 * whether that application may act for the user it named.
 *
 * Always 200 with `{ authorized, scopes }`. Never 404, and never a different
 * status for "no such user" than for "no grant" — the caller learns whether this
 * exact delegation is live and nothing else about who exists.
 */
router.get(
  '/service-acting-as/verify',
  serviceActingAsVerifyLimiter,
  validate({ query: serviceActingAsVerifyQuery }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    const { appId, userId } = serviceActingAsVerifyQuery.parse(req.query);

    const grant = await resolveServiceActingAsGrant(appId, userId);

    // Logged on both outcomes. A record of who asked about whom is what makes
    // the disclosure this endpoint accepts auditable, and logging only refusals
    // would leave every successful delegation invisible.
    logger.info('[internal] service-acting-as verify', {
      callerAppId: req.serviceApp?.appId,
      subjectAppId: appId,
      authorized: grant.authorized,
    });

    sendSuccess(res, grant);
  })
);

export default router;
