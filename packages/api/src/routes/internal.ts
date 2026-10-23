import {
  issueRequesterContext,
  resolveRequesterContext,
} from '../services/requesterContext.service';
import { verifyServiceToken } from '../middleware/serviceToken';
import { resolveLiveAgencyServicePrincipal } from '../services/agencyServicePrincipal.service';
import {
  resolveFirstPartyTask,
  taskAllowsEffectiveAccount,
} from '../services/firstPartyTasks.service';
import { isLegacyWorkloadCohort } from '../config/legacyWorkloadTransition';
import { hasServiceAuthority } from '../utils/serviceAuthority';
import { serviceActingAsAuthorityEpochs } from '../db/schema/serviceActingAsAuthorityEpochs';
import { resolveLiveAgencyWorkloadByHandle } from '../services/agencyServicePrincipal.service';
import { validateForegroundRequesterBearer } from '../services/foregroundCapabilityRequester.service';
import { OXY_SERVICE_ENVIRONMENTS } from '@oxy.so/core/server';
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
 *     from a payments-only credential, so external Peable merchants can use
 *     `@oxy.so/pay` (`routes/auth.ts`, `POST /auth/service-token`). "Holds a valid
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
 *
 * `GET /accounts/:accountId/access/:userId` is the other kind, and carries a
 * scope (`accounts:membership:read`) for a different reason. Its weight is
 * bounded because it ANSWERS A QUESTION — may this person act for that account,
 * with what effective permissions — and mints, grants and changes nothing. The
 * scope is there for the DISCLOSURE, not the authority: a channel is anonymous,
 * so its membership is exactly what trust alone must not hand every first-party
 * service.
 */

import express from 'express';
import { introspectAliaMachineCredential } from '../services/aliaMachineCredential.service';
import { observeInfrastructure } from '../services/platformInfrastructure.service';
import {
  platformActivityBatchSchema,
  infrastructureHeartbeatSchema,
} from '../services/platformActivity.schema';
import { publishPlatformActivity } from '../services/platformActivity.service';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type AccountAccessVerdict, isDelegatedActAsEligibleKind } from '@oxy.so/contracts';
import { publicColumns } from '@oxy.so/db/assert';
import { getDb } from '../config/postgres';
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
import {
  ACCOUNT_MEMBERSHIP_READ_SCOPE,
  SERVICE_ACCOUNT_SWITCH_SCOPE,
} from '../utils/applicationScopes';
import { isActiveTrustedApplication } from '../services/applicationTrust.service';
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
 * The limit is sized for the SDK's caching. `@oxy.so/core` caches a positive
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
const requireTrustedServiceApp = asyncHandler(async (req: ServiceAuthRequest, _res, next) => {
  const serviceApp = req.serviceApp;
  if (!serviceApp) {
    throw new UnauthorizedError('Service authentication required');
  }

  // Re-read the application rather than trusting a claim about its trust: the
  // token lives an hour, and an application demoted out of the trusted set
  // must lose this router promptly rather than when its last token expires —
  // at once on every task when the demotion invalidates, within 5 s otherwise
  // (`services/applicationTrust.service.ts`).
  const trusted = await isActiveTrustedApplication(serviceApp.appId);

  if (!trusted) {
    logger.warn('[internal] Untrusted application refused', {
      appId: serviceApp.appId,
      credentialId: serviceApp.credentialId,
    });
    throw new ForbiddenError('This endpoint is restricted to trusted Oxy services');
  }

  next();
});

router.use(serviceAuthMiddleware);
router.use(requireTrustedServiceApp);

const aliaMachineIntrospectionLimiter = rateLimit({
  prefix: 'rl:internal:alia-machine-introspection:',
  windowMs: 60_000,
  max: 300,
  keyGenerator: (req) => (req as ServiceAuthRequest).serviceApp?.appId || 'unknown',
});
const aliaMachineIntrospectionBody = z.object({ token: z.string().min(1).max(2048) }).strict();

/** Only Alia's own authenticated resource server may resolve this audience. */
router.post(
  '/alia/machine-credentials/introspect',
  aliaMachineIntrospectionLimiter,
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    const parsed = aliaMachineIntrospectionBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Invalid machine credential introspection');
    if (req.headers['x-oxy-user-id'] !== undefined) {
      sendSuccess(res, { active: false });
      return;
    }
    sendSuccess(
      res,
      await introspectAliaMachineCredential(req.serviceApp?.appId || '', parsed.data.token),
    );
  }),
);

// Aggregate-only collection from the whole first-party ecosystem. The router's
// shared service authentication and trust gates also protect this endpoint.
router.post(
  '/activity/infrastructure',
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    const result = infrastructureHeartbeatSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ error: 'Invalid infrastructure heartbeat' });
      return;
    }
    const { removed, ...member } = result.data;
    await observeInfrastructure(req.serviceApp!.appId, member, removed);
    res.status(204).end();
  }),
);

router.post('/activity', (req, res) => {
  const result = platformActivityBatchSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: 'Invalid activity aggregate' });
    return;
  }
  publishPlatformActivity(result.data);
  res.status(204).end();
});

/**
 * Both ids are opaque strings the caller supplies, and neither is trusted for
 * anything beyond being looked up. The bounds exist so an arbitrarily long
 * string never reaches a query; they are not a format contract, because this API
 * carries two live id shapes (legacy 24-hex ids and uuid v7) and a format check
 * that admits only one of them would silently deny every user with the other.
 */
const serviceActingAsVerifyQuery = z.object({
  taskId: z.string().min(1).max(128).optional(),
  credentialId: z.string().min(1).max(128).optional(),
  ownerAccountId: z.string().min(1).max(128).optional(),
  environment: z.enum(OXY_SERVICE_ENVIRONMENTS).optional(),
  appId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
});

/**
 * Verify a received service principal's requested account on behalf of a live
 * receiving Oxy workload. Own callers supply the original shared-session token
 * or a durable task ID bound to their exact workload. The verified account must
 * match that proof, and own replies carry authority without scope arrays.
 * External callers remain constrained by their live per-user delegation grant.
 */
router.get(
  '/service-acting-as/verify',
  serviceActingAsVerifyLimiter,
  validate({ query: serviceActingAsVerifyQuery }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    const { appId, userId, credentialId, ownerAccountId, environment, taskId } =
      serviceActingAsVerifyQuery.parse(req.query);
    const requesterToken = req.headers['x-oxy-requester-token'];
    const presentedContext = req.headers['x-oxy-presented-requester-context'];
    const presentedToken = req.headers['x-oxy-presented-service-token'];
    if (
      requesterToken !== undefined ||
      taskId !== undefined ||
      presentedContext !== undefined ||
      presentedToken !== undefined
    ) {
      const denied = () =>
        sendSuccess(res, { authorized: false, authority: 'first_party', epoch: '0' });
      if (
        req.serviceApp?.authority !== 'first_party' ||
        !credentialId ||
        !ownerAccountId ||
        !environment ||
        [requesterToken, taskId, presentedContext].filter((proof) => proof !== undefined).length !==
          1
      )
        return denied();
      const binding = await resolveLiveAgencyWorkloadByHandle(appId, credentialId);
      if (
        !binding?.environmentBound ||
        binding.ownerAccountId !== ownerAccountId ||
        binding.environment !== environment
      )
        return denied();
      const caller = {
        authority: 'first_party' as const,
        applicationId: appId,
        credentialId,
        ownerAccountId,
        capabilities: binding.capabilities,
      };
      const previous =
        typeof presentedContext === 'string'
          ? await resolveRequesterContext(presentedContext, caller)
          : null;
      const task = taskId ? await resolveFirstPartyTask(taskId, caller) : null;
      const requester =
        previous?.binding ??
        (task
          ? (await taskAllowsEffectiveAccount(task, userId, {
              type: task.actorType,
              accountId: task.actorAccountId ?? undefined,
            }))
            ? {
                subjectAccountId: userId,
                principalAccountId: task.requesterAccountId,
                sessionId: task.requesterSessionId,
                digest: task.requesterSessionBindingDigest,
                expiresAt: task.expiresAt,
              }
            : null
          : typeof requesterToken === 'string'
            ? await validateForegroundRequesterBearer(requesterToken, caller)
            : null);
      if (!requester || requester.subjectAccountId !== userId) return denied();
      let requesterContext: string | null = null;
      if (presentedToken !== undefined) {
        const received =
          typeof presentedToken === 'string'
            ? verifyServiceToken(presentedToken, `oxy-service:${req.serviceApp.appId}`)
            : null;
        if (
          !received?.ok ||
          received.payload.authority !== 'first_party' ||
          received.payload.appId !== appId ||
          received.payload.credentialId !== credentialId ||
          received.payload.ownerAccountId !== ownerAccountId ||
          received.payload.environment !== environment ||
          typeof received.payload.exp !== 'number'
        )
          return denied();
        const receiver = await resolveLiveAgencyServicePrincipal(req.serviceApp);
        if (!receiver) return denied();
        requesterContext = await issueRequesterContext({
          caller,
          receiver,
          binding: {
            ...requester,
            expiresAt: new Date(
              Math.min(requester.expiresAt.getTime(), received.payload.exp * 1000),
            ),
          },
          source:
            previous?.claims.source ??
            (task
              ? { kind: 'task', taskId: task.id }
              : { kind: 'session', sessionId: requester.sessionId, digest: requester.digest }),
          actor:
            previous?.claims.actor ??
            (task
              ? { type: task.actorType, accountId: task.actorAccountId ?? undefined }
              : { type: 'requester', accountId: requester.principalAccountId }),
          ...(previous ? { previous: previous.claims } : {}),
        });
        if (!requesterContext) return denied();
      } else if (presentedContext !== undefined) return denied();
      const [generation] = await getDb()
        .select({ epoch: serviceActingAsAuthorityEpochs.epoch })
        .from(serviceActingAsAuthorityEpochs)
        .where(
          and(
            eq(serviceActingAsAuthorityEpochs.userId, userId),
            eq(serviceActingAsAuthorityEpochs.applicationId, appId),
          ),
        )
        .limit(1);
      return sendSuccess(res, {
        authorized: true,
        authority: 'first_party',
        epoch: generation?.epoch.toString() ?? '0',
        ...(requesterContext ? { requesterContext } : {}),
      });
    }
    const anyCredentialContext =
      credentialId !== undefined || ownerAccountId !== undefined || environment !== undefined;
    const grant =
      anyCredentialContext && (!credentialId || !ownerAccountId || !environment)
        ? { authorized: false, scopes: [], epoch: '0' }
        : await resolveServiceActingAsGrant(
            appId,
            userId,
            credentialId && ownerAccountId && environment
              ? { credentialId, ownerAccountId, environment }
              : undefined,
          );

    // Logged on both outcomes. A record of who asked about whom is what makes
    // the disclosure this endpoint accepts auditable, and logging only refusals
    // would leave every successful delegation invisible.
    logger.info('[internal] service-acting-as verify', {
      callerAppId: req.serviceApp?.appId,
      subjectAppId: appId,
      authorized: grant.authorized,
    });

    sendSuccess(res, grant);
  }),
);

/**
 * Keyed on the CALLING application, with the same fail-closed `unknown` bucket
 * as every limiter here. No caller caches the answer (each publish asks), so
 * the number is sized for a long import publishing one post per call: 600 a
 * minute is ten a second per application, above a healthy import's pace and far
 * below what sweeping the account graph for channel members would need.
 */
const accountAccessLimiter = rateLimit({
  prefix: 'rl:internal:account-access:',
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator: (req) => (req as ServiceAuthRequest).serviceApp?.appId ?? 'unknown',
});

/**
 * Bounded, never format-checked, for the reason the verify query's ids are: two
 * live id shapes (legacy 24-hex and uuid v7), and nothing longer reaches a query.
 */
const accountAccessParams = z.object({
  accountId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(128),
});

/**
 * `GET /internal/accounts/:accountId/access/:userId`
 *
 * May `userId` act FOR `accountId`, and with what? The service-lane twin of the
 * membership checks an app makes with the person's own bearer
 * (`GET /accounts/:id/members`), for a caller that has no such bearer: Oxy Move
 * imports for hours on a service token and `X-Oxy-User-Id`, and that router
 * refuses both.
 *
 * It is what keeps the channel invariant intact rather than an exception to it.
 * Nobody acts AS a channel (`isDelegatedActAsEligibleKind`); an app publishes to
 * one with ITS OWN credential, on behalf of a member Oxy vouches for HERE. So no
 * session, grant or bearer comes out of this — only the answer.
 *
 * ## The answer is the one every other membership check reads
 *
 * `accountService.effectiveAccessForAccount` — the resolution behind
 * `requireAccountPermission`, `verifyActingAs` and the members roster — so this
 * cannot disagree with the user-facing lane about the same person: an inherited
 * membership counts, an invited or removed one does not, a per-member revoke is
 * honoured in `permissions`, a personal account is its own owner, and an
 * unclaimed directory account grants nobody anything.
 *
 * ## Always 200
 *
 * `{ accountId, kind, access }`. `access` is `null` for no active membership,
 * an archived account, an unknown account and an unclaimed directory account,
 * so a caller learns "no" and nothing about why. `kind` is `null` only when the
 * account does not exist — the same existence disclosure, to the same
 * staff-controlled audience, that `service-switch` accepts and records below.
 *
 * Not cached here, and the SDK does not cache it either: a removed member must
 * stop being able to publish on the next call, not on the next TTL.
 */
router.get(
  '/accounts/:accountId/access/:userId',
  accountAccessLimiter,
  validate({ params: accountAccessParams }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    const serviceApp = req.serviceApp;
    if (!serviceApp) {
      throw new UnauthorizedError('Service authentication required');
    }
    if (!hasServiceAuthority(serviceApp, ACCOUNT_MEMBERSHIP_READ_SCOPE)) {
      throw new ForbiddenError(`This endpoint requires the ${ACCOUNT_MEMBERSHIP_READ_SCOPE} scope`);
    }

    // The person asked about is the would-be OPERATOR: the human who acts for
    // the account, never its subject. Named so, as every access resolution is.
    const { accountId, userId: operatorId } = accountAccessParams.parse(req.params);
    const [account] = await getDb()
      .select({ id: users.id, kind: users.kind, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);

    const resolved =
      account && account.accountStatus !== 'archived'
        ? await accountService.effectiveAccessForAccount(operatorId, account)
        : null;

    const verdict: AccountAccessVerdict = {
      accountId,
      kind: account?.kind ?? null,
      access: resolved
        ? {
            role: resolved.role,
            permissions: [...resolved.permissions],
            status: 'active',
            source: resolved.source,
          }
        : null,
    };

    // Logged on both outcomes, and never with the person asked about: a log of
    // who is behind which channel would be the disclosure this scope guards.
    logger.info('[internal] account access verdict', {
      callerAppId: serviceApp.appId,
      accountId,
      authorized: verdict.access !== null,
    });

    sendSuccess(res, verdict);
  }),
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
 * possible because this API carries two live id shapes (legacy 24-hex ids and
 * uuid v7). `z.string()` also rejects the array
 * Express produces from a repeated header, rather than letting a comma-joined
 * value fall through to a lookup that would merely miss.
 */
const serviceAccountSwitchOperator = z.string().trim().min(1).max(128);

/**
 * Mint a managed-account session for a verified own workload and original
 * requester. Shared-session/task proof supplies the operator; live account:act_as
 * membership and eligible target kind still govern the switch. Tasks additionally
 * bind the target to their original effective account or exact self bot.
 *
 * External credentials cannot mint shared sessions. Only the inventoried legacy
 * workload cohort retains its old scoped/granted path during the fleet migration.
 * The minted session records operatedByUserId so membership revocation remains
 * effective on validation/refresh. No browser device registration is created.
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

    if (serviceApp.authority !== 'first_party') {
      const workload = await resolveLiveAgencyWorkloadByHandle(
        serviceApp.appId,
        serviceApp.credentialId,
      );
      if (
        !workload ||
        !isLegacyWorkloadCohort({
          id: workload.bindingId,
          applicationId: workload.applicationId,
          provider: workload.provider,
          subject: workload.subject,
        })
      ) {
        throw new ForbiddenError('External credentials cannot mint shared Oxy sessions.');
      }
    }
    if (!hasServiceAuthority(serviceApp, SERVICE_ACCOUNT_SWITCH_SCOPE)) {
      throw new ForbiddenError(`This endpoint requires the ${SERVICE_ACCOUNT_SWITCH_SCOPE} scope`);
    }

    if (req.serviceRequester?.operation || req.serviceRequester?.forwardedContext)
      throw new ForbiddenError('Operation context cannot mint shared sessions.');
    const operator = serviceAccountSwitchOperator.safeParse(
      serviceApp.authority === 'first_party'
        ? req.serviceRequester?.principalAccountId
        : req.headers['x-oxy-user-id'],
    );
    if (!operator.success) {
      throw new BadRequestError(
        'Verified requester session or task proof is required for this account switch.',
      );
    }
    const operatorId = operator.data;
    const accountId = req.params.id;
    if (
      serviceApp.authority === 'first_party' &&
      typeof req.headers['x-oxy-task-id'] === 'string'
    ) {
      const task = await resolveFirstPartyTask(req.headers['x-oxy-task-id'], {
        applicationId: serviceApp.appId,
        credentialId: serviceApp.credentialId,
      });
      if (
        !task ||
        !(await taskAllowsEffectiveAccount(task, accountId, {
          type: task.actorType,
          accountId: task.actorAccountId ?? undefined,
        }))
      )
        throw new ForbiddenError('The switch target is outside the original task.');
    }

    // The finite legacy cohort retains its original scoped delegation checks.
    // Own workload authority comes from the verified requester proof above.
    const grant =
      serviceApp.authority === 'first_party'
        ? { authorized: true }
        : await resolveServiceActingAsGrant(serviceApp.appId, operatorId, {
            credentialId: serviceApp.credentialId,
            ownerAccountId: serviceApp.ownerAccountId,
            environment: serviceApp.environment,
          });
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

    if (!isDelegatedActAsEligibleKind(account.kind)) {
      throw new ForbiddenError(`Cannot act as a ${account.kind} account`);
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
  }),
);

export default router;
