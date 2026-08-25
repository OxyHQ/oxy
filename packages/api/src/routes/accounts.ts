import express from 'express';
import type { Request } from 'express';
import { and, count, eq, ne } from 'drizzle-orm';
import {
  isActAsEligibleKind,
  type AccountCategoryId,
  type ChildAccountKind,
} from '@oxyhq/contracts';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler } from '../utils/asyncHandler';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import {
  accountService,
  type AccountMemberRow,
  type AccountNode,
  type AccountRow,
  type EffectiveAccess,
} from '../services/account.service';
import type { ApplicationScope } from '../utils/applicationScopes';
import { publicColumns } from '@oxyhq/db/assert';
import { getDb } from '../config/postgres';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { users } from '../db/schema/users';
import sessionService from '../services/session.service';
import { listAccountAuditTrail } from '../services/accountAuditTrail.service';
import { listAccountBillingAudit } from '../services/accountBillingAudit.service';
import deviceSessionService from '../services/deviceSession.service';
import { broadcastDeviceState } from '../utils/socket';
import { decodeToken, extractTokenFromRequest } from '../middleware/authUtils';
import { logger } from '../utils/logger';
import type { SessionAuthResponse } from '../types/session';
import { resolveUserByIdentifier } from '../utils/resolveUserIdentifier';
import { accountMembers } from '../db/schema/accountMembers';
import { stripSensitiveUrlQueryParams } from '../utils/sanitizeUrl';
import { formatUserResponse } from '../utils/userTransform';
import {
  effectivePermissionsForMember,
  type AccountPermission,
  type AccountRole,
} from '../utils/accountRoles';
import {
  accountAuditQuerySchema,
  accountBillingAuditQuerySchema,
  accountIdRouteParams,
  accountMemberParams,
  listAccountsQuerySchema,
  createAccountSchema,
  updateAccountSchema,
  moveAccountSchema,
  inviteAccountMemberSchema,
  updateAccountMemberSchema,
  transferAccountOwnershipSchema,
  provisionChannelSchema,
  provisionChannelMemberSchema,
  provisionChannelMemberParams,
} from '../schemas/account.schemas';

/**
 * Request decorated by `loadAccountContext` / `requireAccountPermission` with
 * the resolved account (a User doc) and the caller's effective access over it.
 */
interface AccountContextRequest extends AuthRequest {
  account?: AccountRow;
  access?: EffectiveAccess;
}

const router = express.Router();

// ===========================================================================
// Service-scoped channel provisioning — REGISTERED BEFORE `authMiddleware`
//
// These two routes authenticate a SERVICE credential, not a user session, so
// they must be registered above the `router.use(authMiddleware)` below: Express
// runs middleware in registration order, and a service bearer is not a session
// bearer. Same ordering requirement as `/email/inbound` before `/email` in
// `server.ts` — move them down and they start answering 401 to a valid
// credential. CSRF is a non-issue: `verifyCsrfToken` returns early for any
// `Authorization: Bearer` request, because CSRF protects ambient cookie auth.
//
// WHY THIS DOES NOT REOPEN WHAT `isActAsEligibleKind` CLOSED
//
// The property is that no bearer can exist whose subject is a channel, so
// nothing can add an auth method to one. Neither route touches
// `user_auth_methods` and neither mints a session: minting one still requires
// `POST /accounts/:id/switch`, which refuses a channel. Creating an account and
// granting membership on it are not act-as.
//
// The gate that keeps it that way is `loadChannelAccount` on the membership
// routes. Membership on a kind that CAN be acted as (`organization`, `project`,
// `bot`) plus `account:act_as` is a session — so a membership endpoint that
// accepted an arbitrary account id really would be an escalation, and would let
// this credential add a principal to somebody's organization. Restricting the
// target to `kind: 'channel'` is what bounds the scope to publishing rights on
// an identity nobody can occupy. The create route hardcodes `kind: 'channel'`
// for the mirror-image reason.
// ===========================================================================

/**
 * Per-APP ceiling for channel provisioning.
 *
 * Keyed on the service `appId`, not the caller IP: a relying app's traffic
 * arrives from a handful of NAT addresses, so an IP-keyed budget would make one
 * busy deployment throttle every other app — the failure this ecosystem has
 * already hit on the per-IP browser limiter. Declared HERE rather than reusing
 * `writeLimiter` below for a second reason too: that one is a `const` defined
 * after `router.use(authMiddleware)`, and referencing it from a route registered
 * above would be a temporal-dead-zone `ReferenceError` at module load — the
 * server would not boot.
 */
const channelProvisionLimiter = rateLimit({
  prefix: 'rl:accounts:provision:',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many channel provisioning requests. Please slow down.',
  keyGenerator: (req: Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    return serviceApp?.appId
      ? `accounts:provision:${serviceApp.appId}`
      : `accounts:provision:ip:${hashedIpKey(req)}`;
  },
});

/** Reject a service token that was not granted `scope`. */
function requireServiceScope(req: ServiceAuthRequest, scope: ApplicationScope): void {
  if (!req.serviceApp?.scopes?.includes(scope)) {
    throw new ForbiddenError(`Missing required scope: ${scope}`);
  }
}

/**
 * Load an account and assert it is a CHANNEL.
 *
 * The load-bearing check of this whole surface — see the header above. A 404 for
 * a non-channel rather than a 403: whether some other account exists is not this
 * credential's business to learn.
 */
async function loadChannelAccount(accountId: string): Promise<AccountRow> {
  const [account] = await getDb()
    .select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE))
    .from(users)
    .where(eq(users.id, accountId))
    .limit(1);
  if (!account || account.kind !== 'channel' || account.accountStatus === 'archived') {
    throw new NotFoundError('Channel account not found');
  }
  return account;
}

/**
 * POST /accounts/service/channels
 *
 * Mint a `channel` account under `ownerUserId`, who becomes its `owner` member.
 * `kind` is NOT accepted from the body — it is hardcoded, so this credential can
 * never mint an account that anyone could subsequently act as.
 */
router.post(
  '/service/channels',
  serviceAuthMiddleware,
  channelProvisionLimiter,
  validate({ body: provisionChannelSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    requireServiceScope(req, 'accounts:provision');

    const body = req.body as {
      ownerUserId: string;
      username: string;
      name?: { first?: string; last?: string; displayName?: string };
      bio?: string;
      description?: string;
      avatar?: string;
    };

    const [owner] = await getDb()
      .select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE))
      .from(users)
      .where(eq(users.id, body.ownerUserId))
      .limit(1);
    if (!owner || owner.accountStatus === 'archived') {
      throw new NotFoundError('Owner account not found');
    }

    const { account, membership } = await accountService.createChildAccount(
      owner.id,
      owner.id,
      {
        kind: 'channel',
        username: body.username,
        name: body.name,
        bio: body.bio,
        description: body.description,
        avatar: body.avatar ? stripSensitiveUrlQueryParams(body.avatar) : body.avatar,
      }
    );

    logger.info('Channel provisioned by service', {
      accountId: account.id,
      ownerUserId: owner.id,
      appId: req.serviceApp?.appId,
    });

    res.status(201).json({
      account: formatUserResponse(account),
      // A row this request just wrote on this account: direct by construction.
      membership: serializeMember(membership, 'direct'),
    });
  })
);

/**
 * POST /accounts/service/channels/:id/members
 *
 * Grant membership on a CHANNEL. `owner` is not assignable (the schema's role
 * enum excludes it) — ownership moves only via transfer-ownership.
 */
router.post(
  '/service/channels/:id/members',
  serviceAuthMiddleware,
  channelProvisionLimiter,
  validate({ params: accountIdRouteParams, body: provisionChannelMemberSchema }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    requireServiceScope(req, 'accounts:provision');

    const body = req.body as {
      memberUserId: string;
      role: Exclude<AccountRole, 'owner'>;
      inherit?: boolean;
    };
    const channel = await loadChannelAccount(req.params.id);

    const [member] = await getDb()
      .select({ id: users.id, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, body.memberUserId))
      .limit(1);
    if (!member || member.accountStatus === 'archived') {
      throw new NotFoundError('Member account not found');
    }

    const membership = await accountService.addMember(
      channel.id,
      channel.id,
      body.memberUserId,
      body.role,
      body.inherit ?? false
    );

    logger.info('Channel member added by service', {
      accountId: channel.id,
      memberUserId: body.memberUserId,
      role: body.role,
      appId: req.serviceApp?.appId,
    });

    // A row this request just wrote on this channel: direct by construction.
    res.status(201).json({ member: serializeMember(membership, 'direct') });
  })
);

/**
 * DELETE /accounts/service/channels/:id/members/:memberUserId
 *
 * Revoke membership on a CHANNEL. Keyed on the member's USER id rather than the
 * membership row id: the caller knows who it is removing, not which row records
 * it. Removing the owner is refused by `accountService.removeMember`.
 */
router.delete(
  '/service/channels/:id/members/:memberUserId',
  serviceAuthMiddleware,
  channelProvisionLimiter,
  validate({ params: provisionChannelMemberParams }),
  asyncHandler(async (req: ServiceAuthRequest, res) => {
    requireServiceScope(req, 'accounts:provision');

    const channel = await loadChannelAccount(req.params.id);

    const [membership] = await getDb()
      .select({ id: accountMembers.id })
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, channel.id),
          eq(accountMembers.memberUserId, req.params.memberUserId),
          ne(accountMembers.status, 'removed')
        )
      )
      .limit(1);
    if (!membership) {
      throw new NotFoundError('Membership not found');
    }

    // `callerIsOwner: false` — a service credential is not an owner, so the
    // owner-removal guard inside the service stays in force.
    await accountService.removeMember(channel.id, membership.id, false);

    logger.info('Channel member removed by service', {
      accountId: channel.id,
      memberUserId: req.params.memberUserId,
      appId: req.serviceApp?.appId,
    });

    res.status(204).send();
  })
);

// All remaining account routes require an authenticated user.
router.use(authMiddleware);

/** Resolve the authenticated user id, or throw 401. */
function requireUserId(req: AuthRequest): string {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new UnauthorizedError('Authentication required');
  }
  return userId;
}

/**
 * Resolve the caller's central deviceId from their verified bearer (the access
 * token embeds a `deviceId` claim). Returns null when the token is absent or
 * undecodable. Mirrors `resolveCallerDeviceId` in sessionDevice.ts.
 */
function resolveCallerDeviceId(req: AuthRequest): string | null {
  const token = extractTokenFromRequest(req);
  const decoded = token ? decodeToken(token) : null;
  return decoded?.deviceId ?? null;
}

/**
 * Resolve the OPERATOR anchoring the caller's account graph and switches — the
 * HUMAN behind the request, NOT the account currently being acted-as.
 *
 * For an ordinary session the operator IS the authenticated account. For an
 * operated (managed / sub-account) session — one minted by `POST /:id/switch`
 * and carrying `operatedByUserId` — the operator is that recorded human, so
 * every switcher surface stays anchored on the person no matter which of their
 * accounts is currently active. Without this, acting-as a leaf sub-account
 * (which has no children/memberships of its own) collapses the switchable set to
 * just that account and makes sibling switches fail `verifyActingAs`.
 *
 * `operatedByUserId` is authoritative and server-set at switch time (bound to
 * the operator's `account:act_as` membership, re-verified on validate/refresh),
 * so trusting it here escalates nothing. The bearer JWT does not carry it
 * (session-doc-only), so it is read from the (request-cached) session record; a
 * missing/unreadable session degrades safely to the authenticated account.
 */
async function resolveOperatorId(req: AuthRequest): Promise<string> {
  const authedUserId = requireUserId(req);
  const token = extractTokenFromRequest(req);
  const sessionId = token ? decodeToken(token)?.sessionId : undefined;
  if (!sessionId) {
    return authedUserId;
  }
  try {
    const sessionDoc = await sessionService.getSession(sessionId, true);
    const operator = sessionDoc?.operatedByUserId ? sessionDoc.operatedByUserId.toString() : null;
    return operator ?? authedUserId;
  } catch (error) {
    logger.debug('[accounts] resolveOperatorId: session lookup failed, using active account', {
      component: 'accounts',
      method: 'resolveOperatorId',
      error: error instanceof Error ? error.message : String(error),
    });
    return authedUserId;
  }
}

/** Per-user (or per-IP when anonymous) rate-limit key for a scope. */
function userScopedKey(scope: string) {
  return (req: Request): string => {
    const userId = (req as AuthRequest).user?._id?.toString();
    return userId ? `${scope}:${userId}` : `${scope}:ip:${hashedIpKey(req)}`;
  };
}

const readLimiter = rateLimit({
  prefix: 'rl:accounts:read:',
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many account requests. Please slow down.',
  keyGenerator: userScopedKey('accounts:read'),
});

const writeLimiter = rateLimit({
  prefix: 'rl:accounts:write:',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many account changes. Please slow down.',
  keyGenerator: userScopedKey('accounts:write'),
});

const membersLimiter = rateLimit({
  prefix: 'rl:accounts:members:',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many membership changes. Please slow down.',
  keyGenerator: userScopedKey('accounts:members'),
});

/** Serialise an account (a User doc) for client responses. */
/**
 * Serialise a membership row for client responses. `source` is the contextual
 * resolution origin — `'direct'` for a row that lives on the account being
 * reported, `'inherited'` for one resolved from an ancestor of it.
 *
 * REQUIRED, with no default. It used to default to `'direct'`, which was
 * correct at every call site that returns a row it just wrote and quietly wrong
 * at the one that returns a roster: an inherited entry serialised as `direct`
 * tells a client it may edit a row belonging to another account, and
 * `requireDirectMember` scopes by `accountId`, so the edit 404s. A parameter
 * every caller has to answer is the only version of this that a new call site
 * cannot get wrong by saying nothing.
 */
function serializeMember(member: AccountMemberRow, source: 'direct' | 'inherited') {
  return {
    _id: member.id,
    accountId: member.accountId,
    memberUserId: member.memberUserId,
    role: member.role,
    // `account_members.permissions` does not travel to Postgres — it was always
    // a derivation rather than data. The wire keeps the field, computed here,
    // and it is the EFFECTIVE set: the role's baseline with this member's own
    // grants and revokes applied. Consumers gate on this array (Mention reads
    // `account:act_as` out of it to decide who may publish as an account), so it
    // has to be the same answer this API's own gates give.
    permissions: effectivePermissionsForMember(member),
    // The deltas themselves, so an editor UI can show what was adjusted rather
    // than diffing the effective set against a role map it would have to keep a
    // second copy of.
    permissionGrants: member.permissionGrants,
    permissionRevokes: member.permissionRevokes,
    inherit: member.inherit,
    status: member.status,
    source,
    // Mongoose omitted an unset optional; a nullable column reads back `null`.
    invitedByUserId: member.invitedByUserId ?? undefined,
    joinedAt: member.joinedAt,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}

/**
 * Serialise an `AccountNode` for client responses: the canonical public user DTO
 * nested under `account` (carries `name.displayName`), plus relationship +
 * `callerMembership` (a full member row, or null for `self`) + childCount.
 */
function serializeAccountNode(node: AccountNode) {
  return {
    accountId: node.accountId,
    kind: node.kind,
    parentAccountId: node.parentAccountId,
    account: formatUserResponse(node.account),
    relationship: node.relationship,
    callerMembership: node.callerMembership
      ? serializeMember(node.callerMembership, node.callerMembershipSource ?? 'direct')
      : null,
    childCount: node.childCount,
  };
}

/**
 * Build an `AccountNode` for a single loaded account from the caller's resolved
 * effective access (used by the single-account endpoints).
 */
function accountNodeFromAccess(
  account: AccountRow,
  access: EffectiveAccess,
  childCount: number
): AccountNode {
  const relationship: AccountNode['relationship'] =
    access.source === 'self' ? 'self' : access.role === 'owner' ? 'owner' : 'member';
  return {
    accountId: account.id,
    kind: account.kind,
    parentAccountId: account.parentAccountId,
    // `rootAccountId ?? id` — a root account stores no self-reference.
    rootAccountId: account.rootAccountId ?? account.id,
    account,
    relationship,
    callerMembership: access.membership,
    callerMembershipSource: access.source === 'self' ? null : access.source,
    childCount,
  };
}

/**
 * Count an account's non-archived direct children.
 *
 * `users_parent_account_id_idx` (partial, `where account_status <> 'archived'`)
 * serves this exact predicate.
 */
async function countChildren(accountId: string): Promise<number> {
  const [row] = await getDb()
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.parentAccountId, accountId), ne(users.accountStatus, 'archived')));
  return row.value;
}

/**
 * Resolve the account (non-archived) for `:id` and the caller's effective
 * access over it. 404 when missing/archived, 403 when the caller has no access.
 */
async function loadAccountContext(req: AccountContextRequest): Promise<{
  account: AccountRow;
  access: EffectiveAccess;
}> {
  // An operated session authenticates as the managed account, but its RBAC
  // remains that of the human operator recorded on the server-side session.
  const userId = await resolveOperatorId(req);
  const id = req.params.id;

  // The `isValidObjectId` guard is gone: it only ever prevented a Mongoose
  // `CastError`, and a Postgres text id that matches no row is already the 404
  // this endpoint documents.
  const [account] = await getDb().select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)).from(users).where(eq(users.id, id)).limit(1);
  if (!account || account.accountStatus === 'archived') {
    throw new NotFoundError('Account not found');
  }

  const access = await accountService.effectiveAccessForAccount(userId, account);
  if (!access) {
    throw new ForbiddenError('You do not have access to this account');
  }

  req.account = account;
  req.access = access;
  return { account, access };
}

/**
 * RBAC middleware factory. Resolves the account + caller's effective access for
 * `:id`, then enforces that the access carries `permission`.
 */
function requireAccountPermission(permission: AccountPermission) {
  return asyncHandler(async (req: AccountContextRequest, _res, next) => {
    const { access } = await loadAccountContext(req);
    if (!access.permissions.includes(permission)) {
      throw new ForbiddenError(`Missing required permission: ${permission}`);
    }
    next();
  });
}

// ============================================================================
// Accounts — forest + CRUD
// ============================================================================

/**
 * The OPERATOR's accessible account forest: their own personal account plus every
 * account they can reach (direct membership + inherited subtree). Flat by
 * default; `?tree=true` nests children under parents.
 *
 * Anchored on the operator (the human), NOT the currently-active account, so the
 * switchable set is IDENTICAL regardless of which of the operator's accounts is
 * active — switching only flips which account is marked current, never which are
 * listed. (When acting-as a leaf sub-account, anchoring on the active account
 * would collapse the list to just that account.)
 */
router.get(
  '/',
  readLimiter,
  validate({ query: listAccountsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = await resolveOperatorId(req);
    const nodes = await accountService.listAccessibleAccounts(userId);
    const serialized = nodes.map(serializeAccountNode);

    if (req.query.tree === 'true') {
      res.json({ accounts: buildForest(nodes, serialized) });
      return;
    }
    res.json({ accounts: serialized });
  })
);

/**
 * Switch INTO a managed/org account — a TRUE account switch (the whole app
 * becomes that account), NOT a per-request delegation. Mints a REAL session
 * whose `user` IS the target account, exactly like switching device accounts.
 *
 * The caller (operator) must hold `account:act_as` over the target. The minted
 * session records the operator (`operatedByUserId`) for audit and binds its
 * validity to that membership — revoking it kills the session (re-checked on
 * validate + refresh).
 *
 * The minted managed session is registered into the operator's device set
 * server-side (`deviceSessionService.addAccount`, broadcast to the device room)
 * so it survives reload and syncs across the device's apps via the socket.
 *
 * Returns the SAME shape as login / claimSession (`SessionAuthResponse`) so the
 * client plants it as the active session.
 */
router.post(
  '/:id/switch',
  writeLimiter,
  validate({ params: accountIdRouteParams }),
  asyncHandler(async (req: AuthRequest, res) => {
    // Anchor on the OPERATOR (the human), not the active account: acting-as a
    // sub-account must still let the operator switch into their SIBLING accounts.
    // For an ordinary session this is the authenticated account itself; for an
    // operated session it is the recorded `operatedByUserId`, so the operator
    // chain never nests (a switch out of a sub-account is still authorised as,
    // and recorded against, the human — never the sub-account).
    const operatorId = await resolveOperatorId(req);
    const id = req.params.id;

    // Authorize: the operator must hold account:act_as over the target (directly
    // or inherited). Non-members / insufficient role → 403. This is the ONLY gate
    // — the session token then carries identity; no per-request header is trusted.
    const role = await accountService.verifyActingAs(operatorId, id);
    if (!role) {
      throw new ForbiddenError('You are not authorized to switch into this account');
    }

    const [account] = await getDb().select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)).from(users).where(eq(users.id, id)).limit(1);
    if (!account || account.accountStatus === 'archived') {
      throw new NotFoundError('Account not found');
    }
    // Only OPERABLE managed accounts are switch targets. A personal account is a
    // human login and must never be assumed (that would be impersonation); a
    // channel is a content identity nobody occupies, and refusing it here is what
    // makes "a channel can never be logged into" structural — no session whose
    // subject is a channel can be minted, so no bearer exists that could add an
    // auth method to one.
    if (!isActAsEligibleKind(account.kind)) {
      throw new ForbiddenError(
        account.kind === 'channel'
          ? 'Cannot switch into a channel account'
          : 'Cannot switch into a personal account'
      );
    }

    // Mint a REAL session for the managed account, recording the operator so the
    // session's validity stays bound to their act_as membership.
    //
    // Inherit the OPERATOR's central deviceId so the org session joins the SAME
    // device doc as the operator's own session. Without this the switch mints a
    // fresh deviceId (UA/IP-derived), the org lands in a device doc the browser
    // never restores from on reload (it restores via the operator's personal
    // session), and the switch silently reverts. If the caller's bearer has no
    // decodable deviceId, keep today's behavior (let createSession allocate one).
    const callerDeviceId = resolveCallerDeviceId(req);
    if (!callerDeviceId) {
      logger.warn('[accounts] switch: no deviceId on operator bearer — org session gets a fresh device', {
        component: 'accounts',
        method: 'switch',
        operatorId,
        targetAccountId: id,
      });
    }
    const session = await sessionService.createSession(account.id, req, {
      operatedByUserId: operatorId,
      ...(callerDeviceId ? { deviceId: callerDeviceId } : {}),
    });

    // Register the managed session into the operator's device set server-side so
    // it survives reload and syncs cross-domain via the socket room — a switch is
    // a deliberate activation, so `activate: 'always'`. This replaces the client
    // establishing the slot separately. Best-effort: never fail the switch on a
    // device-set write. Only when the operator's device is known.
    if (callerDeviceId) {
      try {
        const { state, changed } = await deviceSessionService.addAccount(
          session.deviceId,
          {
            accountId: account.id,
            sessionId: session.sessionId,
            operatedByUserId: operatorId,
          },
          { activate: 'always' },
        );
        if (changed) broadcastDeviceState(state);
      } catch (error) {
        logger.warn('[accounts] switch: device-set registration failed', {
          component: 'accounts',
          method: 'switch',
          operatorId,
          targetAccountId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const userData = formatUserResponse(account);
    if (!userData) {
      throw new Error('Failed to format account data');
    }

    // No cookie is planted here — the device-set registration above
    // (`deviceSessionService.addAccount` + `broadcastDeviceState`) is what makes
    // the switch survive reload and sync cross-domain via the socket room. The
    // SDK plants the returned `accessToken` directly; there is no separate
    // cookie-establishing round trip.

    // Mirror the canonical login / claimSession response shape.
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

    res.status(200).json(response);
  })
);

/**
 * Create an account. `parentAccountId` defaults to the caller's own personal
 * account when omitted (a top-level org/project/bot they own). The caller must
 * hold `children:create` over the parent.
 */
router.post(
  '/',
  writeLimiter,
  validate({ body: createAccountSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = requireUserId(req);
    const body = req.body as {
      parentAccountId?: string;
      kind: ChildAccountKind;
      username: string;
      name?: { first?: string; last?: string; displayName?: string };
      bio?: string;
      avatar?: string;
      description?: string;
      accountCategories?: AccountCategoryId[];
      isPrivateAccount?: boolean;
    };

    const parentAccountId = body.parentAccountId ?? userId;

    // The caller must be allowed to create children on the chosen parent.
    const access = await accountService.resolveEffectiveAccess(userId, parentAccountId);
    if (!access) {
      throw new ForbiddenError('You do not have access to the parent account');
    }
    if (!access.permissions.includes('children:create')) {
      throw new ForbiddenError('Missing required permission: children:create');
    }

    const { account, membership } = await accountService.createChildAccount(parentAccountId, userId, {
      kind: body.kind,
      username: body.username,
      name: body.name,
      bio: body.bio,
      avatar: body.avatar ? stripSensitiveUrlQueryParams(body.avatar) : body.avatar,
      description: body.description,
      accountCategories: body.accountCategories,
      // Threaded explicitly, like every other field: this handler names each
      // one, so a field the schema accepts but this list omits is dropped
      // between validation and the insert with no error anywhere.
      isPrivateAccount: body.isPrivateAccount,
    });

    const node: AccountNode = {
      accountId: account.id,
      kind: (account.kind as AccountNode['kind']) ?? body.kind,
      parentAccountId: account.parentAccountId ? account.parentAccountId.toString() : null,
      rootAccountId: account.rootAccountId ?? account.id,
      account,
      relationship: 'owner',
      callerMembership: membership,
      callerMembershipSource: 'direct',
      childCount: 0,
    };
    res.status(201).json({ account: serializeAccountNode(node) });
  })
);

/** Get a single account the caller can read. */
router.get(
  '/:id',
  readLimiter,
  validate({ params: accountIdRouteParams }),
  requireAccountPermission('account:read'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    const access = req.access;
    if (!account || !access) {
      throw new NotFoundError('Account not found');
    }
    const childCount = await countChildren(account.id);
    res.json({ account: serializeAccountNode(accountNodeFromAccess(account, access, childCount)) });
  })
);

/**
 * `GET /accounts/:id/audit` — what changed on this account, and who did it.
 *
 * The union of the two audit event tables, newest first, cursor-paginated. It
 * exists because both underlying reads are PER-ENTITY, so a Console page
 * answering "what happened on this account" would otherwise be one request per
 * credential per application plus one per connection — an unbounded fan-out
 * assembling an aggregate the API never computed.
 *
 * ## Both permissions, and a refusal rather than a partial list
 *
 * The union spans two sources that are separately gated: a credential's trail
 * needs `credentials:read` and a connection's needs `inference:providers:read`.
 * This route requires BOTH, so a caller holding one gets 403 rather than a list
 * that silently omits the other half.
 *
 * That is deliberate for an AUDIT surface specifically. Everywhere else in this
 * API, narrowing a result to what the caller may see is the right answer; here it
 * would produce a trail that reads as complete and is not, which is the one
 * failure an audit view must not have. `account:read` alone would be worse
 * still — it is baseline for every role, so a `viewer` would read credential
 * history they are refused per credential.
 */
router.get(
  '/:id/audit',
  readLimiter,
  validate({ params: accountIdRouteParams, query: accountAuditQuerySchema }),
  requireAccountPermission('credentials:read'),
  requireAccountPermission('inference:providers:read'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const { limit, cursor } = accountAuditQuerySchema.parse(req.query);
    const page = await listAccountAuditTrail(account.id, { limit, cursor: cursor ?? null });
    res.json({ data: page.entries, count: page.entries.length, nextCursor: page.nextCursor });
  })
);

/**
 * `GET /accounts/:id/billing/audit` — what changed about this account's money.
 *
 * The customer-facing projection of `billing_ledger_entries`, newest first,
 * cursor-paginated: top-ups, promotional grants, reversals of settled charges
 * and invoice payments. Things the customer did, or that were done to them.
 *
 * The other five entry kinds are withheld, and the internal chart of accounts,
 * the postings' amounts and the id of the staff member behind a grant are never
 * projected at all — `services/accountBillingAudit.service.ts` argues each of
 * those decisions where it is implemented.
 *
 * ## `billing:read`, and only that
 *
 * One source, one permission — unlike `/:id/audit`, which spans two separately
 * gated tables and therefore demands both. `billing:read` is the permission the
 * rest of this API already uses for every money read (`utils/accountRoles.ts`),
 * and it is deliberately narrower than `account:read`: `account:read` is
 * baseline for every role, so gating on it would hand a `viewer` the account's
 * funding history.
 */
router.get(
  '/:id/billing/audit',
  readLimiter,
  validate({ params: accountIdRouteParams, query: accountBillingAuditQuerySchema }),
  requireAccountPermission('billing:read'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const { limit, cursor } = accountBillingAuditQuerySchema.parse(req.query);
    const page = await listAccountBillingAudit(account.id, { limit, cursor: cursor ?? null });
    res.json({ data: page.entries, count: page.entries.length, nextCursor: page.nextCursor });
  })
);

/** Partially update an account (`account:update`). */
router.patch(
  '/:id',
  writeLimiter,
  validate({ params: accountIdRouteParams, body: updateAccountSchema }),
  requireAccountPermission('account:update'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const body = req.body as {
      username?: string;
      name?: { first?: string; last?: string; displayName?: string };
      bio?: string | null;
      avatar?: string | null;
      description?: string;
      color?: string;
      links?: string[];
      accountCategories?: AccountCategoryId[];
    };

    const updated = await accountService.updateAccount(account.id, {
      ...body,
      // `null` clears and must survive as `null`; only a real string is
      // sanitised. Collapsing the two here would turn "remove my picture" into
      // "leave it alone", which is silent and unreportable from the client.
      avatar:
        typeof body.avatar === 'string'
          ? stripSensitiveUrlQueryParams(body.avatar)
          : body.avatar,
    });

    const access = req.access;
    if (!access) {
      throw new NotFoundError('Account not found');
    }
    const childCount = await countChildren(updated.id);
    res.json({ account: serializeAccountNode(accountNodeFromAccess(updated, access, childCount)) });
  })
);

/** Archive an account (`account:delete`). Never hard-deletes. */
router.delete(
  '/:id',
  writeLimiter,
  validate({ params: accountIdRouteParams }),
  requireAccountPermission('account:delete'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    await accountService.archiveAccount(account.id);
    res.json({ success: true });
  })
);

// ============================================================================
// Tree
// ============================================================================

/** Immediate children of an account (`children:read`). */
router.get(
  '/:id/children',
  readLimiter,
  validate({ params: accountIdRouteParams }),
  requireAccountPermission('children:read'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const children = await accountService.listChildren(requireUserId(req), account.id);
    res.json({ accounts: children.map(serializeAccountNode) });
  })
);

/** The full subtree rooted at an account (`children:read`), including itself. */
router.get(
  '/:id/tree',
  readLimiter,
  validate({ params: accountIdRouteParams }),
  requireAccountPermission('children:read'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const subtree = await accountService.getSubtree(requireUserId(req), account.id);
    res.json({ accounts: subtree.map(serializeAccountNode) });
  })
);

/**
 * Re-parent an account (`children:update` on the account being moved). The
 * caller must ALSO hold `children:create` on the destination parent.
 */
router.post(
  '/:id/move',
  writeLimiter,
  validate({ params: accountIdRouteParams, body: moveAccountSchema }),
  requireAccountPermission('children:update'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const { newParentId } = req.body as { newParentId: string };

    const userId = requireUserId(req);
    const destAccess = await accountService.resolveEffectiveAccess(userId, newParentId);
    if (!destAccess || !destAccess.permissions.includes('children:create')) {
      throw new ForbiddenError('Missing permission to add children to the destination account');
    }

    const moved = await accountService.moveAccount(account.id, newParentId);
    const access = req.access;
    if (!access) {
      throw new NotFoundError('Account not found');
    }
    const childCount = await countChildren(moved.id);
    res.json({ account: serializeAccountNode(accountNodeFromAccess(moved, access, childCount)) });
  })
);

// ============================================================================
// Members
// ============================================================================

/**
 * List the members of an account (`members:read`) — its own rows plus the
 * ancestor rows that cascade into it, each carrying the `source` that says
 * which. See {@link AccountService.listMembers} for why an inherited holder
 * belongs in this list and what changes by including them (disclosure, not
 * permission).
 */
router.get(
  '/:id/members',
  membersLimiter,
  validate({ params: accountIdRouteParams }),
  requireAccountPermission('members:read'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const members = await accountService.listMembers(account.id);
    res.json({ members: members.map(({ row, source }) => serializeMember(row, source)) });
  })
);

/** Add a member by username/email (`members:invite`). */
router.post(
  '/:id/members',
  membersLimiter,
  validate({ params: accountIdRouteParams, body: inviteAccountMemberSchema }),
  requireAccountPermission('members:invite'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const { usernameOrEmail, role, inherit } = req.body as {
      usernameOrEmail: string;
      role: Exclude<AccountRole, 'owner'>;
      inherit?: boolean;
    };

    const targetUser = await resolveUserByIdentifier(usernameOrEmail);
    if (!targetUser) {
      throw new NotFoundError('User not found');
    }

    const member = await accountService.addMember(
      account.id,
      requireUserId(req),
      targetUser.id,
      role,
      inherit
    );

    // `addMember` writes on `account.id`, so the row is direct by construction —
    // `inherit` governs whether it cascades to CHILDREN, not where it lives.
    res.status(201).json({ member: serializeMember(member, 'direct') });
  })
);

/**
 * Change a member's role, inheritance and/or per-member permissions
 * (`members:update`).
 *
 * ## The escalation guards
 *
 * `members:update` is held by owner and admin, and an admin's baseline is a
 * PROPER SUBSET of an owner's — it carries neither `account:delete` nor
 * `ownership:transfer`. Without a bound on what may be conferred, this endpoint
 * would hand an admin both of those (via a confederate's row, or their own) and
 * with them the account. The two rules below are what stop that, and the
 * FIRST is the load-bearing one:
 *
 *  1. **An actor may only grant what they themselves effectively hold.** This is
 *     transitive-closure-safe on its own: whatever chain of members grant each
 *     other, no permission enters the account that was not already inside it.
 *     Compared against the actor's EFFECTIVE set, so an actor whose own
 *     `credentials:create` was revoked cannot re-mint it through somebody else.
 *  2. **An actor may not edit their OWN membership row.** Rule 1 already refuses
 *     the dangerous half of a self-edit, so this is not what closes the hole; it
 *     is here because rule 1 evaluated against the very row being rewritten is a
 *     read-modify-write racing itself, and because "you cannot rewrite your own
 *     permissions" is the property an operator will assume holds.
 *
 * Escalation to OWNER is refused structurally rather than by a rule: `role` is
 * typed to the assignable roles (owner is not among them), and `updateMember`
 * refuses an owner ROW outright, so neither the actor nor their target can reach
 * ownership through this endpoint at all.
 *
 * REVOKES are deliberately NOT subject to rule 1. An admin may revoke a
 * permission they do not hold themselves — taking something away is not a
 * conferral, and the alternative would leave a permission granted by a
 * since-departed owner with nobody able to withdraw it.
 */
router.patch(
  '/:id/members/:memberId',
  membersLimiter,
  validate({ params: accountMemberParams, body: updateAccountMemberSchema }),
  requireAccountPermission('members:update'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    const access = req.access;
    if (!account || !access) {
      throw new NotFoundError('Account not found');
    }
    const { role, inherit, permissionGrants, permissionRevokes } = req.body as {
      role?: Exclude<AccountRole, 'owner'>;
      inherit?: boolean;
      permissionGrants?: AccountPermission[];
      permissionRevokes?: AccountPermission[];
    };

    const target = await accountService.requireDirectMember(
      account.id,
      req.params.memberId
    );

    // Rule 2. Compared on `memberUserId`, not on the membership id: an actor
    // whose access is INHERITED from an ancestor has no row on this account, and
    // the row they would be editing here is a different one that nonetheless
    // decides what they may do on this account.
    if (target.memberUserId === requireUserId(req)) {
      throw new ForbiddenError('You cannot change your own membership');
    }

    // Rule 1.
    if (permissionGrants && permissionGrants.length > 0) {
      const beyondActor = permissionGrants.filter(
        (permission) => !access.permissions.includes(permission)
      );
      if (beyondActor.length > 0) {
        throw new ForbiddenError(
          `You cannot grant permissions you do not hold: ${beyondActor.join(', ')}`
        );
      }
    }

    const member = await accountService.updateMember(account.id, req.params.memberId, {
      ...(role !== undefined ? { role } : {}),
      ...(inherit !== undefined ? { inherit } : {}),
      ...(permissionGrants !== undefined ? { permissionGrants } : {}),
      ...(permissionRevokes !== undefined ? { permissionRevokes } : {}),
    });
    // `requireDirectMember` above already refused anything but a row on this
    // account, so the edited row is direct by construction.
    res.json({ member: serializeMember(member, 'direct') });
  })
);

/** Remove a member (`members:remove`). Last owner cannot be removed. */
router.delete(
  '/:id/members/:memberId',
  membersLimiter,
  validate({ params: accountMemberParams }),
  requireAccountPermission('members:remove'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    const access = req.access;
    if (!account || !access) {
      throw new NotFoundError('Account not found');
    }

    await accountService.removeMember(
      account.id,
      req.params.memberId,
      access.role === 'owner'
    );
    res.json({ success: true });
  })
);

/** Transfer ownership to another active member (`ownership:transfer`). */
router.post(
  '/:id/transfer-ownership',
  membersLimiter,
  validate({ params: accountIdRouteParams, body: transferAccountOwnershipSchema }),
  requireAccountPermission('ownership:transfer'),
  asyncHandler(async (req: AccountContextRequest, res) => {
    const account = req.account;
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    const { userId: targetUserId } = req.body as { userId: string };

    await accountService.transferOwnership(account.id, requireUserId(req), targetUserId);
    res.json({ success: true });
  })
);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Nest a flat accessible-account list into a forest. Each node gains a
 * `children` array; nodes whose parent is not in the accessible set become
 * roots of the returned forest. Used only for `GET /accounts?tree=true`.
 */
function buildForest(
  nodes: AccountNode[],
  serialized: ReturnType<typeof serializeAccountNode>[]
): (ReturnType<typeof serializeAccountNode> & { children: unknown[] })[] {
  const byId = new Map<string, ReturnType<typeof serializeAccountNode> & { children: unknown[] }>();
  for (const item of serialized) {
    byId.set(item.accountId, { ...item, children: [] });
  }

  const roots: (ReturnType<typeof serializeAccountNode> & { children: unknown[] })[] = [];
  for (const node of nodes) {
    const item = byId.get(node.accountId);
    if (!item) continue;
    const parent = node.parentAccountId ? byId.get(node.parentAccountId) : undefined;
    if (parent) {
      parent.children.push(item);
    } else {
      roots.push(item);
    }
  }
  return roots;
}

export default router;
