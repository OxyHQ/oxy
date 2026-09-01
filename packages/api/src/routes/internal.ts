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
 *
 * ## Not every endpoint here is bounded by the two gates alone
 *
 * The verifier above ANSWERS a question. `POST /accounts/:id/service-switch`
 * MINTS A SESSION whose subject is a managed account — a durable, refreshable
 * bearer that speaks with that account's voice. Being trusted is not enough for
 * that and must never become enough, because trust is the entry condition for
 * this whole router: the endpoint carries its own staff-granted scope on top,
 * and its docblock records why that scope is a new one rather than the existing
 * `acting-as:offline`. A future endpoint of that weight owes the same.
 */

import express from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { isActAsEligibleKind } from '@oxyhq/contracts';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema/applications';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { users } from '../db/schema/users';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { accountIdRouteParams } from '../schemas/account.schemas';
import { accountService } from '../services/account.service';
import { resolveServiceActingAsGrant } from '../services/serviceActingAs.service';
import sessionService from '../services/session.service';
import type { SessionAuthResponse } from '../types/session';
import { SERVICE_ACCOUNT_SWITCH_SCOPE } from '../utils/applicationScopes';
import { isTrustedApplication } from '../utils/trustedApplication';
import { formatUserResponse } from '../utils/userTransform';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
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


/**
 * Keyed on the CALLING application, for the same reason and with the same
 * fail-closed `unknown` bucket as the verifier's limiter above.
 *
 * The number is a BLAST-RADIUS BOUND, not a capacity plan, and the two differ
 * here because a healthy caller's volume is not request-shaped. A repeat mint
 * for the same (application, account, operator) REUSES the existing session
 * rather than creating one — that is what `stableDeviceKey` buys below — so
 * legitimate traffic is bounded by the number of distinct (account, operator)
 * pairs an application acts for, warmed once and then held, not by how often it
 * acts. A stolen first-party credential sweeping the account graph is the shape
 * this bounds, and 600/minute puts a hard ceiling on how many accounts one
 * compromised credential can mint bearers for before the credential is revoked.
 */
const serviceAccountSwitchLimiter = rateLimit({
  prefix: 'rl:internal:service-account-switch:',
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req) => (req as ServiceAuthRequest).serviceApp?.appId ?? 'unknown',
});

/**
 * The operating human, read from `X-Oxy-User-Id`.
 *
 * Bounded and shape-checked for the reason the verify query's ids are: an
 * arbitrarily long string must never reach a query, and no format check is
 * possible because this API carries two live id shapes (24-char ObjectId hex
 * preserved from Mongo, uuid v7 since). `z.string()` also rejects the array
 * Express produces from a repeated header, rather than letting a comma-joined
 * value fall through to a lookup that would merely miss.
 */
const serviceAccountSwitchOperator = z.string().trim().min(1).max(128);

/**
 * `POST /internal/accounts/:id/service-switch`
 *
 * Mint a REAL session whose SUBJECT is a managed account (`organization`,
 * `project` or `bot`), on the authority of a human who holds `account:act_as`
 * over it, with no session of theirs, no device and no browser in the request.
 *
 * This is what lets an Oxy application run an autonomous agent AS a real Oxy
 * account — a `bot` with its own identity, its own follows, its own posts and
 * its own audit trail — instead of as the application wearing a display name.
 *
 * ## It is the same operation as `POST /accounts/:id/switch`, from the other lane
 *
 * That route is the user-facing twin and stays the reference for what a switch
 * IS. It cannot serve this caller: its whole router sits under `authMiddleware`,
 * which refuses any bearer without a `sessionId` claim, and a service token
 * carries none. That refusal is structural rather than a guard aimed at
 * services, so it is not something to relax — a service principal genuinely is
 * not a session, and `resolveOperatorId` there reads `req.user._id`, which a
 * service token never populates.
 *
 * ## The order of the checks IS the authorization
 *
 *   1. the token carries `accounts:act-as-session`      → else 403
 *   2. the request names an operating human              → else 400
 *   3. that human explicitly granted this application     → else 403
 *   4. the target account exists and is not archived     → else 404
 *   5. the human holds `account:act_as` over it          → else 403
 *   6. the target is an act-as-eligible KIND             → else 403
 *
 * (1) is first because it is free and it is the gate that distinguishes this
 * endpoint from the router it sits on: EVERY application that reaches this file
 * is platform-trusted, so trust cannot be what authorizes minting a session as
 * somebody's bot. Without the scope this would be open to every first-party
 * service on the platform, which is why it is a NEW scope and not
 * `acting-as:offline` — that one authorizes per-request attribution, and reusing
 * it would have silently promoted every holder to minting durable bearers.
 *
 * (5) precedes (6) so a caller who cannot act as the account learns nothing
 * about what KIND of account it is. The user-facing twin orders these the other
 * way round and can afford to: it has already authorized a human. Here the two
 * refusals are indistinguishable to a caller with no relationship to the target.
 *
 * (4) does disclose existence, and that is accepted rather than overlooked. The
 * audience is the staff-controlled set of trusted first-party services this
 * router already serves, and the distinction earns its keep: a deleted bot and a
 * withdrawn membership need different remediations, and collapsing them into one
 * status would make an agent retry forever against an account that is gone.
 *
 * ## The blast radius, stated rather than implied
 *
 * THIS IS NOT A BOT-ONLY ENDPOINT. `isActAsEligibleKind` admits `organization`
 * and `project` as well, so the scope permits an application to become a user's
 * ORGANIZATION, not merely the bot they built for it — with that organization's
 * billing surfaces, its members, its content and its ability to remove people.
 * That is the deliberate shape (a platform primitive, not an agent feature), and
 * it is written here so nobody has to infer it from a predicate's name.
 *
 * Trust opens the service router; it never supplies the human's decision.
 * `resolveServiceActingAsGrant` requires a real `app_grants` row naming
 * `acting-as:offline`, so the radius of one leaked credential is limited to
 * users who explicitly consented and accounts those users may actually operate.
 * Three independent checks bound it: the staff-granted token scope, the user's
 * explicit app grant, and the per-account `account:act_as` permission.
 *
 * ## What is deliberately NOT done
 *
 * The minted session is NOT registered into a device set
 * (`deviceSessionService.addAccount`), which the user-facing twin does do. A
 * backend has no device: there is no browser to restore it on reload and no
 * device room for a broadcast to reach. Registering one would invent a device
 * doc nothing ever reads and put a live-looking account into a set no human
 * holds.
 *
 * ## Revocation
 *
 * The session's validity stays bound to the operator's membership, because
 * `operatedByUserId` is recorded on it — the `account:act_as` re-check on
 * validate and refresh reads that column, so withdrawing the membership kills
 * the live session rather than merely refusing the next mint. Removing the app
 * grant or writing its revocation marker (step 3) refuses future mints.
 */
router.post(
  '/accounts/:id/service-switch',
  serviceAccountSwitchLimiter,
  validate({ params: accountIdRouteParams }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    const serviceApp = req.serviceApp;
    if (!serviceApp) {
      throw new UnauthorizedError('Service authentication required');
    }

    if (!serviceApp.scopes?.includes(SERVICE_ACCOUNT_SWITCH_SCOPE)) {
      throw new ForbiddenError(
        `This endpoint requires the ${SERVICE_ACCOUNT_SWITCH_SCOPE} scope`
      );
    }

    const operator = serviceAccountSwitchOperator.safeParse(req.headers['x-oxy-user-id']);
    if (!operator.success) {
      throw new BadRequestError(
        'X-Oxy-User-Id must name the human operating this account. There is no session in this request to fall back to.'
      );
    }
    const operatorId = operator.data;
    const accountId = req.params.id;

    // The application's own authority to act for this human at all, and the
    // door their revocation closes. `resolveServiceActingAsGrant` checks the
    // revocation FIRST, ahead of anything that could authorize, so a user who
    // said no is refused here whatever the membership below says.
    const grant = await resolveServiceActingAsGrant(serviceApp.appId, operatorId);
    if (!grant.authorized) {
      logger.warn('[internal] service-switch refused: no live delegation', {
        callerAppId: serviceApp.appId,
        operatorId,
        accountId,
      });
      throw new ForbiddenError('This application may not act for that user');
    }

    const [account] = await getDb()
      .select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE))
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);
    if (!account || account.accountStatus === 'archived') {
      throw new NotFoundError('Account not found');
    }

    // The ONLY per-human gate, read off the EFFECTIVE permission set rather than
    // the role, so a per-member revoke of `account:act_as` genuinely withdraws
    // it — the same authority the user-facing switch resolves through.
    const role = await accountService.verifyActingAs(operatorId, account.id);
    if (!role) {
      logger.warn('[internal] service-switch refused: operator lacks account:act_as', {
        callerAppId: serviceApp.appId,
        operatorId,
        accountId: account.id,
      });
      throw new ForbiddenError('That user is not authorized to act as this account');
    }

    if (!isActAsEligibleKind(account.kind)) {
      throw new ForbiddenError(
        account.kind === 'channel'
          ? 'Cannot act as a channel account'
          : 'Cannot act as a personal account'
      );
    }

    // `stableDeviceKey` is MANDATORY here, not a refinement. This request has no
    // stable client identity of its own — a backend sends no meaningful
    // User-Agent — so `extractDeviceInfo` would fall through UA-derivation to a
    // RANDOM deviceId and mint a brand-new `sessions` row on every call, forever.
    // Keying on (application, account) instead makes one application acting as
    // one account reuse a single session that simply refreshes, while two
    // applications acting as the same account stay on separate devices.
    //
    // The operator is NOT in the key, deliberately: `createSession` already
    // refuses to reuse a delegated session belonging to a DIFFERENT operator, so
    // two humans acting as one bot through one application get two sessions on
    // one device — which is the truth of the situation, and is what keeps
    // removing either of them from revoking the other's access.
    const session = await sessionService.createSession(account.id, req, {
      operatedByUserId: operatorId,
      stableDeviceKey: `service:${serviceApp.appId}:${account.id}`,
    });

    const userData = formatUserResponse(account);
    if (!userData) {
      throw new Error('Failed to format account data');
    }

    // Logged on success as well as on refusal: a bearer that speaks as somebody
    // else's account, minted with no human present, is exactly the event an
    // audit needs a record of.
    logger.info('[internal] service-switch minted a managed-account session', {
      callerAppId: serviceApp.appId,
      operatorId,
      accountId: account.id,
      accountKind: account.kind,
      role,
      sessionId: session.sessionId,
    });

    // The same payload the login / claimSession / switch responses carry, so a
    // consumer plants it exactly as it plants any other session — under this
    // router's `{ data }` envelope, which is what `/internal` answers with.
    const response: SessionAuthResponse = {
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      expiresAt: session.expiresAt.toISOString(),
      accessToken: session.accessToken,
      user: {
        id: userData.id,
        username: userData.username,
        avatar: userData.avatar,
      },
    };

    sendSuccess(res, response);
  })
);

export default router;
