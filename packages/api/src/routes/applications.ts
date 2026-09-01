import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Application, type IApplication } from '../models/Application';
import {
  type APPLICATION_SCOPES,
  type ApplicationScope,
  isPaymentsScope,
  isPrivilegedScope,
} from '../utils/applicationScopes';
import {
  ApplicationCredential,
  type IApplicationCredential,
} from '../models/ApplicationCredential';
import ApiKeyUsage from '../models/ApiKeyUsage';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { isStaffUser } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/error';
import { logger } from '../utils/logger';
import credentialDomainCache from '../utils/credentialDomainCache';
import { refreshOriginRegistry } from '../config/dynamicOriginRegistry';
import { stripSensitiveUrlQueryParams } from '../utils/sanitizeUrl';
import { isTrustedApplication } from '../utils/trustedApplication';
import { accountService } from '../services/account.service';
import {
  appPermissionsForAccountRole,
  type AccountRole,
  type ApplicationPermission,
} from '../utils/accountRoles';
import {
  appIdRouteParams,
  appCredentialParams,
  periodQuerySchema,
  createApplicationSchema,
  listApplicationsQuerySchema,
  updateApplicationSchema,
  createCredentialSchema,
} from '../schemas/application.schemas';

/**
 * Resolved application access for the caller.
 *
 * Access to an application is DERIVED from the caller's effective `AccountMember`
 * role over the application's owning account (`app.ownerAccountId`), honouring
 * tree inheritance. The account role is mapped to a concrete set of application
 * permissions via `appPermissionsForAccountRole`. There is no per-app member
 * table.
 */
interface AppAccess {
  application: IApplication;
  /** The caller's effective account role over `ownerAccountId`. */
  role: AccountRole;
  /** Effective application permissions derived from that role. */
  permissions: Set<ApplicationPermission>;
}

/**
 * Request decorated by `loadApplicationContext` / `requireAppPermission` with
 * the resolved application and the caller's access.
 */
interface AppContextRequest extends AuthRequest {
  application?: IApplication;
  access?: AppAccess;
}

const CREDENTIAL_PUBLIC_KEY_PREFIX = 'oxy_dk_';
const PUBLIC_KEY_RANDOM_BYTES = 24;
const SECRET_RANDOM_BYTES = 32;
const WEBHOOK_SECRET_RANDOM_BYTES = 24;

/**
 * Grace window during which a credential that has been rotated away keeps
 * working. On rotation the previous credential is marked `deprecated` and its
 * `expiresAt` is set to `now + CREDENTIAL_ROTATION_GRACE_MS`, giving callers
 * time to roll out the new secret with zero downtime (7 days).
 */
const CREDENTIAL_ROTATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const router = express.Router();

/**
 * Rebuild the dynamic CORS origin snapshot after an Application
 * create/update/delete. A change to an app's `redirectUris` or `status` changes
 * the registry-derived CORS allowlist, so refresh now instead of waiting for
 * the 60s background tick. Fire-and-forget — never blocks the response.
 */
function refreshDynamicCorsOrigins(): void {
  void refreshOriginRegistry().catch((err) =>
    logger.warn('dynamicOriginRegistry refresh after application change failed', {
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}

// All application routes require an authenticated user.
router.use(authMiddleware);

/** Resolve the authenticated user id, or throw 401. */
function requireUserId(req: AuthRequest): string {
  const userId = req.user?._id?.toString();
  if (!userId) {
    throw new UnauthorizedError('Authentication required');
  }
  return userId;
}

/** Compute the window start date for a usage period. */
function getStartDate(period: string): Date {
  const now = new Date();
  const startDate = new Date();
  switch (period) {
    case '24h':
      startDate.setHours(now.getHours() - 24);
      break;
    case '7d':
      startDate.setDate(now.getDate() - 7);
      break;
    case '30d':
      startDate.setDate(now.getDate() - 30);
      break;
    case '90d':
      startDate.setDate(now.getDate() - 90);
      break;
    default:
      startDate.setDate(now.getDate() - 7);
  }
  return startDate;
}

/**
 * De-duplicate a redirect-URI input list into a single ordered list of EXACT
 * URI strings. Order is preserved and URI strings are kept verbatim — no
 * trailing-slash or wildcard normalisation, because OAuth authorize matches the
 * `redirect_uri` exactly (RFC 6749 §3.1.2). Returns `undefined` when the field
 * was not supplied so callers can leave the stored value untouched on partial
 * updates.
 */
function resolveRedirectUris(input: { redirectUris?: string[] }): string[] | undefined {
  if (input.redirectUris === undefined) {
    return undefined;
  }
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const uri of input.redirectUris) {
    if (seen.has(uri)) continue;
    seen.add(uri);
    deduped.push(uri);
  }
  return deduped;
}

/**
 * Enforce the staff-only privileged-scope gate when an actor sets an
 * application's scopes.
 *
 * Privileged scopes ({@link isPrivilegedScope}, e.g. `federation:write`,
 * `signals:write`) confer act-on-behalf authority and are ENTIRELY
 * staff-controlled: a non-staff caller may neither grant NOR revoke them. Only
 * platform staff may change an application's privileged-scope set.
 *
 * Because `PATCH /:appId` (and create) replace `application.scopes` wholesale
 * with the submitted array, a naive "reject on newly-added privileged scope"
 * check would still let a non-staff caller SILENTLY DROP an already-granted
 * privileged scope simply by omitting it from the payload — e.g. a console
 * scope-picker form whose canonical option list predates a newly-added
 * privileged scope submits a set that no longer contains it, and the
 * authoritative replace revokes it. That is exactly how Mention's granted,
 * in-use `signals:write` was being wiped on routine app edits, breaking
 * recommendation signal pushes at the next service-token mint (the mint
 * intersects credential scopes with app scopes, so losing it on the app loses
 * it for every credential).
 *
 * The gate is therefore symmetric for non-staff callers:
 * - Adding a privileged scope not already present → 403 (unchanged).
 * - Omitting an already-granted privileged scope → the scope is PRESERVED
 *   (re-added to the result), never silently revoked. Removing a privileged
 *   scope requires staff.
 *
 * `previousScopes` supplies the currently-granted set to reconcile against; it
 * is empty on create (nothing to preserve) and the stored scopes on update.
 * Staff callers get an authoritative replace of exactly what they submit,
 * including intentional privileged-scope removal. Returns the validated,
 * deduplicated scope list.
 */
function authorizeRequestedScopes(
  req: AuthRequest,
  requestedScopes: ApplicationScope[],
  previousScopes: readonly ApplicationScope[]
): ApplicationScope[] {
  const deduped = Array.from(new Set(requestedScopes));

  if (isStaffUser(req)) {
    return deduped;
  }

  const previouslyGranted = new Set(previousScopes);
  const requested = new Set(deduped);

  const newlyAddedPrivileged = deduped.filter(
    (scope) => isPrivilegedScope(scope) && !previouslyGranted.has(scope)
  );

  if (newlyAddedPrivileged.length > 0) {
    logger.warn('Non-staff actor attempted to grant privileged application scope', {
      userId: requireUserId(req),
      scopes: newlyAddedPrivileged,
    });
    throw new ForbiddenError(
      `Granting the scope(s) [${newlyAddedPrivileged.join(', ')}] requires Oxy platform staff privileges`
    );
  }

  // Preserve already-granted privileged scopes a non-staff caller omitted:
  // revoking a privileged scope is a staff-only mutation, so an omission is
  // treated as "leave it untouched" rather than a silent revoke.
  const preservedPrivileged = Array.from(previouslyGranted).filter(
    (scope) => isPrivilegedScope(scope) && !requested.has(scope)
  );
  if (preservedPrivileged.length > 0) {
    logger.warn('Preserving already-granted privileged application scope omitted by non-staff actor', {
      userId: requireUserId(req),
      scopes: preservedPrivileged,
    });
  }

  return [...deduped, ...preservedPrivileged];
}

/**
 * Serialised caller membership embedded on an application. Derived from the
 * caller's effective account role over `ownerAccountId` (no per-app member row).
 */
interface SerializedCallerMembership {
  role: AccountRole;
  permissions: ApplicationPermission[];
  source: 'account';
  ownerAccountId: string;
}

/** Serialise an application for client responses (no webhook secret). */
function serializeApplication(
  app: IApplication,
  callerMembership?: SerializedCallerMembership | null
) {
  return {
    _id: app._id.toString(),
    name: app.name,
    description: app.description,
    websiteUrl: app.websiteUrl,
    privacyPolicyUrl: app.privacyPolicyUrl,
    termsUrl: app.termsUrl,
    icon: app.icon,
    type: app.type,
    status: app.status,
    isOfficial: app.isOfficial,
    isInternal: app.isInternal,
    capabilities: app.capabilities ?? [],
    redirectUris: app.redirectUris ?? [],
    scopes: app.scopes ?? [],
    webhookUrl: app.webhookUrl,
    devWebhookUrl: app.devWebhookUrl,
    ownerAccountId: app.ownerAccountId.toString(),
    createdByUserId: app.createdByUserId.toString(),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    callerMembership: callerMembership ?? null,
  };
}

/** Serialise a credential for client responses — NEVER includes the secret hash. */
function serializeCredential(credential: IApplicationCredential) {
  return {
    _id: credential._id.toString(),
    applicationId: credential.applicationId.toString(),
    name: credential.name,
    publicKey: credential.publicKey,
    type: credential.type,
    environment: credential.environment,
    scopes: credential.scopes,
    status: credential.status,
    lastUsedAt: credential.lastUsedAt,
    expiresAt: credential.expiresAt,
    rotatedFromCredentialId: credential.rotatedFromCredentialId
      ? credential.rotatedFromCredentialId.toString()
      : undefined,
    createdByUserId: credential.createdByUserId.toString(),
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

/** Aggregate usage statistics for the supplied match filter. */
async function getUsageStats(matchFilter: Record<string, unknown>) {
  const [usage] = await ApiKeyUsage.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: null,
        totalRequests: { $sum: 1 },
        totalTokens: { $sum: '$tokensUsed' },
        totalCredits: { $sum: '$creditsUsed' },
        avgResponseTime: { $avg: '$responseTime' },
        successfulRequests: { $sum: { $cond: [{ $lt: ['$statusCode', 400] }, 1, 0] } },
        errorRequests: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
      },
    },
  ]);

  const byDay = await ApiKeyUsage.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
        requests: { $sum: 1 },
        tokens: { $sum: '$tokensUsed' },
        credits: { $sum: '$creditsUsed' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byEndpoint = await ApiKeyUsage.aggregate([
    { $match: matchFilter },
    {
      $group: {
        _id: '$endpoint',
        requests: { $sum: 1 },
        tokens: { $sum: '$tokensUsed' },
      },
    },
    { $sort: { requests: -1 } },
    { $limit: 10 },
  ]);

  return {
    summary: usage || {
      totalRequests: 0,
      totalTokens: 0,
      totalCredits: 0,
      avgResponseTime: 0,
      successfulRequests: 0,
      errorRequests: 0,
    },
    byDay,
    byEndpoint,
  };
}

/** Generate a fresh credential public key + plaintext secret + its hash. */
function generateCredentialMaterial(): { publicKey: string; secret: string; secretHash: string } {
  const publicKey =
    CREDENTIAL_PUBLIC_KEY_PREFIX + crypto.randomBytes(PUBLIC_KEY_RANDOM_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_RANDOM_BYTES).toString('hex');
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
  return { publicKey, secret, secretHash };
}

/** Build the `callerMembership` projection from resolved access. */
function callerMembershipFromAccess(access: AppAccess | undefined): SerializedCallerMembership | null {
  if (!access) return null;
  return {
    role: access.role,
    permissions: [...access.permissions],
    source: 'account',
    ownerAccountId: access.application.ownerAccountId.toString(),
  };
}

/**
 * Resolve the application (non-deleted) and the caller's effective access for
 * `:appId`. Access is the caller's effective `AccountMember` role over
 * `app.ownerAccountId` (with inheritance), mapped to application permissions.
 * Returns 404 when the app is missing/deleted and 403 when the caller has no
 * account access to its owner.
 */
async function loadApplicationContext(req: AppContextRequest): Promise<AppAccess> {
  const userId = requireUserId(req);
  const appId = req.params.appId;

  if (!mongoose.isValidObjectId(appId)) {
    throw new NotFoundError('Application not found');
  }

  const application = await Application.findOne({
    _id: appId,
    status: { $ne: 'deleted' },
  });
  if (!application) {
    throw new NotFoundError('Application not found');
  }

  const accountAccess = await accountService.resolveEffectiveAccess(
    userId,
    application.ownerAccountId.toString()
  );
  if (!accountAccess) {
    throw new ForbiddenError('You do not have access to this application');
  }

  const permissions = new Set<ApplicationPermission>(
    appPermissionsForAccountRole(accountAccess.role)
  );

  const access: AppAccess = { application, role: accountAccess.role, permissions };
  req.application = application;
  req.access = access;
  return access;
}

/**
 * RBAC middleware factory. Resolves the application + caller's effective access
 * for `:appId`, then enforces that the access carries `permission`.
 */
function requireAppPermission(permission: ApplicationPermission) {
  return asyncHandler(async (req: AppContextRequest, _res, next) => {
    const { permissions } = await loadApplicationContext(req);
    if (!permissions.has(permission)) {
      throw new ForbiddenError(`Missing required permission: ${permission}`);
    }
    next();
  });
}

// ============================================================================
// Applications — CRUD
// ============================================================================

/**
 * List applications the caller can access — i.e. every app whose owning account
 * is in the caller's accessible account forest (their own account + every
 * account they are a member of, with subtrees).
 *
 * With `?ownerAccountId=<id>`: returns only that account's applications, and
 * only if the caller has effective access to that account (otherwise 403).
 */
router.get(
  '/',
  validate({ query: listApplicationsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = requireUserId(req);
    const ownerAccountIdFilter = req.query.ownerAccountId as string | undefined;

    // The caller's effective account role per accessible account id.
    const roleByAccountId = new Map<string, AccountRole>();

    if (ownerAccountIdFilter !== undefined) {
      if (!mongoose.isValidObjectId(ownerAccountIdFilter)) {
        throw new NotFoundError('Account not found');
      }
      const access = await accountService.resolveEffectiveAccess(userId, ownerAccountIdFilter);
      if (!access) {
        throw new ForbiddenError('You do not have access to this account');
      }
      if (!appPermissionsForAccountRole(access.role).includes('app:read')) {
        throw new ForbiddenError('Missing required permission: app:read');
      }
      roleByAccountId.set(ownerAccountIdFilter, access.role);
    } else {
      const nodes = await accountService.listAccessibleAccounts(userId);
      for (const node of nodes) {
        const role: AccountRole | undefined =
          node.relationship === 'self' ? 'owner' : node.callerMembership?.role;
        if (role && appPermissionsForAccountRole(role).includes('app:read')) {
          roleByAccountId.set(node.accountId, role);
        }
      }
    }

    const accountIds = [...roleByAccountId.keys()].map((id) => new mongoose.Types.ObjectId(id));
    if (accountIds.length === 0) {
      res.json({ applications: [] });
      return;
    }

    const applications = await Application.find({
      ownerAccountId: { $in: accountIds },
      status: { $ne: 'deleted' },
    }).sort({ createdAt: -1 });

    res.json({
      applications: applications.map((app) => {
        const role = roleByAccountId.get(app.ownerAccountId.toString());
        const callerMembership = role
          ? {
              role,
              permissions: appPermissionsForAccountRole(role),
              source: 'account' as const,
              ownerAccountId: app.ownerAccountId.toString(),
            }
          : null;
        return serializeApplication(app, callerMembership);
      }),
    });
  })
);

/**
 * Create a new application owned by an account.
 *
 * `ownerAccountId` defaults to the caller's OWN account when omitted (a
 * top-level app they own). The caller must hold `apps:create` over the owning
 * account. Staff-only fields default and are not settable here.
 */
router.post(
  '/',
  validate({ body: createApplicationSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = requireUserId(req);
    const body = req.body as {
      ownerAccountId?: string;
      name: string;
      description?: string;
      websiteUrl?: string;
      privacyPolicyUrl?: string;
      termsUrl?: string;
      icon?: string;
      redirectUris?: string[];
      scopes?: typeof APPLICATION_SCOPES[number][];
    };

    const ownerAccountId = body.ownerAccountId ?? userId;
    if (!mongoose.isValidObjectId(ownerAccountId)) {
      throw new BadRequestError('Invalid ownerAccountId');
    }

    const access = await accountService.resolveEffectiveAccess(userId, ownerAccountId);
    if (!access) {
      throw new ForbiddenError('You do not have access to the owning account');
    }
    if (!access.permissions.includes('apps:create')) {
      throw new ForbiddenError('Missing required permission: apps:create');
    }

    // Privileged scopes (e.g. federation:write) are NOT self-grantable.
    const scopes = authorizeRequestedScopes(req, body.scopes ?? [], []);

    const application = await Application.create({
      name: body.name,
      description: body.description,
      websiteUrl: body.websiteUrl || undefined,
      privacyPolicyUrl: body.privacyPolicyUrl || undefined,
      termsUrl: body.termsUrl || undefined,
      icon: body.icon ? stripSensitiveUrlQueryParams(body.icon) : body.icon,
      redirectUris: resolveRedirectUris(body) ?? [],
      scopes,
      ownerAccountId: new mongoose.Types.ObjectId(ownerAccountId),
      createdByUserId: new mongoose.Types.ObjectId(userId),
    });

    // A newly-created app is `active` and may carry redirectUris, so it can add
    // origins to the approved-clients allow-list. Drop the cached set.
    if (application.status === 'active' && (application.redirectUris?.length ?? 0) > 0) {
      refreshDynamicCorsOrigins();
    }

    logger.info('Application created', {
      userId,
      applicationId: application._id.toString(),
      ownerAccountId: ownerAccountId,
      name: application.name,
    });

    const callerMembership: SerializedCallerMembership = {
      role: access.role,
      permissions: appPermissionsForAccountRole(access.role),
      source: 'account',
      ownerAccountId: ownerAccountId,
    };

    res.status(201).json({
      application: serializeApplication(application, callerMembership),
    });
  })
);

/**
 * Get a single application the caller can read.
 */
router.get(
  '/:appId',
  validate({ params: appIdRouteParams }),
  requireAppPermission('app:read'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }
    res.json({
      application: serializeApplication(application, callerMembershipFromAccess(req.access)),
    });
  })
);

/**
 * Partially update an application. Staff-only fields are applied only when the
 * caller is platform staff; otherwise they are silently dropped.
 */
router.patch(
  '/:appId',
  validate({ params: appIdRouteParams, body: updateApplicationSchema }),
  requireAppPermission('app:update'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    const body = req.body as {
      name?: string;
      description?: string;
      websiteUrl?: string;
      privacyPolicyUrl?: string;
      termsUrl?: string;
      icon?: string;
      redirectUris?: string[];
      scopes?: typeof APPLICATION_SCOPES[number][];
      webhookUrl?: string;
      devWebhookUrl?: string | null;
      status?: 'active' | 'suspended' | 'pending_review';
      type?: IApplication['type'];
      isOfficial?: boolean;
      isInternal?: boolean;
      capabilities?: string[];
    };

    if (body.name !== undefined) application.name = body.name;
    if (body.description !== undefined) application.description = body.description;
    if (body.websiteUrl !== undefined) application.websiteUrl = body.websiteUrl || undefined;
    if (body.privacyPolicyUrl !== undefined) {
      application.privacyPolicyUrl = body.privacyPolicyUrl || undefined;
    }
    if (body.termsUrl !== undefined) application.termsUrl = body.termsUrl || undefined;
    if (body.icon !== undefined) application.icon = stripSensitiveUrlQueryParams(body.icon);
    if (body.scopes !== undefined) {
      // Privileged scopes (e.g. federation:write) are staff-only. A non-staff
      // caller may keep an already-granted privileged scope but may not add one.
      application.scopes = authorizeRequestedScopes(req, body.scopes, application.scopes);
    }
    if (body.status !== undefined) application.status = body.status;
    if (body.devWebhookUrl !== undefined) {
      application.devWebhookUrl = body.devWebhookUrl || undefined;
    }

    const resolvedRedirectUris = resolveRedirectUris(body);
    if (resolvedRedirectUris !== undefined) {
      application.redirectUris = resolvedRedirectUris;
    }

    // Rotate the webhook secret whenever the webhook URL changes.
    if (body.webhookUrl !== undefined && body.webhookUrl !== application.webhookUrl) {
      application.webhookUrl = body.webhookUrl || undefined;
      application.webhookSecret = body.webhookUrl
        ? crypto.randomBytes(WEBHOOK_SECRET_RANDOM_BYTES).toString('hex')
        : undefined;
    }

    // Staff-only fields — applied only for platform staff, silently dropped otherwise.
    if (isStaffUser(req)) {
      if (body.type !== undefined) application.type = body.type;
      if (body.isOfficial !== undefined) application.isOfficial = body.isOfficial;
      if (body.isInternal !== undefined) application.isInternal = body.isInternal;
      if (body.capabilities !== undefined) application.capabilities = body.capabilities;
    }

    await application.save();

    // The federation-domain allow-list is DERIVED from this app's redirectUris
    // and status; invalidate eagerly so revoked redirectUris or a suspended
    // status stop authorising federation signing immediately.
    credentialDomainCache.invalidate(application._id.toString());
    refreshDynamicCorsOrigins();

    logger.info('Application updated', {
      userId: requireUserId(req),
      applicationId: application._id.toString(),
    });

    res.json({
      application: serializeApplication(application, callerMembershipFromAccess(req.access)),
    });
  })
);

/**
 * Soft-delete an application (`app:delete`).
 */
router.delete(
  '/:appId',
  validate({ params: appIdRouteParams }),
  requireAppPermission('app:delete'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    application.status = 'deleted';
    await application.save();

    // A deleted app must immediately stop authorising federation signing.
    credentialDomainCache.invalidate(application._id.toString());
    refreshDynamicCorsOrigins();

    logger.info('Application deleted', {
      userId: requireUserId(req),
      applicationId: application._id.toString(),
    });

    res.json({ success: true });
  })
);

// ============================================================================
// Credentials
// ============================================================================

/**
 * List credentials for an application. Never includes secret material.
 */
router.get(
  '/:appId/credentials',
  validate({ params: appIdRouteParams }),
  requireAppPermission('credentials:read'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    const credentials = await ApplicationCredential.find({
      applicationId: application._id,
    })
      .select('-secretHash')
      .sort({ createdAt: -1 });

    res.json({ credentials: credentials.map(serializeCredential) });
  })
);

/**
 * Create a credential.
 *
 * The plaintext `secret` is returned in the response body EXACTLY ONCE and can
 * never be retrieved again — only its SHA-256 hash is persisted. `public`
 * credentials carry no secret (the `secret` field is `null`).
 */
router.post(
  '/:appId/credentials',
  validate({ params: appIdRouteParams, body: createCredentialSchema }),
  requireAppPermission('credentials:create'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    const body = req.body as {
      name: string;
      type: IApplicationCredential['type'];
      environment: IApplicationCredential['environment'];
      scopes?: ApplicationScope[];
    };

    // A credential may never exceed its owning application's authority.
    const requestedScopes = body.scopes ?? [];

    // Service credentials mint bearer service tokens for Oxy-to-Oxy / internal
    // routes. Only platform-trusted applications may hold them — EXCEPT a
    // narrow Oxy Pay carve-out: a non-trusted (`third_party`) application MAY
    // create a service credential when every requested scope is a payments
    // scope ({@link isPaymentsScope}, i.e. `payments:read`/`payments:write`).
    // Those two scopes are already non-privileged/self-grantable and bounded
    // to the app's own Oxy Pay Gateway tenant (see `applicationScopes.ts`),
    // and the resulting service token's downstream authority is bounded by
    // its scopes — the Oxy Pay Gateway only honours `payments:*`. This lets
    // external Oxy Pay merchants (WooCommerce, Mercaria, etc.) self-serve the
    // service credential the `@oxyhq/pay` SDK needs, without ever letting a
    // self-service app mint a trusted service token for files/user/
    // federation/etc. Requesting ANY non-payments scope on a service
    // credential still requires platform trust — the check below is
    // unaffected for that case.
    const isPaymentsOnlyServiceCredential =
      requestedScopes.length > 0 && requestedScopes.every(isPaymentsScope);
    if (
      body.type === 'service' &&
      !isTrustedApplication(application) &&
      !isPaymentsOnlyServiceCredential
    ) {
      throw new ForbiddenError('Service credentials are only available to trusted applications');
    }

    const grantableScopes = new Set(application.scopes);
    const ungrantable = requestedScopes.filter((scope) => !grantableScopes.has(scope));
    if (ungrantable.length > 0) {
      throw new BadRequestError(
        `Credential scope(s) [${ungrantable.join(', ')}] are not granted to this application`
      );
    }

    const { publicKey, secret, secretHash } = generateCredentialMaterial();
    const isPublicClient = body.type === 'public';

    const credential = await ApplicationCredential.create({
      applicationId: application._id,
      name: body.name,
      secretHash: isPublicClient ? undefined : secretHash,
      publicKey,
      type: body.type,
      environment: body.environment,
      scopes: requestedScopes,
      status: 'active',
      createdByUserId: new mongoose.Types.ObjectId(requireUserId(req)),
    });

    logger.info('Application credential created', {
      applicationId: application._id.toString(),
      credentialId: credential._id.toString(),
      type: credential.type,
      by: requireUserId(req),
    });

    res.status(201).json({
      credential: serializeCredential(credential),
      secret: isPublicClient ? null : secret,
    });
  })
);

/**
 * Rotate a credential — zero-downtime. Mints a replacement (fresh keys) then
 * deprecates the previous one with a 7-day grace `expiresAt`. The new plaintext
 * `secret` is returned EXACTLY ONCE.
 */
router.post(
  '/:appId/credentials/:credId/rotate',
  validate({ params: appCredentialParams }),
  requireAppPermission('credentials:rotate'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    if (!mongoose.isValidObjectId(req.params.credId)) {
      throw new NotFoundError('Credential not found');
    }

    const previous = await ApplicationCredential.findOne({
      _id: req.params.credId,
      applicationId: application._id,
      status: { $ne: 'revoked' },
    });
    if (!previous) {
      throw new NotFoundError('Credential not found');
    }

    if (previous.type === 'public') {
      throw new BadRequestError('Public credentials do not have a rotatable secret');
    }

    const { publicKey, secret, secretHash } = generateCredentialMaterial();

    const rotated = await ApplicationCredential.create({
      applicationId: application._id,
      name: previous.name,
      publicKey,
      secretHash,
      type: previous.type,
      environment: previous.environment,
      scopes: previous.scopes,
      status: 'active',
      rotatedFromCredentialId: previous._id,
      createdByUserId: new mongoose.Types.ObjectId(requireUserId(req)),
    });

    const graceExpiresAt = new Date(Date.now() + CREDENTIAL_ROTATION_GRACE_MS);
    previous.status = 'deprecated';
    previous.expiresAt = graceExpiresAt;
    await previous.save();

    logger.info('Application credential rotated', {
      applicationId: application._id.toString(),
      previousCredentialId: previous._id.toString(),
      newCredentialId: rotated._id.toString(),
      graceExpiresAt: graceExpiresAt.toISOString(),
      by: requireUserId(req),
    });

    res.json({
      credential: serializeCredential(rotated),
      secret,
      rotatedFrom: previous._id.toString(),
      graceExpiresAt,
    });
  })
);

/**
 * Revoke a credential. Revoked credentials can no longer authenticate.
 */
router.delete(
  '/:appId/credentials/:credId',
  validate({ params: appCredentialParams }),
  requireAppPermission('credentials:revoke'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    if (!mongoose.isValidObjectId(req.params.credId)) {
      throw new NotFoundError('Credential not found');
    }

    const credential = await ApplicationCredential.findOne({
      _id: req.params.credId,
      applicationId: application._id,
    });
    if (!credential) {
      throw new NotFoundError('Credential not found');
    }

    credential.status = 'revoked';
    await credential.save();

    logger.info('Application credential revoked', {
      applicationId: application._id.toString(),
      credentialId: credential._id.toString(),
      by: requireUserId(req),
    });

    res.json({ success: true });
  })
);

// ============================================================================
// Usage
// ============================================================================

/**
 * Per-application usage statistics over the requested window (`24h`, `7d`,
 * `30d`, `90d`; defaults to `7d`).
 */
router.get(
  '/:appId/usage',
  validate({ params: appIdRouteParams, query: periodQuerySchema }),
  requireAppPermission('usage:read'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    const period = (req.query.period as string) || '7d';
    const startDate = getStartDate(period);

    const stats = await getUsageStats({
      appId: application._id,
      timestamp: { $gte: startDate },
    });

    res.json(stats);
  })
);

export default router;
