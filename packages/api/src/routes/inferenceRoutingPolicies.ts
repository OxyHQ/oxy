/**
 * The routing policy control plane's HTTP surface (issue #972, workstream 6).
 *
 * Mounted at `/inference/routing-policies`. A customer configures which
 * providers, regions, licences, prices and fallbacks they will accept; the data
 * plane executes it (ADR 0006). Nothing here routes a request.
 *
 * ## Two principals, and neither is optional
 *
 * A routing policy is reachable by a person in Console and by a machine holding
 * a service credential, and the two are authorised differently:
 *
 *  - **A user bearer** is authorised through the account graph, by
 *    `resolveCallerApplicationAccess` / `resolveCallerAccountAccess`. An
 *    application policy needs `app:read` to read and `app:update` to write; an
 *    account policy needs `account:read` / `account:update`. Inheritance,
 *    per-member revokes and the archived-account refusal all come from
 *    `accountService.resolveEffectiveAccess`, so this cannot come to a different
 *    answer about a person than the applications routes do.
 *
 *  - **A service token** is authorised by the scope family the vocabulary
 *    already defines: `inference:routing:read` to read,
 *    `inference:routing:write` to write, intersected with the owning
 *    application's scopes at mint time. It may only ever reach ITS OWN
 *    application's policy or its owner account's — a service token is not a
 *    way around the account graph, and the ownership check below is what makes
 *    that true rather than a claim.
 *
 * The two lanes are dispatched by {@link routingPolicyPrincipal}, which composes
 * the package's two existing verifiers and defines no third one. A bearer that
 * verifies as a service token takes the service lane; anything else goes to
 * `authMiddleware` and is answered by it.
 *
 * ## Writes append; nothing is edited and nothing is deleted
 *
 * `POST /:policyId/versions` is the EDIT path, and it is a POST to a collection
 * rather than a PATCH on the policy because that is what it does: a new,
 * immutable version becomes current and the previous one stays exactly as it
 * was, so a receipt naming it still resolves. `POST /:policyId/archive` retires
 * a policy; there is no DELETE, because a `DELETE` that archives would be a lie
 * and a `DELETE` that deleted would let a customer make a past charge
 * unexplainable.
 */

import { Router, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { verifyServiceToken, type ServiceTokenPayload } from '../middleware/serviceToken';
import {
  routeSwitchQuery,
  routingPolicyAccountParams,
  routingPolicyApplicationParams,
  routingPolicyControlsBody,
  routingPolicyParams,
  routingPolicyVersionParams,
} from '../schemas/inferenceRoutingPolicy.schemas';
import {
  resolveApplicationOwnerAccount,
  resolveCallerAccountAccess,
  resolveCallerApplicationAccess,
} from '../services/attribution.service';
import {
  appendRoutingPolicyVersion,
  archiveRoutingPolicy,
  createRoutingPolicy,
  getRoutingPolicy,
  listRoutingPoliciesForAccount,
  listRoutingPolicyVersions,
  listRouteSwitchEventsForApplication,
  resolveEffectiveRoutingPolicy,
  type RoutingPolicyWriteResult,
  type StoredRoutingPolicy,
} from '../services/inferenceRoutingPolicy.service';
import { asyncHandler } from '../utils/asyncHandler';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/error';
import type { AccountPermission, ApplicationPermission } from '../utils/accountRoles';

const router = Router();

/**
 * Reads and writes get separate budgets, per the unique-prefix rule: two
 * limiters sharing one Redis key make `rate-limit-redis` throw
 * `ERR_ERL_DOUBLE_COUNT` and halve both.
 */
const routingReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  prefix: 'rl:inference:routing:read:',
});

const routingWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  prefix: 'rl:inference:routing:write:',
});

/* -------------------------------------------------------------------------- */
/*  Principals                                                                */
/* -------------------------------------------------------------------------- */

/** Which of the two lanes a request arrived on. */
type RoutingPolicyPrincipal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'service'; readonly service: ServiceTokenPayload };

/** A request that has been through {@link routingPolicyPrincipal}. */
interface RoutingRequest extends AuthRequest {
  serviceApp?: ServiceTokenPayload;
}

/**
 * Dispatch between the two existing verifiers.
 *
 * `verifyServiceToken` is the package's single source of truth for the service
 * token contract; `authMiddleware` is its single source of truth for a user
 * bearer. This function decides which one answers and adds no third parsing
 * path. A bearer that is not a valid service token falls through to
 * `authMiddleware`, which produces the 401 — so an expired user token is
 * answered by the middleware that understands user tokens.
 */
const routingPolicyPrincipal = (
  req: RoutingRequest,
  res: Response,
  next: (error?: unknown) => void
): void => {
  const header = req.headers.authorization;
  if (header !== undefined && header.startsWith('Bearer ')) {
    const verification = verifyServiceToken(header.slice('Bearer '.length));
    if (verification.ok) {
      req.serviceApp = verification.payload;
      next();
      return;
    }
  }
  void authMiddleware(req, res, next);
};

function principalOf(req: RoutingRequest): RoutingPolicyPrincipal {
  if (req.serviceApp !== undefined) {
    return { kind: 'service', service: req.serviceApp };
  }
  const userId = req.user?.id;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new UnauthorizedError('Authentication is required for this operation');
  }
  return { kind: 'user', userId };
}

/**
 * The user id a written version is attributed to.
 *
 * A service token has no person behind it, so its writes are attributed to the
 * account that owns the calling application — which is the principal that IS
 * responsible for them (ADR 0007). This is deliberately not a delegated
 * `X-Oxy-User-Id`: an end user Alia acted for did not author the policy.
 */
function authorOf(principal: RoutingPolicyPrincipal): string {
  return principal.kind === 'user' ? principal.userId : principal.service.ownerAccountId;
}

/* -------------------------------------------------------------------------- */
/*  Authorization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * May this principal act on the policy governing `applicationId`?
 *
 * Throws the answer rather than returning it, because every caller's response to
 * a refusal is identical and a boolean would make "forgot to check the result"
 * a silent authorisation.
 */
async function authorizeApplication(
  principal: RoutingPolicyPrincipal,
  applicationId: string,
  permission: ApplicationPermission,
  scope: 'inference:routing:read' | 'inference:routing:write'
): Promise<void> {
  if (principal.kind === 'service') {
    if (!principal.service.scopes.includes(scope)) {
      throw new ForbiddenError(`This credential does not carry the ${scope} scope`);
    }
    // A service token reaches only its OWN application. Without this, any
    // credential holding the scope could read or repoint any tenant's routing.
    if (principal.service.appId !== applicationId) {
      throw new NotFoundError('No routing policy is available for that application');
    }
    return;
  }

  const access = await resolveCallerApplicationAccess(principal.userId, applicationId);
  if (access.status === 'unknown-application') {
    throw new NotFoundError('No routing policy is available for that application');
  }
  if (access.status === 'no-access') {
    // Same answer as an unknown application: distinguishing them would make this
    // an existence oracle for other accounts' applications.
    throw new NotFoundError('No routing policy is available for that application');
  }
  if (!access.access.access.applicationPermissions.includes(permission)) {
    throw new ForbiddenError(`This action requires the ${permission} permission`);
  }
}

/** May this principal act on the policy governing `accountId`? */
async function authorizeAccount(
  principal: RoutingPolicyPrincipal,
  accountId: string,
  permission: AccountPermission,
  scope: 'inference:routing:read' | 'inference:routing:write'
): Promise<void> {
  if (principal.kind === 'service') {
    if (!principal.service.scopes.includes(scope)) {
      throw new ForbiddenError(`This credential does not carry the ${scope} scope`);
    }
    if (principal.service.ownerAccountId !== accountId) {
      throw new NotFoundError('No routing policy is available for that account');
    }
    return;
  }

  const access = await resolveCallerAccountAccess(principal.userId, accountId);
  if (access.status === 'no-access') {
    throw new NotFoundError('No routing policy is available for that account');
  }
  if (!access.access.accountPermissions.includes(permission)) {
    throw new ForbiddenError(`This action requires the ${permission} permission`);
  }
}

/**
 * Authorise reaching an EXISTING policy, whichever scope it is on.
 *
 * Reads the policy first because its scope decides which permission applies —
 * and answers 404 for a policy the caller may not see, so the id space is not
 * an oracle.
 */
async function authorizePolicy(
  principal: RoutingPolicyPrincipal,
  policyId: string,
  permissions: { readonly application: ApplicationPermission; readonly account: AccountPermission },
  scope: 'inference:routing:read' | 'inference:routing:write'
): Promise<StoredRoutingPolicy> {
  const stored = await getRoutingPolicy(policyId);
  if (stored === undefined) {
    throw new NotFoundError('No such routing policy');
  }

  if (stored.policy.scope.kind === 'application') {
    await authorizeApplication(
      principal,
      stored.policy.scope.applicationId,
      permissions.application,
      scope
    );
  } else {
    await authorizeAccount(principal, stored.policy.scope.accountId, permissions.account, scope);
  }

  return stored;
}

/* -------------------------------------------------------------------------- */
/*  Write result translation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Turn the service's own refusals into the HTTP answers they mean.
 *
 * `invalid` is a 400 carrying the contract's own issue list, so a customer sees
 * exactly which control contradicts which — the refinement already produces that
 * text and rewording it here would give two different explanations of one rule.
 */
function respondToWrite(res: Response, result: RoutingPolicyWriteResult, status: number): void {
  switch (result.status) {
    case 'written':
      res.status(status).json({ data: result.policy });
      return;
    case 'invalid':
      throw new BadRequestError('This routing policy is contradictory', {
        issues: result.issues,
      });
    case 'unknown-catalogue-reference':
      throw new BadRequestError(
        `Oxy does not serve ${result.reference}, so it cannot be named by a routing policy`
      );
    case 'unknown-policy':
      throw new NotFoundError('No such routing policy');
    case 'archived-policy':
      throw new ConflictError('This routing policy is archived and can no longer be edited');
    case 'scope-taken':
      throw new ConflictError(
        'This scope already has an active routing policy; edit it or archive it first'
      );
  }
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

router.use(routingPolicyPrincipal);

/*
 * ORDER MATTERS. `/accounts/…` and `/applications/…` are registered BEFORE
 * `/:policyId`, or Express captures the literal `accounts` as a policy id and
 * every scoped read 404s against a policy that does not exist. Same trap the
 * bulk-follow routes record.
 */

/**
 * `GET /inference/routing-policies/accounts/:accountId`
 *
 * Every ACTIVE policy the account owns — its own account-scoped one and the
 * application-scoped ones belonging to applications it owns.
 */
router.get(
  '/accounts/:accountId',
  routingReadLimiter,
  validate({ params: routingPolicyAccountParams }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { accountId } = routingPolicyAccountParams.parse(req.params);
    await authorizeAccount(principalOf(req), accountId, 'account:read', 'inference:routing:read');

    const policies = await listRoutingPoliciesForAccount(accountId);
    res.json({ data: policies, count: policies.length });
  })
);

/**
 * `POST /inference/routing-policies/accounts/:accountId`
 *
 * Create the account-scoped policy — the floor the account's applications
 * inherit when they have none of their own.
 */
router.post(
  '/accounts/:accountId',
  routingWriteLimiter,
  validate({ params: routingPolicyAccountParams, body: routingPolicyControlsBody }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { accountId } = routingPolicyAccountParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeAccount(principal, accountId, 'account:update', 'inference:routing:write');

    const controls = routingPolicyControlsBody.parse(req.body);
    const result = await createRoutingPolicy({
      target: { kind: 'account', accountId },
      controls,
      createdByUserId: authorOf(principal),
    });
    respondToWrite(res, result, 201);
  })
);

/**
 * `GET /inference/routing-policies/applications/:applicationId`
 *
 * The policy IN FORCE for an application, and where it came from. `source`
 * distinguishes the application's own policy from the account floor it
 * inherited, which is the question a customer debugging a route actually asks.
 */
router.get(
  '/applications/:applicationId',
  routingReadLimiter,
  validate({ params: routingPolicyApplicationParams }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { applicationId } = routingPolicyApplicationParams.parse(req.params);
    await authorizeApplication(
      principalOf(req),
      applicationId,
      'app:read',
      'inference:routing:read'
    );

    const resolution = await resolveEffectiveRoutingPolicy(applicationId);
    if (resolution.status === 'unknown-application') {
      throw new NotFoundError('No routing policy is available for that application');
    }
    if (resolution.status === 'none') {
      res.json({ data: null, source: null });
      return;
    }
    res.json({ data: resolution.stored, source: resolution.source });
  })
);

/**
 * `POST /inference/routing-policies/applications/:applicationId`
 *
 * Create the application's own policy. It wins over the account floor from the
 * moment it exists.
 */
router.post(
  '/applications/:applicationId',
  routingWriteLimiter,
  validate({ params: routingPolicyApplicationParams, body: routingPolicyControlsBody }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { applicationId } = routingPolicyApplicationParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeApplication(
      principal,
      applicationId,
      'app:update',
      'inference:routing:write'
    );

    // The owning account is resolved SERVER-side from the application, never
    // taken from the request. An account id in a body would be the whole
    // attribution chain replaced by a claim.
    const owner = await resolveApplicationOwnerAccount(applicationId);
    if (owner.status === 'unknown-application') {
      throw new NotFoundError('No routing policy is available for that application');
    }

    const controls = routingPolicyControlsBody.parse(req.body);
    const result = await createRoutingPolicy({
      target: {
        kind: 'application',
        accountId: owner.application.ownerAccountId,
        applicationId,
      },
      controls,
      createdByUserId: authorOf(principal),
    });
    respondToWrite(res, result, 201);
  })
);

/**
 * `GET /inference/routing-policies/applications/:applicationId/route-switches`
 *
 * The customer-visible record of every allowed route switch on this
 * application's requests. A cross-model entry exists only where the customer's
 * own policy authorised that destination by name — the persisted row cannot be
 * written otherwise.
 */
router.get(
  '/applications/:applicationId/route-switches',
  routingReadLimiter,
  validate({ params: routingPolicyApplicationParams, query: routeSwitchQuery }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { applicationId } = routingPolicyApplicationParams.parse(req.params);
    const { limit } = routeSwitchQuery.parse(req.query);
    await authorizeApplication(
      principalOf(req),
      applicationId,
      'usage:read',
      'inference:routing:read'
    );

    const events = await listRouteSwitchEventsForApplication(applicationId, limit);
    res.json({ data: events, count: events.length });
  })
);

/**
 * `GET /inference/routing-policies/:policyId/versions`
 *
 * Every version, newest first. This is the audit trail a charge is explained
 * against: a receipt names a version, and this is where that version's
 * constraints are read from.
 */
router.get(
  '/:policyId/versions',
  routingReadLimiter,
  validate({ params: routingPolicyParams }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { policyId } = routingPolicyParams.parse(req.params);
    await authorizePolicy(
      principalOf(req),
      policyId,
      { application: 'app:read', account: 'account:read' },
      'inference:routing:read'
    );

    const versions = await listRoutingPolicyVersions(policyId);
    res.json({ data: versions, count: versions.length });
  })
);

/**
 * `POST /inference/routing-policies/:policyId/versions`
 *
 * The EDIT path. Appends the next version and makes it current; the previous one
 * is left byte-for-byte as it was, which is what lets a settled receipt still
 * name the configuration that produced it.
 */
router.post(
  '/:policyId/versions',
  routingWriteLimiter,
  validate({ params: routingPolicyParams, body: routingPolicyControlsBody }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { policyId } = routingPolicyParams.parse(req.params);
    const principal = principalOf(req);
    await authorizePolicy(
      principal,
      policyId,
      { application: 'app:update', account: 'account:update' },
      'inference:routing:write'
    );

    const controls = routingPolicyControlsBody.parse(req.body);
    const result = await appendRoutingPolicyVersion({
      routingPolicyId: policyId,
      controls,
      createdByUserId: authorOf(principal),
    });
    respondToWrite(res, result, 201);
  })
);

/**
 * `GET /inference/routing-policies/:policyId/versions/:policyVersion`
 *
 * One historical version by number — the read a receipt's
 * `{routingPolicyId, policyVersion}` reference resolves through.
 */
router.get(
  '/:policyId/versions/:policyVersion',
  routingReadLimiter,
  validate({ params: routingPolicyVersionParams }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { policyId, policyVersion } = routingPolicyVersionParams.parse(req.params);
    await authorizePolicy(
      principalOf(req),
      policyId,
      { application: 'app:read', account: 'account:read' },
      'inference:routing:read'
    );

    const stored = await getRoutingPolicy(policyId, policyVersion);
    if (stored === undefined) {
      throw new NotFoundError('No such routing policy version');
    }
    res.json({ data: stored });
  })
);

/**
 * `POST /inference/routing-policies/:policyId/archive`
 *
 * Retire a policy. There is deliberately no DELETE — see this module's header.
 */
router.post(
  '/:policyId/archive',
  routingWriteLimiter,
  validate({ params: routingPolicyParams, body: z.object({}).strict() }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { policyId } = routingPolicyParams.parse(req.params);
    await authorizePolicy(
      principalOf(req),
      policyId,
      { application: 'app:update', account: 'account:update' },
      'inference:routing:write'
    );

    const result = await archiveRoutingPolicy(policyId);
    if (result.status === 'unknown-policy') {
      throw new NotFoundError('No such routing policy');
    }
    if (result.status === 'already-archived') {
      throw new ConflictError('This routing policy is already archived');
    }
    res.json({ data: { routingPolicyId: result.routingPolicyId, status: 'archived' } });
  })
);

/**
 * `GET /inference/routing-policies/:policyId`
 *
 * One policy at its current version. Registered LAST among the `/:policyId`
 * routes so the more specific paths above are matched first.
 */
router.get(
  '/:policyId',
  routingReadLimiter,
  validate({ params: routingPolicyParams }),
  asyncHandler(async (req: RoutingRequest, res: Response) => {
    const { policyId } = routingPolicyParams.parse(req.params);
    const stored = await authorizePolicy(
      principalOf(req),
      policyId,
      { application: 'app:read', account: 'account:read' },
      'inference:routing:read'
    );
    res.json({ data: stored });
  })
);

export default router;
