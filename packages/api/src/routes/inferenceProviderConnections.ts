/**
 * The BYOK control plane's HTTP surface (issue #972, workstream 10).
 *
 * Mounted at `/inference/provider-connections`. A customer registers their own
 * upstream provider credential; Oxy keeps a reference to it and the metadata
 * around it, and hands the reference to the data plane at serving time. Nothing
 * here returns a credential, and nothing here can: every response body is
 * `providerConnectionSchema` from `@oxyhq/contracts`, which is `.strict()` and
 * declares no field one could occupy.
 *
 * ## Two principals, the same two lanes the routing policies use
 *
 * A user bearer is authorised through the account graph
 * (`resolveCallerAccountAccess` / `resolveCallerApplicationAccess`); a service
 * token is authorised by `inference:providers:read` / `inference:providers:write`
 * intersected with its application's own scopes at mint time, and may only ever
 * reach ITS OWN application's or owner account's connections.
 * `inference:providers:write` is STAFF-GATED (`PRIVILEGED_APPLICATION_SCOPES`),
 * which is deliberate and is the reason a service credential can manage BYOK at
 * all: it is the scope whose misuse redirects other people's requests and the
 * secrets used to serve them.
 *
 * The dispatch is byte-for-byte the arrangement in `inferenceRoutingPolicies.ts`
 * and defines no third parsing path.
 *
 * ## Order of checks on a write, and why it is this order
 *
 * 1. **Authorise.** A caller with no authority gets 403 or 404 — never a 503
 *    that tells them what this deployment is configured with.
 * 2. **Resolve the secret store.** With none configured the request is refused
 *    HERE, `503 provider_secret_store_unavailable`, before step 3.
 * 3. **Read the credential out of the body.**
 *
 * Step 2 before step 3 is the whole point: in a deployment with no secret
 * backend — which is every deployment today — a customer credential is never
 * read out of a request at all. See `services/providerSecretStore.ts` for what
 * is and is not wired, and what would wire it.
 *
 * ## Not found, not forbidden
 *
 * Another account's connection answers 404, never 403. Distinguishing them makes
 * the id space an existence oracle for other tenants' BYOK setup.
 */

import { Router, type Response } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimiter';
import { validate } from '../middleware/validate';
import { verifyServiceToken, type ServiceTokenPayload } from '../middleware/serviceToken';
import {
  providerConnectionAccountBody,
  providerConnectionAccountParams,
  providerConnectionApplicationParams,
  providerConnectionAuditQuery,
  providerConnectionEffectiveQuery,
  providerConnectionEmptyBody,
  providerConnectionParams,
  providerConnectionRotateBody,
  providerConnectionValidationBody,
  providerCredentialBody,
} from '../schemas/inferenceProviderConnection.schemas';
import {
  resolveApplicationOwnerAccount,
  resolveCallerAccountAccess,
  resolveCallerApplicationAccess,
} from '../services/attribution.service';
import {
  createProviderConnection,
  disableProviderConnection,
  enableProviderConnection,
  getProviderConnectionRow,
  listProviderConnectionAuditEvents,
  listProviderConnectionsForAccount,
  recordProviderConnectionUse,
  recordProviderConnectionValidation,
  resolveProviderConnectionForApplication,
  revokeProviderConnection,
  rotateProviderConnection,
  toProviderConnection,
  type CreateProviderConnectionResult,
  type ProviderConnectionStatusResult,
} from '../services/inferenceProviderConnection.service';
import {
  ProviderSecretStoreUnavailableError,
  ProviderSecretValue,
  requireProviderSecretStore,
  resolveProviderSecretStore,
  type ProviderSecretStore,
} from '../services/providerSecretStore';
import type { InferenceProviderConnectionRow } from '../db/schema/inferenceProviderConnections';
import { asyncHandler } from '../utils/asyncHandler';
import {
  ApiError,
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
const providerReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  prefix: 'rl:inference:providers:read:',
});

const providerWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  prefix: 'rl:inference:providers:write:',
});

/* -------------------------------------------------------------------------- */
/*  Principals                                                                */
/* -------------------------------------------------------------------------- */

type ProviderPrincipal =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'service'; readonly service: ServiceTokenPayload };

interface ProviderRequest extends AuthRequest {
  serviceApp?: ServiceTokenPayload;
}

type ProviderScope = 'inference:providers:read' | 'inference:providers:write';

/**
 * Dispatch between the package's two existing verifiers, adding no third. A
 * bearer that is not a valid service token falls through to `authMiddleware`,
 * which produces the 401 — so an expired user token is answered by the
 * middleware that understands user tokens.
 */
const providerConnectionPrincipal = (
  req: ProviderRequest,
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

function principalOf(req: ProviderRequest): ProviderPrincipal {
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
 * The user id a write is attributed to.
 *
 * A service token has no person behind it, so its writes are attributed to the
 * account that owns the calling application — the principal that IS responsible
 * for them (ADR 0007). Deliberately not a delegated `X-Oxy-User-Id`: an end user
 * an application acted for did not register a BYOK credential.
 */
function authorOf(principal: ProviderPrincipal): string {
  return principal.kind === 'user' ? principal.userId : principal.service.ownerAccountId;
}

/* -------------------------------------------------------------------------- */
/*  Authorization                                                             */
/* -------------------------------------------------------------------------- */

/** May this principal act on `accountId`'s connections? Throws the refusal. */
async function authorizeAccount(
  principal: ProviderPrincipal,
  accountId: string,
  permission: AccountPermission,
  scope: ProviderScope
): Promise<void> {
  if (principal.kind === 'service') {
    if (!principal.service.scopes.includes(scope)) {
      throw new ForbiddenError(`This credential does not carry the ${scope} scope`);
    }
    if (principal.service.ownerAccountId !== accountId) {
      throw new NotFoundError('No provider connection is available for that account');
    }
    return;
  }

  const access = await resolveCallerAccountAccess(principal.userId, accountId);
  if (access.status === 'no-access') {
    throw new NotFoundError('No provider connection is available for that account');
  }
  if (!access.access.accountPermissions.includes(permission)) {
    throw new ForbiddenError(`This action requires the ${permission} permission`);
  }
}

/** May this principal act on `applicationId`'s connections? Throws the refusal. */
async function authorizeApplication(
  principal: ProviderPrincipal,
  applicationId: string,
  permission: ApplicationPermission,
  scope: ProviderScope
): Promise<void> {
  if (principal.kind === 'service') {
    if (!principal.service.scopes.includes(scope)) {
      throw new ForbiddenError(`This credential does not carry the ${scope} scope`);
    }
    // A service token reaches only its OWN application. Without this, any
    // credential holding the scope could read or repoint any tenant's BYOK.
    if (principal.service.appId !== applicationId) {
      throw new NotFoundError('No provider connection is available for that application');
    }
    return;
  }

  const access = await resolveCallerApplicationAccess(principal.userId, applicationId);
  if (access.status === 'unknown-application' || access.status === 'no-access') {
    // Same answer either way: distinguishing them would make this an existence
    // oracle for other accounts' applications.
    throw new NotFoundError('No provider connection is available for that application');
  }
  if (!access.access.access.applicationPermissions.includes(permission)) {
    throw new ForbiddenError(`This action requires the ${permission} permission`);
  }
}

/**
 * Authorise reaching an EXISTING connection, whichever scope it is on.
 *
 * Reads the row first because its scope decides which permission applies, and
 * answers 404 for a connection the caller may not see.
 */
async function authorizeConnection(
  principal: ProviderPrincipal,
  connectionId: string,
  permissions: { readonly application: ApplicationPermission; readonly account: AccountPermission },
  scope: ProviderScope
): Promise<InferenceProviderConnectionRow> {
  const row = await getProviderConnectionRow(connectionId);
  if (row === undefined) {
    throw new NotFoundError('No such provider connection');
  }

  if (row.scopeKind === 'application' && row.applicationId !== null) {
    await authorizeApplication(principal, row.applicationId, permissions.application, scope);
  } else {
    await authorizeAccount(principal, row.ownerAccountId, permissions.account, scope);
  }

  return row;
}

/* -------------------------------------------------------------------------- */
/*  Secret store                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The store, or a 503 naming the reason.
 *
 * Called BEFORE the body is read on every path that would accept a credential.
 * `503` rather than `500` or `400`: nothing is wrong with the request, and the
 * condition is expected to change — the same shape the inference edge uses when
 * its data plane is absent (`service_unavailable`, `utils/inferenceEdgeErrors.ts`).
 *
 * It is the SHAPE that is shared, not the envelope, and that is deliberate: the
 * edge's `{code, retryable, …}` body is the `/v1` data-plane wire contract ADR
 * 0010 defines, and this is a control-plane route answering in the API's own
 * `{error, message, details}` envelope like every other route under
 * `/inference/*`. Importing `inferenceEdgeErrors` here would put a public-API
 * contract on a Console endpoint that is not part of it.
 */
function providerSecretStoreOr503(): ProviderSecretStore {
  try {
    return requireProviderSecretStore();
  } catch (error) {
    if (error instanceof ProviderSecretStoreUnavailableError) {
      // `error.code` is the machine-readable half a client branches on; the
      // `reason` says which of the three unavailable states it is, so an
      // operator reading a support ticket knows whether to set a variable, fix a
      // typo, or ship a build with a client in it.
      throw new ApiError(503, error.message, error.code, { reason: error.resolution.status });
    }
    throw error;
  }
}

/** Turn the service's own refusals into the HTTP answers they mean. */
function respondToCreate(res: Response, result: CreateProviderConnectionResult): void {
  switch (result.status) {
    case 'created':
      res.status(201).json({ data: result.connection });
      return;
    case 'unknown-provider':
      throw new BadRequestError(
        `Oxy does not serve ${result.provider}, so it cannot hold a connection for it`
      );
    case 'terms-not-acknowledged':
      throw new BadRequestError(
        `${result.provider} requires each customer to accept its own terms before a third ` +
          'party may present their credential. BYOK does not override those terms and does not ' +
          'permit sharing a credential; acknowledge them to continue.',
        { termsUrl: result.termsUrl }
      );
    case 'scope-taken':
      throw new ConflictError(
        'This scope already has a live connection for that provider and environment; ' +
          'rotate it, or disable it first'
      );
    case 'scope-mismatch':
      throw new BadRequestError('An application-scoped connection must name an application');
  }
}

/** Turn a lifecycle transition's result into its HTTP answer. */
function respondToTransition(res: Response, result: ProviderConnectionStatusResult): void {
  switch (result.status) {
    case 'updated':
      res.json({ data: result.connection });
      return;
    case 'unknown-connection':
      throw new NotFoundError('No such provider connection');
    case 'revoked':
      throw new ConflictError('This connection is revoked and can no longer be changed');
    case 'already':
      throw new ConflictError(`This connection is already ${result.current}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Routes                                                                    */
/* -------------------------------------------------------------------------- */

router.use(providerConnectionPrincipal);

/*
 * ORDER MATTERS. `/accounts/…` and `/applications/…` are registered BEFORE
 * `/:connectionId`, or Express captures the literal `accounts` as a connection
 * id and every scoped read 404s against a connection that does not exist. Same
 * trap the bulk-follow routes record.
 */

/**
 * `GET /inference/provider-connections/accounts/:accountId`
 *
 * Every connection the account owns. Prefixes, fingerprints and validation
 * state; no credential, by construction.
 */
router.get(
  '/accounts/:accountId',
  providerReadLimiter,
  validate({ params: providerConnectionAccountParams }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { accountId } = providerConnectionAccountParams.parse(req.params);
    await authorizeAccount(
      principalOf(req),
      accountId,
      'account:read',
      'inference:providers:read'
    );

    const connections = await listProviderConnectionsForAccount(accountId);
    res.json({ data: connections, count: connections.length });
  })
);

/**
 * `POST /inference/provider-connections/accounts/:accountId`
 *
 * Register a credential at account or project scope. The store is resolved
 * before the body is read — see the module header.
 */
router.post(
  '/accounts/:accountId',
  providerWriteLimiter,
  validate({ params: providerConnectionAccountParams, body: providerConnectionAccountBody }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { accountId } = providerConnectionAccountParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeAccount(principal, accountId, 'account:update', 'inference:providers:write');

    const store = providerSecretStoreOr503();
    const body = providerConnectionAccountBody.parse(req.body);

    const result = await createProviderConnection(
      {
        provider: body.provider,
        ownerAccountId: accountId,
        scopeKind: body.scope,
        environment: body.environment,
        secret: new ProviderSecretValue(body.secret),
        acknowledgeProviderTerms: body.acknowledgeProviderTerms,
        actorUserId: authorOf(principal),
      },
      store
    );
    respondToCreate(res, result);
  })
);

/**
 * `GET /inference/provider-connections/applications/:applicationId`
 *
 * The connection IN FORCE for an application, and where it came from —
 * the application's own, its account's, or an ancestor account's. This is the
 * read the data plane performs before serving, which is why a SERVICE principal
 * resolving a live connection also records a `used` audit event and a user
 * reading the same thing in Console does not.
 */
router.get(
  '/applications/:applicationId',
  providerReadLimiter,
  validate({
    params: providerConnectionApplicationParams,
    query: providerConnectionEffectiveQuery,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { applicationId } = providerConnectionApplicationParams.parse(req.params);
    const { provider, environment } = providerConnectionEffectiveQuery.parse(req.query);
    const principal = principalOf(req);
    await authorizeApplication(principal, applicationId, 'app:read', 'inference:providers:read');

    const resolution = await resolveProviderConnectionForApplication({
      applicationId,
      provider,
      environment,
    });
    if (resolution.status === 'unknown-application') {
      throw new NotFoundError('No provider connection is available for that application');
    }
    if (resolution.status === 'none') {
      res.json({ data: null, source: null });
      return;
    }

    if (principal.kind === 'service') {
      // The reference is being handed out for serving. Cooldown-bounded and
      // best-effort — see the service's own header.
      await recordProviderConnectionUse(resolution.row);
    }
    res.json({ data: resolution.connection, source: resolution.source });
  })
);

/**
 * `POST /inference/provider-connections/applications/:applicationId`
 *
 * Register a credential scoped to one application. The owning account is
 * resolved SERVER-side from the application, never taken from the request — an
 * account id in a body would be the whole attribution chain replaced by a claim.
 */
router.post(
  '/applications/:applicationId',
  providerWriteLimiter,
  validate({ params: providerConnectionApplicationParams, body: providerCredentialBody }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { applicationId } = providerConnectionApplicationParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeApplication(
      principal,
      applicationId,
      'app:update',
      'inference:providers:write'
    );

    const owner = await resolveApplicationOwnerAccount(applicationId);
    if (owner.status === 'unknown-application') {
      throw new NotFoundError('No provider connection is available for that application');
    }

    const store = providerSecretStoreOr503();
    const body = providerCredentialBody.parse(req.body);

    const result = await createProviderConnection(
      {
        provider: body.provider,
        ownerAccountId: owner.application.ownerAccountId,
        scopeKind: 'application',
        applicationId,
        environment: body.environment,
        secret: new ProviderSecretValue(body.secret),
        acknowledgeProviderTerms: body.acknowledgeProviderTerms,
        actorUserId: authorOf(principal),
      },
      store
    );
    respondToCreate(res, result);
  })
);

/**
 * `POST /inference/provider-connections/:connectionId/rotate`
 *
 * Replace the credential. The reference is unchanged, so a data plane holding it
 * keeps working and the previous credential is gone the instant the store write
 * lands.
 */
router.post(
  '/:connectionId/rotate',
  providerWriteLimiter,
  validate({ params: providerConnectionParams, body: providerConnectionRotateBody }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      { application: 'app:update', account: 'account:update' },
      'inference:providers:write'
    );

    const store = providerSecretStoreOr503();
    const body = providerConnectionRotateBody.parse(req.body);

    const result = await rotateProviderConnection(
      {
        connectionId,
        secret: new ProviderSecretValue(body.secret),
        actorUserId: authorOf(principal),
      },
      store
    );
    switch (result.status) {
      case 'rotated':
        res.json({ data: result.connection });
        return;
      case 'unknown-connection':
        throw new NotFoundError('No such provider connection');
      case 'revoked':
        throw new ConflictError('This connection is revoked and can no longer be rotated');
      case 'unchanged-credential':
        throw new ConflictError(
          'That is the credential this connection already holds; a rotation must supply a new one'
        );
    }
  })
);

/**
 * `POST /inference/provider-connections/:connectionId/disable`
 *
 * Immediate and reversible. Pure database work — no store round trip — so
 * "immediate" does not depend on the availability of the thing being stopped.
 */
router.post(
  '/:connectionId/disable',
  providerWriteLimiter,
  validate({ params: providerConnectionParams, body: providerConnectionEmptyBody }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      { application: 'app:update', account: 'account:update' },
      'inference:providers:write'
    );

    respondToTransition(
      res,
      await disableProviderConnection({ connectionId, actorUserId: authorOf(principal) })
    );
  })
);

/** `POST /inference/provider-connections/:connectionId/enable` — undo a disable. */
router.post(
  '/:connectionId/enable',
  providerWriteLimiter,
  validate({ params: providerConnectionParams, body: providerConnectionEmptyBody }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      { application: 'app:update', account: 'account:update' },
      'inference:providers:write'
    );

    respondToTransition(
      res,
      await enableProviderConnection({ connectionId, actorUserId: authorOf(principal) })
    );
  })
);

/**
 * `POST /inference/provider-connections/:connectionId/revoke`
 *
 * Terminal, and it destroys the stored credential. A destroy failure does NOT
 * block the revoke — retiring a connection is a safety operation, often because
 * the key leaked — so the response and the audit row both state whether the
 * secret was actually destroyed. There is deliberately no DELETE: a deleted
 * connection would make a past charge unexplainable and would take its own audit
 * trail with it.
 */
router.post(
  '/:connectionId/revoke',
  providerWriteLimiter,
  validate({ params: providerConnectionParams, body: providerConnectionEmptyBody }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      { application: 'app:update', account: 'account:update' },
      'inference:providers:write'
    );

    // Optional here, unlike create and rotate: a deployment whose secret backend
    // has since been unconfigured must still be able to revoke. The audit row
    // then records that the secret was not destroyed, which is the true
    // statement — refusing the revoke would leave the connection resolvable.
    const resolution = resolveProviderSecretStore();
    const result = await revokeProviderConnection(
      { connectionId, actorUserId: authorOf(principal) },
      resolution.status === 'available' ? resolution.store : undefined
    );
    switch (result.status) {
      case 'revoked':
        res.json({ data: result.connection, secretDestroyed: result.secretDestroyed });
        return;
      case 'unknown-connection':
        throw new NotFoundError('No such provider connection');
      case 'already-revoked':
        throw new ConflictError('This connection is already revoked');
    }
  })
);

/**
 * `POST /inference/provider-connections/:connectionId/validation`
 *
 * Record the verdict of a credential check. The check itself runs where the
 * credential is — the data plane — because Oxy holds it for the duration of one
 * create or rotate and never fetches it back. The body is a closed vocabulary
 * with no free-form message, so a verdict can never carry credential material.
 *
 * An `invalid` or `expired` verdict also disables the connection.
 */
router.post(
  '/:connectionId/validation',
  providerWriteLimiter,
  validate({ params: providerConnectionParams, body: providerConnectionValidationBody }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      { application: 'app:update', account: 'account:update' },
      'inference:providers:write'
    );

    const verdict = providerConnectionValidationBody.parse(req.body);
    const result = await recordProviderConnectionValidation({
      connectionId,
      state: verdict.state,
      failureCode: verdict.failureCode,
      // A verdict a service token reported has no person behind it; one a member
      // asked for does.
      actorUserId: principal.kind === 'user' ? principal.userId : undefined,
    });
    switch (result.status) {
      case 'recorded':
        res.json({ data: result.connection });
        return;
      case 'unknown-connection':
        throw new NotFoundError('No such provider connection');
      case 'revoked':
        throw new ConflictError('This connection is revoked and can no longer be validated');
    }
  })
);

/**
 * `GET /inference/provider-connections/:connectionId/audit`
 *
 * The connection's trail: created, validated, rotated, used, disabled, enabled,
 * revoked. Append-only in the database, not merely by convention — see
 * `0042_inference_provider_connection_immutability.sql`.
 */
router.get(
  '/:connectionId/audit',
  providerReadLimiter,
  validate({ params: providerConnectionParams, query: providerConnectionAuditQuery }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const { limit } = providerConnectionAuditQuery.parse(req.query);
    await authorizeConnection(
      principalOf(req),
      connectionId,
      { application: 'app:read', account: 'account:read' },
      'inference:providers:read'
    );

    const events = await listProviderConnectionAuditEvents(connectionId, limit);
    res.json({ data: events, count: events.length });
  })
);

/**
 * `GET /inference/provider-connections/:connectionId`
 *
 * One connection. Registered LAST among the `/:connectionId` routes so the more
 * specific paths above are matched first.
 */
router.get(
  '/:connectionId',
  providerReadLimiter,
  validate({ params: providerConnectionParams }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const row = await authorizeConnection(
      principalOf(req),
      connectionId,
      { application: 'app:read', account: 'account:read' },
      'inference:providers:read'
    );
    res.json({ data: toProviderConnection(row) });
  })
);

export default router;
