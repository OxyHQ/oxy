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
 * (`resolveCallerAccountAccess` / `resolveCallerApplicationAccess`), needing
 * `inference:providers:read` / `inference:providers:write` on the account lane
 * and `inference:byok:read` / `inference:byok:write` on the application lane.
 * Those replaced `account:read`/`account:update` and `app:read`/`app:update`
 * (issue #972 §3), so that rotating a provider secret is no longer the same
 * permission as changing a webhook URL: an `editor` may edit an application and
 * may not touch its BYOK, and a `viewer` no longer reads provider metadata by
 * inheriting `account:read`. Both narrowings are restorable per member through
 * `permission_grants`.
 *
 * A service token is authorised by `inference:providers:read` /
 * `inference:providers:write` intersected with its application's own scopes at
 * mint time, and may only ever reach ITS OWN application's or owner account's
 * connections — and only to READ them. **There is no write lane for a service
 * credential on this surface at all**; see {@link refuseServiceWrite} for the
 * escalation that closed it. `inference:providers:write` remains STAFF-GATED
 * (`PRIVILEGED_APPLICATION_SCOPES`) and still bounds what an application may be
 * granted, but holding it is no longer a substitute for holding the permission.
 *
 * The dispatch is byte-for-byte the arrangement in `inferenceRoutingPolicies.ts`
 * and defines no third parsing path.
 *
 * `POST /:connectionId/validation` is inside that refusal, and the consequence is
 * deliberate: the credential check runs where the credential is, so the verdict's
 * natural reporter is the data plane, and an `invalid` verdict also DISABLES the
 * connection. Leaving the lane open for it would have left a disable-equivalent
 * open to exactly the credential this refusal exists to stop. When the data plane
 * needs to report a verdict it needs a principal designed for that, not a
 * customer-mintable service token — recorded in `docs/inference/byok.md`.
 *
 * ## Order of checks on a write, and why it is this order
 *
 * 1. **Authorise.** A caller with no authority gets 403 or 404 — never a 503
 *    that tells them what this deployment is configured with.
 * 2. **Resolve the signed Kaana custody client.** With none configured the request is refused
 *    HERE, `503 kaana_credential_control_unavailable`, before step 3.
 * 3. **Read the credential out of the body.**
 *
 * Step 2 before step 3 is the whole point: without the dedicated signed Kaana
 * authority a customer credential is never
 * read out of a request at all.
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
  providerConnectionReconcileResponseSchema,
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
  reconcileProviderConnection,
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
  KaanaCredentialControlUnavailableError,
  ProviderCredentialValue,
  requireKaanaCredentialControl,
  type KaanaCredentialControl,
} from '../services/kaanaCredentialControl';
import type { InferenceProviderConnectionRow } from '../db/schema/inferenceProviderConnections';
import type { ProviderConnectionActor } from '../db/schema/inferenceProviderConnectionAuditEvents';
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
  next: (error?: unknown) => void,
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
 * Who an audit row is attributed to.
 *
 * A person and a service credential are two DIFFERENT kinds of author, and this
 * is where that stops being flattened. The previous version of this function
 * returned a bare id — the caller's `users.id` for a session principal, the
 * calling application's owning ACCOUNT id for a service token — and both landed
 * in `actor_user_id`. Since an account is a `users` row here, nothing failed and
 * nothing looked wrong: the trail simply could not tell "a member rotated this
 * connection" from "an application rotated it with a service token", which is
 * exactly what #972 workstream 12 requires it to answer. The kind is now a column
 * (`db/schema/inferenceProviderConnectionAuditEvents.ts`, "Who acted").
 *
 * The service arm carries no id, deliberately: the only id it ever had to offer
 * was the owning account's, and the authorisation above already requires that to
 * equal the connection's own `owner_account_id`, which is on the row. Still
 * deliberately not a delegated `X-Oxy-User-Id` — an end user an application acted
 * for did not register a BYOK credential.
 *
 * No write on this surface is reachable by a service credential today
 * ({@link refuseServiceWrite} refuses the lane), so this arm records what the row
 * WOULD say if that lane were ever opened, rather than what it says now. That is
 * the point: reopening the lane must not silently produce an unattributable row.
 */
function actorOf(principal: ProviderPrincipal): ProviderConnectionActor {
  return principal.kind === 'user'
    ? { kind: 'user', userId: principal.userId }
    : { kind: 'service' };
}

/* -------------------------------------------------------------------------- */
/*  Authorization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A service credential may not change BYOK configuration. Throws the refusal.
 *
 * This is the same answer `accountBilling.ts` gives on the financially
 * equivalent surface, for the same reason: registering, rotating or destroying a
 * provider credential is a decision a person holding
 * `inference:providers:write` makes, and a machine credential that could make it
 * would put an account's provider configuration — and the secrets used to serve
 * its traffic — behind a key that lives in a deployment environment.
 *
 * ## The escalation this closes (issue #972 §3)
 *
 * The service lane used to check the SCOPE and the owner match and then return,
 * never consulting an account permission at all, while the user lane on the very
 * same function required `account:update` — which only `owner` and `admin` hold.
 * Ten lines apart, and the asymmetry was invisible. So, entirely inside one
 * tenant: a member with the `developer` role holds `credentials:create` and
 * `credentials:rotate` but not `account:update`; they mint (or rotate, which
 * copies `scopes` verbatim and re-issues a working secret) a `service` credential
 * carrying `inference:providers:write`; and with that token they register, rotate
 * and destroy provider secrets they would be refused as a signed-in user.
 *
 * Staff-gating the scope does not close it, and neither does filtering privileged
 * scopes at credential CREATE: `POST /:appId/credentials/:credId/rotate` carries
 * the previous credential's scopes forward and hands back a fresh secret, so a
 * single staff-granted credential is enough. The only thing that closes it is
 * refusing the lane, which is what this does.
 *
 * ## Why the scope is checked BEFORE this refusal
 *
 * Both checks stay live, and the refusal becomes testable only by REPRODUCING
 * the escalation — a token that reaches it is one that genuinely carries
 * `inference:providers:write`. Ordered the other way, a scopeless token would
 * trigger the refusal too, and a test could then pass without ever building the
 * credential the attack needs.
 *
 * ## It is an ALLOW-LIST, and that is the point
 *
 * The two reads below are the whole of what a service credential may ask for on
 * this surface; anything else is refused. Written as a check for the two WRITE
 * spellings it would fail OPEN for a permission added later — and the classifying
 * decision would sit at each call site, where the next person to add a write can
 * forget it. Here there is one place, and forgetting it denies rather than
 * permits. Same shape as `accountBilling.ts`, whose allow-list has one entry.
 */
const SERVICE_PERMITTED_PERMISSIONS: readonly (AccountPermission | ApplicationPermission)[] = [
  'inference:providers:read',
  'inference:byok:read',
];

function refuseServiceWrite(permission: AccountPermission | ApplicationPermission): void {
  if (!SERVICE_PERMITTED_PERMISSIONS.includes(permission)) {
    throw new ForbiddenError('A service credential may not change provider connections');
  }
}

/** May this principal act on `accountId`'s connections? Throws the refusal. */
async function authorizeAccount(
  principal: ProviderPrincipal,
  accountId: string,
  permission: AccountPermission,
  scope: ProviderScope,
): Promise<void> {
  if (principal.kind === 'service') {
    if (!principal.service.scopes.includes(scope)) {
      throw new ForbiddenError(`This credential does not carry the ${scope} scope`);
    }
    refuseServiceWrite(permission);
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
  scope: ProviderScope,
): Promise<void> {
  if (principal.kind === 'service') {
    if (!principal.service.scopes.includes(scope)) {
      throw new ForbiddenError(`This credential does not carry the ${scope} scope`);
    }
    // Same refusal as the account lane, and it has to be on both: an
    // application-scoped connection belongs to the same account and holds the
    // same kind of secret. See {@link refuseServiceWrite}.
    refuseServiceWrite(permission);
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
  permissions: {
    readonly application: ApplicationPermission;
    readonly account: AccountPermission;
  },
  scope: ProviderScope,
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
/*  Kaana credential control                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The dedicated signed Kaana control client, or a 503.
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
function kaanaCredentialControlOr503(): KaanaCredentialControl {
  try {
    return requireKaanaCredentialControl();
  } catch (error) {
    if (error instanceof KaanaCredentialControlUnavailableError) {
      throw new ApiError(503, error.message, error.code);
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
    case 'custody-reconcile':
      throw new ApiError(
        503,
        'Kaana may have accepted the credential, but Oxy could not prove the final state. The connection is quarantined for reconciliation.',
        'kaana_credential_reconcile_required',
        { connectionId: result.connectionId },
      );
    case 'custody-manual':
      throw new ConflictError(
        'Kaana recorded a conflicting credential operation. The connection remains quarantined for manual resolution.',
        { connectionId: result.connectionId },
      );
    case 'unknown-provider':
      throw new BadRequestError(
        `Oxy does not serve ${result.provider}, so it cannot hold a connection for it`,
      );
    case 'terms-not-acknowledged':
      throw new BadRequestError(
        `${result.provider} requires each customer to accept its own terms before a third ` +
          'party may present their credential. BYOK does not override those terms and does not ' +
          'permit sharing a credential; acknowledge them to continue.',
        { termsUrl: result.termsUrl },
      );
    case 'scope-taken':
      throw new ConflictError(
        'This scope already has a live connection for that provider and environment; ' +
          'rotate it, or disable it first',
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
      'inference:providers:read',
      'inference:providers:read',
    );

    const connections = await listProviderConnectionsForAccount(accountId);
    res.json({ data: connections, count: connections.length });
  }),
);

/**
 * `POST /inference/provider-connections/accounts/:accountId`
 *
 * Register a credential at account or project scope. Kaana control is resolved
 * before the body is read — see the module header.
 */
router.post(
  '/accounts/:accountId',
  providerWriteLimiter,
  validate({
    params: providerConnectionAccountParams,
    body: providerConnectionAccountBody,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { accountId } = providerConnectionAccountParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeAccount(
      principal,
      accountId,
      'inference:providers:write',
      'inference:providers:write',
    );

    const control = kaanaCredentialControlOr503();
    const body = providerConnectionAccountBody.parse(req.body);

    const result = await createProviderConnection(
      {
        provider: body.provider,
        ownerAccountId: accountId,
        scopeKind: body.scope,
        environment: body.environment,
        secret: new ProviderCredentialValue(body.secret),
        acknowledgeProviderTerms: body.acknowledgeProviderTerms,
        actor: actorOf(principal),
      },
      control,
    );
    respondToCreate(res, result);
  }),
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
    await authorizeApplication(
      principal,
      applicationId,
      'inference:byok:read',
      'inference:providers:read',
    );

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
  }),
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
  validate({
    params: providerConnectionApplicationParams,
    body: providerCredentialBody,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { applicationId } = providerConnectionApplicationParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeApplication(
      principal,
      applicationId,
      'inference:byok:write',
      'inference:providers:write',
    );

    const owner = await resolveApplicationOwnerAccount(applicationId);
    if (owner.status === 'unknown-application') {
      throw new NotFoundError('No provider connection is available for that application');
    }

    const control = kaanaCredentialControlOr503();
    const body = providerCredentialBody.parse(req.body);

    const result = await createProviderConnection(
      {
        provider: body.provider,
        ownerAccountId: owner.application.ownerAccountId,
        scopeKind: 'application',
        applicationId,
        environment: body.environment,
        secret: new ProviderCredentialValue(body.secret),
        acknowledgeProviderTerms: body.acknowledgeProviderTerms,
        actor: actorOf(principal),
      },
      control,
    );
    respondToCreate(res, result);
  }),
);

/**
 * `POST /inference/provider-connections/:connectionId/rotate`
 *
 * Replace the credential. The reference is unchanged, so a data plane holding it
 * keeps working and the previous generation becomes unavailable once Kaana
 * acknowledges the exact revision transition.
 */
router.post(
  '/:connectionId/rotate',
  providerWriteLimiter,
  validate({
    params: providerConnectionParams,
    body: providerConnectionRotateBody,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      {
        application: 'inference:byok:write',
        account: 'inference:providers:write',
      },
      'inference:providers:write',
    );

    const control = kaanaCredentialControlOr503();
    const body = providerConnectionRotateBody.parse(req.body);

    const result = await rotateProviderConnection(
      {
        connectionId,
        secret: new ProviderCredentialValue(body.secret),
        actor: actorOf(principal),
      },
      control,
    );
    switch (result.status) {
      case 'rotated':
        res.json({ data: result.connection });
        return;
      case 'custody-reconcile':
        throw new ApiError(
          503,
          'The credential rotation outcome is uncertain and this connection is quarantined.',
          'kaana_credential_reconcile_required',
        );
      case 'custody-manual':
        throw new ConflictError(
          'Kaana recorded a conflicting credential rotation. The connection remains quarantined for manual resolution.',
        );
      case 'unknown-connection':
        throw new NotFoundError('No such provider connection');
      case 'revoked':
        throw new ConflictError('This connection is revoked and can no longer be rotated');
      case 'unchanged-credential':
        throw new ConflictError(
          'That is the credential this connection already holds; a rotation must supply a new one',
        );
    }
  }),
);

/**
 * `POST /inference/provider-connections/:connectionId/disable`
 *
 * Immediate and reversible. Pure database work — no Kaana round trip — so
 * "immediate" does not depend on the availability of the thing being stopped.
 */
router.post(
  '/:connectionId/disable',
  providerWriteLimiter,
  validate({
    params: providerConnectionParams,
    body: providerConnectionEmptyBody,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      {
        application: 'inference:byok:write',
        account: 'inference:providers:write',
      },
      'inference:providers:write',
    );

    respondToTransition(
      res,
      await disableProviderConnection({
        connectionId,
        actor: actorOf(principal),
      }),
    );
  }),
);

/** `POST /inference/provider-connections/:connectionId/enable` — undo a disable. */
router.post(
  '/:connectionId/enable',
  providerWriteLimiter,
  validate({
    params: providerConnectionParams,
    body: providerConnectionEmptyBody,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      {
        application: 'inference:byok:write',
        account: 'inference:providers:write',
      },
      'inference:providers:write',
    );

    respondToTransition(
      res,
      await enableProviderConnection({
        connectionId,
        actor: actorOf(principal),
      }),
    );
  }),
);

/**
 * `POST /inference/provider-connections/:connectionId/revoke`
 *
 * Terminal. Oxy fences it locally before asking Kaana to revoke the exact
 * generation, and the response states whether Kaana acknowledged that change.
 * There is deliberately no DELETE: a deleted
 * connection would make a past charge unexplainable and would take its own audit
 * trail with it.
 */
router.post(
  '/:connectionId/revoke',
  providerWriteLimiter,
  validate({
    params: providerConnectionParams,
    body: providerConnectionEmptyBody,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      {
        application: 'inference:byok:write',
        account: 'inference:providers:write',
      },
      'inference:providers:write',
    );

    // Optional here, unlike create and rotate: local fencing must still happen
    // when the Kaana control authority is temporarily unavailable.
    let control: KaanaCredentialControl | undefined;
    try {
      control = requireKaanaCredentialControl();
    } catch (error) {
      if (!(error instanceof KaanaCredentialControlUnavailableError)) throw error;
    }
    const result = await revokeProviderConnection(
      { connectionId, actor: actorOf(principal) },
      control,
    );
    switch (result.status) {
      case 'revoked':
        res.json({
          data: result.connection,
          credentialRevoked: result.credentialRevoked,
        });
        return;
      case 'custody-reconcile':
        throw new ApiError(
          503,
          'The credential revocation outcome is uncertain and this connection remains quarantined.',
          'kaana_credential_reconcile_required',
        );
      case 'custody-manual':
        throw new ConflictError(
          'Kaana recorded a conflicting credential revocation. The connection remains quarantined for manual resolution.',
        );
      case 'unknown-connection':
        throw new NotFoundError('No such provider connection');
      case 'already-revoked':
        throw new ConflictError('This connection is already revoked');
    }
  }),
);

/**
 * `POST /inference/provider-connections/:connectionId/reconcile`
 *
 * Retry only Kaana's signed exact-outcome lookup for the operation Oxy already
 * persisted. It sends no provider secret and never mints or substitutes an id.
 *
 * @response 200 providerConnectionReconcileResponseSchema The exact applied operation and its metadata-only connection.
 */
router.post(
  '/:connectionId/reconcile',
  providerWriteLimiter,
  validate({
    params: providerConnectionParams,
    body: providerConnectionEmptyBody,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      {
        application: 'inference:byok:write',
        account: 'inference:providers:write',
      },
      'inference:providers:write',
    );

    const result = await reconcileProviderConnection(connectionId, kaanaCredentialControlOr503());
    switch (result.status) {
      case 'reconciled':
        res.json(
          providerConnectionReconcileResponseSchema.parse({
            data: result.connection,
            reconciledAction: result.action,
          }),
        );
        return;
      case 'reconciliation-required':
        throw new ApiError(
          503,
          'Kaana still has no exact outcome for this operation. The connection remains quarantined.',
          'kaana_credential_reconcile_required',
        );
      case 'manual-required':
        throw new ConflictError(
          'Kaana recorded a conflict for this operation. The connection requires manual resolution.',
        );
      case 'no-unresolved-operation':
        throw new ConflictError('This connection has no unresolved credential operation');
      case 'unknown-connection':
        throw new NotFoundError('No such provider connection');
    }
  }),
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
  validate({
    params: providerConnectionParams,
    body: providerConnectionValidationBody,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const principal = principalOf(req);
    await authorizeConnection(
      principal,
      connectionId,
      {
        application: 'inference:byok:write',
        account: 'inference:providers:write',
      },
      'inference:providers:write',
    );

    const verdict = providerConnectionValidationBody.parse(req.body);
    const result = await recordProviderConnectionValidation({
      connectionId,
      state: verdict.state,
      failureCode: verdict.failureCode,
      // A verdict a member asked for names them; one a service token reported has
      // no person behind it and now SAYS so, rather than leaving the row's actor
      // blank in a way indistinguishable from a row written before the kind
      // existed.
      actor: actorOf(principal),
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
  }),
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
  validate({
    params: providerConnectionParams,
    query: providerConnectionAuditQuery,
  }),
  asyncHandler(async (req: ProviderRequest, res: Response) => {
    const { connectionId } = providerConnectionParams.parse(req.params);
    const { limit } = providerConnectionAuditQuery.parse(req.query);
    await authorizeConnection(
      principalOf(req),
      connectionId,
      {
        application: 'inference:byok:read',
        account: 'inference:providers:read',
      },
      'inference:providers:read',
    );

    const events = await listProviderConnectionAuditEvents(connectionId, limit);
    res.json({ data: events, count: events.length });
  }),
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
      {
        application: 'inference:byok:read',
        account: 'inference:providers:read',
      },
      'inference:providers:read',
    );
    res.json({ data: toProviderConnection(row) });
  }),
);

export default router;
