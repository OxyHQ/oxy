import express from 'express';
import crypto from 'crypto';
import { and, count, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { apiKeyUsageEvents, applicationCredentials, applications } from '../db/schema';
import {
  type APPLICATION_SCOPES,
  type ApplicationScope,
  isPaymentsScope,
  isPrivilegedScope,
} from '../utils/applicationScopes';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { isStaffUser } from '../middleware/requireStaff';
import { rateLimit } from '../middleware/rateLimiter';
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
  appPermissionsForAccountAccess,
  effectivePermissionsForMember,
  permissionsForAccountRole,
  type AccountPermission,
  type AccountRole,
  type ApplicationPermission,
} from '../utils/accountRoles';
import {
  appIdRouteParams,
  appCredentialParams,
  credentialAuditQuerySchema,
  periodQuerySchema,
  createApplicationSchema,
  listApplicationsQuerySchema,
  updateApplicationSchema,
  createCredentialSchema,
  rotateCredentialSchema,
} from '../schemas/application.schemas';
import { generateMachineCredentialToken } from '../utils/machineCredentialToken';
import { resolveOperatorId, resolveSubjectId } from '../middleware/operator';
import {
  listCredentialAuditTrail,
  recordCredentialLifecycleEvent,
} from '../services/applicationCredentialAudit.service';
import {
  storeListingBody,
  storeScreenshotBody,
  storeScreenshotOrderBody,
  storeScreenshotParams,
  storeScreenshotPatch,
} from '../schemas/store.schemas';
import type { AppScreenshotPlatform } from '../db/schema/appListingScreenshots';
import {
  addScreenshot,
  deleteScreenshot,
  getListingForApplication,
  listScreenshots,
  reorderScreenshots,
  submitListing,
  unpublishListing,
  updateScreenshot,
  upsertListing,
} from '../services/store.service';

/** A stored application row. */
type ApplicationRow = typeof applications.$inferSelect;

/**
 * A credential row as read by this module — every column EXCEPT the two hash
 * columns. See {@link CREDENTIAL_COLUMNS}.
 */
type CredentialRow = Omit<
  typeof applicationCredentials.$inferSelect,
  'secretHash' | 'tokenHash'
>;

/**
 * Resolved application access for the caller.
 *
 * Access to an application is DERIVED from the caller's EFFECTIVE
 * `AccountMember` access over the application's owning account
 * (`app.ownerAccountId`), honouring tree inheritance — the role's baseline with
 * the membership row's own `permission_grants` / `permission_revokes` applied,
 * mapped into the application vocabulary by `appPermissionsForAccountAccess`.
 * There is no per-app member table.
 *
 * The role is carried alongside because `callerMembership` reports it, NOT
 * because anything here may gate on it: a role name cannot see a per-member
 * delta, and gating on one is exactly the bypass issue #978 records.
 */
interface AppAccess {
  application: ApplicationRow;
  /** The caller's effective account role over `ownerAccountId`. */
  role: AccountRole;
  /** Effective application permissions — role baseline adjusted by the member's deltas. */
  permissions: Set<ApplicationPermission>;
}

/**
 * Request decorated by `loadApplicationContext` / `requireAppPermission` with
 * the resolved application and the caller's access.
 */
interface AppContextRequest extends AuthRequest {
  application?: ApplicationRow;
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

/** Most-used endpoints reported by the usage summary. */
const USAGE_TOP_ENDPOINTS = 10;

/**
 * The credential columns a client may ever see — every column except
 * `secretHash` and `tokenHash`.
 *
 * Mongoose expressed this as `.select('-secretHash')`; drizzle enumerates
 * columns explicitly and has no exclusion form, so the selection is named once
 * here and reused by the list read AND by every `returning()`. A credential
 * object in this module therefore never carries either hash in the first place,
 * which is a stronger guarantee than remembering to drop it in the serializer:
 * `CredentialRow` has no such property, so a serializer that tried to read one
 * would fail `tsc`.
 *
 * `tokenPrefix` IS here. It is the machine credential's public identifier — the
 * half a Console row can render to say which key it is — and it authorises
 * nothing without the 256 secret bits that were shown exactly once.
 */
const CREDENTIAL_COLUMNS = {
  id: applicationCredentials.id,
  applicationId: applicationCredentials.applicationId,
  name: applicationCredentials.name,
  publicKey: applicationCredentials.publicKey,
  tokenPrefix: applicationCredentials.tokenPrefix,
  type: applicationCredentials.type,
  environment: applicationCredentials.environment,
  scopes: applicationCredentials.scopes,
  status: applicationCredentials.status,
  lastUsedAt: applicationCredentials.lastUsedAt,
  expiresAt: applicationCredentials.expiresAt,
  rotatedFromCredentialId: applicationCredentials.rotatedFromCredentialId,
  createdByUserId: applicationCredentials.createdByUserId,
  createdAt: applicationCredentials.createdAt,
  updatedAt: applicationCredentials.updatedAt,
};

const router = express.Router();

/**
 * The audit trail's own budget.
 *
 * The only limiter on this router, and it is here rather than on the credential
 * routes beside it because this is the one read whose cost grows with an
 * application's history: a paged trail over a table that accrues a row per
 * refused bearer, asked for by a Console panel that a member can leave open. The
 * ceiling matches `providerReadLimiter` on the BYOK trail, which answers the same
 * question about the same kind of data.
 *
 * `prefix` is mandatory and must be unique across the process: two limiters
 * sharing one Redis key make `rate-limit-redis` throw `ERR_ERL_DOUBLE_COUNT` and
 * halve both budgets. No other limiter in this package uses this one.
 */
const credentialAuditLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  prefix: 'rl:applications:credential-audit:',
});

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

/**
 * The application `requireAppPermission` already loaded, narrowed.
 *
 * The middleware has thrown 404 if it is absent, so this cannot fire; it
 * exists because `req.application` is optional on the request type and the
 * alternative is a non-null assertion, which the house rules forbid for good
 * reason.
 */
function requireApplication(req: AppContextRequest): ApplicationRow {
  if (!req.application) {
    throw new NotFoundError('Application not found');
  }
  return req.application;
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
 * is empty on create (nothing to preserve) and the stored scopes on update. It
 * is `readonly string[]` rather than `ApplicationScope[]` because the stored
 * column is a `text[]` — narrowing back to the vocabulary is what
 * `isPrivilegedScope`'s type predicate does below.
 *
 * Staff callers get an authoritative replace of exactly what they submit,
 * including intentional privileged-scope removal. Returns the validated,
 * deduplicated scope list.
 */
function authorizeRequestedScopes(
  req: AuthRequest,
  requestedScopes: ApplicationScope[],
  previousScopes: readonly string[]
): ApplicationScope[] {
  const deduped = Array.from(new Set(requestedScopes));

  if (isStaffUser(req)) {
    return deduped;
  }

  const previouslyGranted = new Set(previousScopes);
  const requested = new Set<string>(deduped);

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
    (scope): scope is ApplicationScope => isPrivilegedScope(scope) && !requested.has(scope)
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

/**
 * The wire shape of an application. Declared explicitly so a column rename or a
 * dropped field fails `tsc` here rather than silently changing the response.
 *
 * Every optional field is `?: T` and is fed `?? undefined` from its nullable
 * column: Mongo omitted an unset field entirely, and `JSON.stringify` drops an
 * `undefined` property but emits an explicit `null`. Mapping the column's NULL
 * back to `undefined` is what keeps the response byte-identical.
 */
interface SerializedApplication {
  _id: string;
  name: string;
  description?: string;
  websiteUrl?: string;
  privacyPolicyUrl?: string;
  termsUrl?: string;
  icon?: string;
  type: ApplicationRow['type'];
  status: ApplicationRow['status'];
  isOfficial: boolean;
  isInternal: boolean;
  capabilities: string[];
  redirectUris: string[];
  scopes: string[];
  webhookUrl?: string;
  devWebhookUrl?: string;
  ownerAccountId: string;
  createdByUserId?: string;
  createdAt: Date;
  updatedAt: Date;
  callerMembership: SerializedCallerMembership | null;
}

/** The wire shape of a credential — NEVER carries secret material. */
interface SerializedCredential {
  _id: string;
  applicationId: string;
  name: string;
  publicKey: string;
  /** `oxy_sk_<id>` on a `machine` credential; absent on every other type. */
  tokenPrefix?: string;
  type: CredentialRow['type'];
  environment: CredentialRow['environment'];
  scopes: string[];
  status: CredentialRow['status'];
  lastUsedAt?: Date;
  expiresAt?: Date;
  rotatedFromCredentialId?: string;
  createdByUserId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Serialise an application for client responses (no webhook secret). */
function serializeApplication(
  app: ApplicationRow,
  callerMembership?: SerializedCallerMembership | null
): SerializedApplication {
  return {
    _id: app.id,
    name: app.name,
    description: app.description ?? undefined,
    websiteUrl: app.websiteUrl ?? undefined,
    privacyPolicyUrl: app.privacyPolicyUrl ?? undefined,
    termsUrl: app.termsUrl ?? undefined,
    icon: app.icon ?? undefined,
    type: app.type,
    status: app.status,
    isOfficial: app.isOfficial,
    isInternal: app.isInternal,
    capabilities: app.capabilities,
    redirectUris: app.redirectUris,
    scopes: app.scopes,
    webhookUrl: app.webhookUrl ?? undefined,
    devWebhookUrl: app.devWebhookUrl ?? undefined,
    ownerAccountId: app.ownerAccountId,
    createdByUserId: app.createdByUserId ?? undefined,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    callerMembership: callerMembership ?? null,
  };
}

/** Serialise a credential for client responses — NEVER includes the secret hash. */
function serializeCredential(credential: CredentialRow): SerializedCredential {
  return {
    _id: credential.id,
    applicationId: credential.applicationId,
    name: credential.name,
    publicKey: credential.publicKey,
    tokenPrefix: credential.tokenPrefix ?? undefined,
    type: credential.type,
    environment: credential.environment,
    scopes: credential.scopes,
    status: credential.status,
    lastUsedAt: credential.lastUsedAt ?? undefined,
    expiresAt: credential.expiresAt ?? undefined,
    rotatedFromCredentialId: credential.rotatedFromCredentialId ?? undefined,
    createdByUserId: credential.createdByUserId ?? undefined,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
  };
}

/** Aggregate totals over the requested window. */
interface UsageSummary {
  totalRequests: number;
  totalTokens: number;
  totalCredits: number;
  avgResponseTime: number;
  successfulRequests: number;
  errorRequests: number;
}

/** Per-day usage bucket. `_id` is the UTC day key (`YYYY-MM-DD`). */
interface UsageByDay {
  _id: string;
  requests: number;
  tokens: number;
  credits: number;
}

/** Per-endpoint usage bucket. `_id` is the endpoint. */
interface UsageByEndpoint {
  _id: string;
  requests: number;
  tokens: number;
}

/** Usage statistics for one application over a period. */
interface UsageStats {
  summary: UsageSummary;
  byDay: UsageByDay[];
  byEndpoint: UsageByEndpoint[];
}

/**
 * Usage statistics for one application since `startDate`.
 *
 * `sum()` over an integer column yields `bigint`, which postgres.js hands back
 * as a STRING; every integer total is therefore cast in SQL rather than
 * converted in TypeScript. `avg` and the credit sum are already
 * double-precision. `count(*) filter (where …)` replaces Mongo's
 * `$sum: {$cond: […]}`.
 */
async function getUsageStats(applicationId: string, startDate: Date): Promise<UsageStats> {
  const db = getDb();
  const window = and(
    eq(apiKeyUsageEvents.applicationId, applicationId),
    gte(apiKeyUsageEvents.createdAt, startDate)
  );

  // Mongo's `$dateToString` formats in UTC; `to_char` over a `timestamptz`
  // formats in the SESSION time zone, so the day key is pinned to UTC here or
  // the buckets silently shift with the server's `TimeZone`.
  const dayKey = sql<string>`to_char(${apiKeyUsageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const tokenTotal = sql<number>`coalesce(sum(${apiKeyUsageEvents.tokensUsed}), 0)::int`;
  const creditTotal = sql<number>`coalesce(sum(${apiKeyUsageEvents.creditsUsed}), 0)::double precision`;

  const [summary] = await db
    .select({
      totalRequests: count(),
      totalTokens: tokenTotal,
      totalCredits: creditTotal,
      avgResponseTime: sql<number>`coalesce(avg(${apiKeyUsageEvents.responseTime}), 0)::double precision`,
      successfulRequests: sql<number>`(count(*) filter (where ${apiKeyUsageEvents.statusCode} < 400))::int`,
      errorRequests: sql<number>`(count(*) filter (where ${apiKeyUsageEvents.statusCode} >= 400))::int`,
    })
    .from(apiKeyUsageEvents)
    .where(window);

  const byDay = await db
    .select({ _id: dayKey, requests: count(), tokens: tokenTotal, credits: creditTotal })
    .from(apiKeyUsageEvents)
    .where(window)
    .groupBy(dayKey)
    .orderBy(dayKey);

  const byEndpoint = await db
    .select({ _id: apiKeyUsageEvents.endpoint, requests: count(), tokens: tokenTotal })
    .from(apiKeyUsageEvents)
    .where(window)
    .groupBy(apiKeyUsageEvents.endpoint)
    .orderBy(sql`count(*) desc`)
    .limit(USAGE_TOP_ENDPOINTS);

  return { summary, byDay, byEndpoint };
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
    ownerAccountId: access.application.ownerAccountId,
  };
}

/**
 * Resolve the application (non-deleted) and the caller's effective access for
 * `:appId`. Access is the caller's EFFECTIVE `AccountMember` access over
 * `app.ownerAccountId` (with inheritance, grants and revokes), mapped to
 * application permissions. Returns 404 when the app is missing/deleted and 403
 * when the caller has no account access to its owner.
 */
async function loadApplicationContext(req: AppContextRequest): Promise<AppAccess> {
  // The OPERATOR's access over the owning account, never the subject's. An
  // operated session authenticates as the managed account, and that account is
  // not a member of itself — asking it refuses the very people who own the
  // organization the application belongs to.
  const userId = await resolveOperatorId(req);
  const db = getDb();

  const [application] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, req.params.appId), ne(applications.status, 'deleted')))
    .limit(1);
  if (!application) {
    throw new NotFoundError('Application not found');
  }

  const accountAccess = await accountService.resolveEffectiveAccess(
    userId,
    application.ownerAccountId
  );
  if (!accountAccess) {
    throw new ForbiddenError('You do not have access to this application');
  }

  const permissions = new Set<ApplicationPermission>(
    appPermissionsForAccountAccess(accountAccess)
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
    const userId = await resolveOperatorId(req);
    const ownerAccountIdFilter = req.query.ownerAccountId as string | undefined;

    // The caller's EFFECTIVE account access per accessible account id — role
    // AND permissions, because the permissions are what `callerMembership` is
    // derived from and a role alone cannot see the member's own deltas.
    const accessByAccountId = new Map<
      string,
      { role: AccountRole; permissions: AccountPermission[] }
    >();

    if (ownerAccountIdFilter !== undefined) {
      const access = await accountService.resolveEffectiveAccess(userId, ownerAccountIdFilter);
      if (!access) {
        throw new ForbiddenError('You do not have access to this account');
      }
      accessByAccountId.set(ownerAccountIdFilter, access);
    } else {
      const nodes = await accountService.listAccessibleAccounts(userId);
      for (const node of nodes) {
        // `self` carries no membership row: a user is the implicit owner of
        // their own account, exactly as `resolveEffectiveAccess` treats it.
        if (node.relationship === 'self') {
          accessByAccountId.set(node.accountId, {
            role: 'owner',
            permissions: permissionsForAccountRole('owner'),
          });
        } else if (node.callerMembership) {
          accessByAccountId.set(node.accountId, {
            role: node.callerMembership.role,
            permissions: effectivePermissionsForMember(node.callerMembership),
          });
        }
      }
    }

    const accountIds = [...accessByAccountId.keys()];
    if (accountIds.length === 0) {
      res.json({ applications: [] });
      return;
    }

    const rows = await getDb()
      .select()
      .from(applications)
      .where(
        and(
          inArray(applications.ownerAccountId, accountIds),
          ne(applications.status, 'deleted')
        )
      )
      .orderBy(desc(applications.createdAt));

    res.json({
      applications: rows.map((app) => {
        const access = accessByAccountId.get(app.ownerAccountId);
        const callerMembership = access
          ? {
              role: access.role,
              permissions: appPermissionsForAccountAccess(access),
              source: 'account' as const,
              ownerAccountId: app.ownerAccountId,
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
    // The same three-way split `POST /accounts` needed: where it hangs is the
    // SUBJECT's question, whether it may be created is the OPERATOR's.
    const operatorId = await resolveOperatorId(req);
    const subjectId = resolveSubjectId(req);
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

    // Acting as an organization and naming no owner means "this organization",
    // which is what switching into it is for.
    const ownerAccountId = body.ownerAccountId ?? subjectId;

    const access = await accountService.resolveEffectiveAccess(operatorId, ownerAccountId);
    if (!access) {
      throw new ForbiddenError('You do not have access to the owning account');
    }
    if (!access.permissions.includes('apps:create')) {
      throw new ForbiddenError('Missing required permission: apps:create');
    }

    // Privileged scopes (e.g. federation:write) are NOT self-grantable.
    const scopes = authorizeRequestedScopes(req, body.scopes ?? [], []);

    const [application] = await getDb()
      .insert(applications)
      .values({
        name: body.name,
        description: body.description,
        websiteUrl: body.websiteUrl || undefined,
        privacyPolicyUrl: body.privacyPolicyUrl || undefined,
        termsUrl: body.termsUrl || undefined,
        icon: body.icon ? stripSensitiveUrlQueryParams(body.icon) : body.icon,
        redirectUris: resolveRedirectUris(body) ?? [],
        scopes,
        ownerAccountId,
        createdByUserId: operatorId,
      })
      .returning();

    // A newly-created app is `active` and may carry redirectUris, so it can add
    // origins to the approved-clients allow-list. Drop the cached set.
    if (application.status === 'active' && application.redirectUris.length > 0) {
      refreshDynamicCorsOrigins();
    }

    logger.info('Application created', {
      userId: operatorId,
      applicationId: application.id,
      ownerAccountId: ownerAccountId,
      name: application.name,
    });

    const callerMembership: SerializedCallerMembership = {
      role: access.role,
      permissions: appPermissionsForAccountAccess(access),
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
    const stored = req.application;
    if (!stored) {
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
      type?: ApplicationRow['type'];
      isOfficial?: boolean;
      isInternal?: boolean;
      capabilities?: string[];
    };

    // Only the fields the caller actually supplied are written, so a partial
    // update never rewrites a column it did not name.
    const updates: Partial<typeof applications.$inferInsert> = {};

    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.websiteUrl !== undefined) updates.websiteUrl = body.websiteUrl || null;
    if (body.privacyPolicyUrl !== undefined) {
      updates.privacyPolicyUrl = body.privacyPolicyUrl || null;
    }
    if (body.termsUrl !== undefined) updates.termsUrl = body.termsUrl || null;
    if (body.icon !== undefined) updates.icon = stripSensitiveUrlQueryParams(body.icon);
    if (body.scopes !== undefined) {
      // Privileged scopes (e.g. federation:write) are staff-only. A non-staff
      // caller may keep an already-granted privileged scope but may not add one.
      updates.scopes = authorizeRequestedScopes(req, body.scopes, stored.scopes);
    }
    if (body.status !== undefined) updates.status = body.status;
    if (body.devWebhookUrl !== undefined) {
      updates.devWebhookUrl = body.devWebhookUrl || null;
    }

    const resolvedRedirectUris = resolveRedirectUris(body);
    if (resolvedRedirectUris !== undefined) {
      updates.redirectUris = resolvedRedirectUris;
    }

    // Rotate the webhook secret whenever the webhook URL changes.
    if (body.webhookUrl !== undefined && body.webhookUrl !== stored.webhookUrl) {
      updates.webhookUrl = body.webhookUrl || null;
      updates.webhookSecret = body.webhookUrl
        ? crypto.randomBytes(WEBHOOK_SECRET_RANDOM_BYTES).toString('hex')
        : null;
    }

    // Staff-only fields — applied only for platform staff, silently dropped otherwise.
    if (isStaffUser(req)) {
      if (body.type !== undefined) updates.type = body.type;
      if (body.isOfficial !== undefined) updates.isOfficial = body.isOfficial;
      if (body.isInternal !== undefined) updates.isInternal = body.isInternal;
      if (body.capabilities !== undefined) updates.capabilities = body.capabilities;
    }

    // An empty patch writes nothing at all — matching Mongoose's `save()` on a
    // document with no modified paths, which also left `updatedAt` untouched.
    let application = stored;
    if (Object.keys(updates).length > 0) {
      const [updated] = await getDb()
        .update(applications)
        .set(updates)
        .where(eq(applications.id, stored.id))
        .returning();
      if (!updated) {
        throw new NotFoundError('Application not found');
      }
      application = updated;
    }

    // The federation-domain allow-list is DERIVED from this app's redirectUris
    // and status; invalidate eagerly so revoked redirectUris or a suspended
    // status stop authorising federation signing immediately.
    credentialDomainCache.invalidate(application.id);
    refreshDynamicCorsOrigins();

    logger.info('Application updated', {
      userId: requireUserId(req),
      applicationId: application.id,
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

    const [deleted] = await getDb()
      .update(applications)
      .set({ status: 'deleted' })
      .where(eq(applications.id, application.id))
      .returning({ id: applications.id });
    if (!deleted) {
      throw new NotFoundError('Application not found');
    }

    // A deleted app must immediately stop authorising federation signing.
    credentialDomainCache.invalidate(application.id);
    refreshDynamicCorsOrigins();

    logger.info('Application deleted', {
      userId: requireUserId(req),
      applicationId: application.id,
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

    const credentials = await getDb()
      .select(CREDENTIAL_COLUMNS)
      .from(applicationCredentials)
      .where(eq(applicationCredentials.applicationId, application.id))
      .orderBy(desc(applicationCredentials.createdAt));

    res.json({ credentials: credentials.map(serializeCredential) });
  })
);

/**
 * Create a credential.
 *
 * Secret material is returned in the response body EXACTLY ONCE and can never be
 * retrieved again — only a SHA-256 hash is persisted.
 *
 *  - `public` credentials carry no secret at all (`secret: null`).
 *  - `confidential` / `service` credentials return `secret`, presented BESIDE
 *    the `oxy_dk_…` client id.
 *  - `machine` credentials return `token`: the single `oxy_sk_…` bearer string a
 *    stock OpenAI SDK sends as `Authorization: Bearer …` (issue #972 §2.3).
 *    `secret` stays `null` on those, so the wire shape every existing client
 *    reads is unchanged and the two lanes are visibly distinct in the response
 *    as well as in the table.
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
      type: CredentialRow['type'];
      environment: CredentialRow['environment'];
      scopes?: ApplicationScope[];
      expiresInSeconds?: number;
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

    const isMachineCredential = body.type === 'machine';

    // A machine credential must NAME its authority. The service-token mint has a
    // documented "no scopes means the application's full grant" fallback for
    // credentials provisioned before scopes existed; there is no such legacy
    // shape here, and defaulting an external, long-lived bearer key to
    // everything its application can do is the wrong default to inherit. The
    // machine lane therefore performs no fallback, and this is what stops a
    // scopeless key resolving to no authority at all — which would fail later,
    // opaquely, at the first scope check.
    if (isMachineCredential && requestedScopes.length === 0) {
      throw new BadRequestError('A machine credential must request at least one scope');
    }

    // `expiresInSeconds` sets `expires_at` on an ACTIVE row. On every other type
    // that column means the rotation grace deadline, so accepting it there would
    // make a brand-new credential indistinguishable from a rotated one.
    if (body.expiresInSeconds !== undefined && !isMachineCredential) {
      throw new BadRequestError('expiresInSeconds is only supported on machine credentials');
    }

    const grantableScopes = new Set(application.scopes);
    const ungrantable = requestedScopes.filter((scope) => !grantableScopes.has(scope));
    if (ungrantable.length > 0) {
      throw new BadRequestError(
        `Credential scope(s) [${ungrantable.join(', ')}] are not granted to this application`
      );
    }

    // A privileged scope the APPLICATION holds is not a privileged scope any
    // member may put on a new long-lived credential. `authorizeRequestedScopes`
    // makes adding one to the application staff-only; without the same filter
    // here, a member holding `credentials:create` (the `developer` role does, and
    // it carries no `account:update`) could mint a credential carrying a scope
    // staff granted for the application's own use, and act with it. The account
    // credential path has always had this check — `accounts.ts`, "Privileged
    // scopes … are NOT self-grantable" — so the two now read the same.
    //
    // Defence in depth rather than the whole fix: `POST
    // /:appId/credentials/:credId/rotate` copies the previous credential's
    // scopes forward and returns a fresh secret, so this cannot be the only
    // thing standing between a member and a privileged credential. The surfaces
    // that matter refuse the machine lane outright (issue #972 §3).
    if (!isStaffUser(req)) {
      const privileged = requestedScopes.filter((scope) => isPrivilegedScope(scope));
      if (privileged.length > 0) {
        throw new ForbiddenError(
          `Granting the scope(s) [${privileged.join(', ')}] requires Oxy platform staff privileges`
        );
      }
    }

    const { publicKey, secret, secretHash } = generateCredentialMaterial();
    const machineToken = isMachineCredential ? generateMachineCredentialToken() : null;
    const isPublicClient = body.type === 'public';
    const expiresAt =
      body.expiresInSeconds !== undefined
        ? new Date(Date.now() + body.expiresInSeconds * 1000)
        : null;
    const actorUserId = requireUserId(req);

    // The credential and its audit row land together or neither does — a minted
    // key with no `created` event is a key nobody can account for.
    const credential = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(applicationCredentials)
        .values({
          applicationId: application.id,
          name: body.name,
          // A machine credential holds NO `secret_hash`: that column is what the
          // OAuth token endpoint and the service-token mint compare against, and
          // the table's own CHECK refuses one here anyway.
          secretHash: isPublicClient || isMachineCredential ? null : secretHash,
          publicKey,
          tokenPrefix: machineToken?.tokenPrefix ?? null,
          tokenHash: machineToken?.tokenHash ?? null,
          type: body.type,
          environment: body.environment,
          scopes: requestedScopes,
          status: 'active',
          expiresAt,
          createdByUserId: actorUserId,
        })
        .returning(CREDENTIAL_COLUMNS);

      await recordCredentialLifecycleEvent(tx, {
        applicationId: application.id,
        credentialId: row.id,
        eventType: 'created',
        actorUserId,
        environment: row.environment,
        metadata: { type: row.type, scopes: row.scopes },
        effectiveUntil: expiresAt,
      });

      return row;
    });

    logger.info('Application credential created', {
      applicationId: application.id,
      credentialId: credential.id,
      type: credential.type,
      by: actorUserId,
    });

    res.status(201).json({
      credential: serializeCredential(credential),
      secret: isPublicClient || isMachineCredential ? null : secret,
      // Present ONLY on this response and only for a machine credential. There
      // is no read path that can produce it again.
      ...(machineToken ? { token: machineToken.token } : {}),
    });
  })
);

/**
 * Rotate a credential. Mints a replacement (fresh keys) then retires the
 * previous one. The new secret material is returned EXACTLY ONCE.
 *
 * ## Two grace policies, and the difference is the point
 *
 * An OAuth/service credential is ALWAYS retired with the fixed seven-day grace
 * (`deprecated`, `expires_at = now + CREDENTIAL_ROTATION_GRACE_MS`) — unchanged,
 * because that is the contract every existing caller was written against.
 *
 * A `machine` credential's grace is OPT-IN (`graceSeconds`). Omitting it
 * `revoked`s the previous token the instant the replacement is minted; naming it
 * keeps the old token working for exactly that long and no longer. "Preserve the
 * grace window WHERE EXPLICITLY CONFIGURED" (§2.3) is a real distinction and not
 * a default: an always-on window means a leaked API key that someone rotated in
 * a hurry stays live for a week, which is the opposite of what rotating it was
 * for. `graceSeconds` is refused on the other types rather than silently
 * ignored, so nobody can believe they narrowed a window they did not.
 *
 * Both writes run in ONE transaction: a mint that landed without its matching
 * retirement would leave two live credentials for the same client, which is
 * exactly the state this is trying to control.
 */
router.post(
  '/:appId/credentials/:credId/rotate',
  validate({ params: appCredentialParams, body: rotateCredentialSchema }),
  requireAppPermission('credentials:rotate'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = req.application;
    if (!application) {
      throw new NotFoundError('Application not found');
    }

    const { graceSeconds } = req.body as { graceSeconds?: number };
    const { publicKey, secret, secretHash } = generateCredentialMaterial();
    const actorUserId = requireUserId(req);

    const { previousId, rotated, machineToken, graceExpiresAt } = await getDb().transaction(
      async (tx) => {
        const [previous] = await tx
          .select(CREDENTIAL_COLUMNS)
          .from(applicationCredentials)
          .where(
            and(
              eq(applicationCredentials.id, req.params.credId),
              eq(applicationCredentials.applicationId, application.id),
              ne(applicationCredentials.status, 'revoked')
            )
          )
          .limit(1);
        if (!previous) {
          throw new NotFoundError('Credential not found');
        }
        if (previous.type === 'public') {
          throw new BadRequestError('Public credentials do not have a rotatable secret');
        }

        const isMachineCredential = previous.type === 'machine';
        if (graceSeconds !== undefined && !isMachineCredential) {
          throw new BadRequestError(
            'graceSeconds is only supported when rotating a machine credential'
          );
        }

        // The one place the two policies are decided. `null` means "no window":
        // the previous credential is revoked outright.
        const grace = isMachineCredential
          ? graceSeconds === undefined
            ? null
            : new Date(Date.now() + graceSeconds * 1000)
          : new Date(Date.now() + CREDENTIAL_ROTATION_GRACE_MS);

        const token = isMachineCredential ? generateMachineCredentialToken() : null;

        const [minted] = await tx
          .insert(applicationCredentials)
          .values({
            applicationId: application.id,
            name: previous.name,
            publicKey,
            secretHash: isMachineCredential ? null : secretHash,
            tokenPrefix: token?.tokenPrefix ?? null,
            tokenHash: token?.tokenHash ?? null,
            type: previous.type,
            environment: previous.environment,
            scopes: previous.scopes,
            status: 'active',
            rotatedFromCredentialId: previous.id,
            createdByUserId: actorUserId,
          })
          .returning(CREDENTIAL_COLUMNS);

        await tx
          .update(applicationCredentials)
          .set(
            grace
              ? { status: 'deprecated', expiresAt: grace }
              : // No window configured: the old token stops working now. The row
                // survives — it is the audit hop `rotated_from_credential_id`
                // points back at — but `isCredentialUsable` refuses `revoked`
                // unconditionally.
                { status: 'revoked' }
          )
          .where(eq(applicationCredentials.id, previous.id));

        // Recorded against the credential the event is ABOUT — the one whose
        // token stops working. The replacement's own `created` row and its
        // `rotated_from_credential_id` carry the other half of the link.
        await recordCredentialLifecycleEvent(tx, {
          applicationId: application.id,
          credentialId: previous.id,
          eventType: 'rotated',
          actorUserId,
          environment: previous.environment,
          metadata: { rotatedToCredentialId: minted.id, graceConfigured: grace !== null },
          effectiveUntil: grace,
        });
        await recordCredentialLifecycleEvent(tx, {
          applicationId: application.id,
          credentialId: minted.id,
          eventType: 'created',
          actorUserId,
          environment: minted.environment,
          metadata: { type: minted.type, scopes: minted.scopes, rotatedFromCredentialId: previous.id },
        });

        return {
          previousId: previous.id,
          rotated: minted,
          machineToken: token,
          graceExpiresAt: grace,
        };
      }
    );

    logger.info('Application credential rotated', {
      applicationId: application.id,
      previousCredentialId: previousId,
      newCredentialId: rotated.id,
      graceExpiresAt: graceExpiresAt?.toISOString() ?? null,
      by: actorUserId,
    });

    res.json({
      credential: serializeCredential(rotated),
      secret: machineToken ? null : secret,
      ...(machineToken ? { token: machineToken.token } : {}),
      rotatedFrom: previousId,
      // `null` when no grace was configured — the previous credential is already
      // revoked and there is no deadline to report.
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

    const actorUserId = requireUserId(req);

    // One statement, and its RESULT decides the outcome: a credential that does
    // not belong to this application updates no row and is a 404. The audit row
    // rides the same transaction — a revocation nobody can date is the one this
    // trail exists to answer.
    const credential = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .update(applicationCredentials)
        .set({ status: 'revoked' })
        .where(
          and(
            eq(applicationCredentials.id, req.params.credId),
            eq(applicationCredentials.applicationId, application.id)
          )
        )
        .returning({
          id: applicationCredentials.id,
          environment: applicationCredentials.environment,
          type: applicationCredentials.type,
        });
      if (!row) {
        throw new NotFoundError('Credential not found');
      }

      await recordCredentialLifecycleEvent(tx, {
        applicationId: application.id,
        credentialId: row.id,
        eventType: 'revoked',
        actorUserId,
        environment: row.environment,
        metadata: { type: row.type },
      });

      return row;
    });

    logger.info('Application credential revoked', {
      applicationId: application.id,
      credentialId: credential.id,
      by: actorUserId,
    });

    res.json({ success: true });
  })
);

/**
 * `GET /applications/:appId/credentials/:credId/audit`
 *
 * One credential's lifecycle trail: created, rotated, revoked, and every bearer
 * that resolved to it and was still refused. Append-only in the database rather
 * than by convention — `0043_application_credential_audit_immutability.sql`.
 *
 * ## What it cannot return
 *
 * Secret material, and not because this handler is careful: the rows themselves
 * hold none (`services/applicationCredentialAudit.service.ts` is their only
 * writer and takes ids and closed enums, so there is no parameter a secret could
 * arrive through), and the wire type has no property one could occupy — see
 * {@link CredentialAuditTrailEntry}, which deliberately omits `metadata`. These
 * rows exist BECAUSE the secret was shown exactly once.
 *
 * ## Authorization is the credential routes' own, not a new one
 *
 * `credentials:read` over the owning account, through `requireAppPermission` —
 * the same gate `GET /:appId/credentials` uses, because this is the same data
 * seen through time. A caller with no access to the application gets 403 from
 * `loadApplicationContext`, exactly as every other route on this router does.
 *
 * The second refusal is the one that matters, and it is the reason this handler
 * reads the credential row before reading the trail: `:credId` is a caller-chosen
 * id, and the audit table is keyed on the credential rather than on the
 * application. Without this read, a member of account A could pass their OWN
 * `:appId` beside account B's `:credId` and be served B's trail — the shape of
 * IDOR the house rules describe, arriving through a path parameter instead of a
 * body. The statement below is scoped to the resolved application, so a
 * credential that does not belong to it is a 404 and nothing else, matching what
 * rotate and revoke already answer for the same input.
 */
router.get(
  '/:appId/credentials/:credId/audit',
  credentialAuditLimiter,
  validate({ params: appCredentialParams, query: credentialAuditQuerySchema }),
  requireAppPermission('credentials:read'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const application = requireApplication(req);
    const { limit } = credentialAuditQuerySchema.parse(req.query);

    const [credential] = await getDb()
      .select({ id: applicationCredentials.id })
      .from(applicationCredentials)
      .where(
        and(
          eq(applicationCredentials.id, req.params.credId),
          eq(applicationCredentials.applicationId, application.id)
        )
      )
      .limit(1);
    if (!credential) {
      throw new NotFoundError('Credential not found');
    }

    const events = await listCredentialAuditTrail(credential.id, limit);
    res.json({ data: events, count: events.length });
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
    res.json(await getUsageStats(application.id, getStartDate(period)));
  })
);

// ============================================================================
// Store listing
//
// The publisher's side of the app store hangs off the application, beside
// credentials, webhooks and usage, because that is what it is: one more thing
// an app has, edited by whoever may edit the app. It reuses
// `requireAppPermission` wholesale — a store page must not become a second,
// weaker way to act for somebody's application.
//
// The storefront that READS these pages is `/store`, and knows nothing about
// applications the caller may administer.
// ============================================================================

/** The application's listing in whatever state, or null when it has none. */
router.get(
  '/:appId/listing',
  validate({ params: appIdRouteParams }),
  requireAppPermission('app:read'),
  asyncHandler(async (req: AppContextRequest, res) => {
    res.json(await getListingForApplication(requireApplication(req).id));
  })
);

/**
 * Create the listing or replace its content. Never its status: publishing is
 * the store's decision and has its own routes.
 */
router.put(
  '/:appId/listing',
  validate({ params: appIdRouteParams, body: storeListingBody }),
  requireAppPermission('app:update'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const body = req.body as {
      slug: string;
      tagline?: string | null;
      description?: string | null;
      categorySlug?: string | null;
      supportUrl?: string | null;
      supportEmail?: string | null;
    };
    res.json(await upsertListing({ applicationId: requireApplication(req).id, ...body }));
  })
);

/** Hand the page to the store for review. */
router.post(
  '/:appId/listing/submit',
  validate({ params: appIdRouteParams }),
  requireAppPermission('app:update'),
  asyncHandler(async (req: AppContextRequest, res) => {
    res.json(await submitListing(requireApplication(req).id));
  })
);

/** Take it down, or withdraw it from the queue. Back to a draft, never deleted. */
router.post(
  '/:appId/listing/unpublish',
  validate({ params: appIdRouteParams }),
  requireAppPermission('app:update'),
  asyncHandler(async (req: AppContextRequest, res) => {
    res.json(await unpublishListing(requireApplication(req).id));
  })
);

/** Every picture on the listing, in the author's order. */
router.get(
  '/:appId/listing/screenshots',
  validate({ params: appIdRouteParams }),
  requireAppPermission('app:read'),
  asyncHandler(async (req: AppContextRequest, res) => {
    res.json(await listScreenshots(requireApplication(req).id));
  })
);

/**
 * Attach an already-uploaded image. Appended to the end; `…/order` moves it.
 *
 * The upload itself is `/files`, unchanged: the store stores a reference, not a
 * second copy of the asset pipeline.
 */
router.post(
  '/:appId/listing/screenshots',
  validate({ params: appIdRouteParams, body: storeScreenshotBody }),
  requireAppPermission('app:update'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const body = req.body as {
      fileId: string;
      platform?: AppScreenshotPlatform;
      caption?: string | null;
    };
    res.status(201).json(
      await addScreenshot({
        applicationId: requireApplication(req).id,
        callerUserId: requireUserId(req),
        ...body,
      })
    );
  })
);

/**
 * Set the order of every picture at once.
 *
 * Declared before `/:screenshotId` so `order` is read as the route it is, not
 * as a screenshot with that id — Express matches in declaration order.
 */
router.put(
  '/:appId/listing/screenshots/order',
  validate({ params: appIdRouteParams, body: storeScreenshotOrderBody }),
  requireAppPermission('app:update'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const { screenshotIds } = req.body as { screenshotIds: string[] };
    res.json(await reorderScreenshots({ applicationId: requireApplication(req).id, screenshotIds }));
  })
);

/** Edit a picture's caption or the frame it was taken in. */
router.patch(
  '/:appId/listing/screenshots/:screenshotId',
  validate({ params: storeScreenshotParams, body: storeScreenshotPatch }),
  requireAppPermission('app:update'),
  asyncHandler(async (req: AppContextRequest, res) => {
    const body = req.body as { platform?: AppScreenshotPlatform; caption?: string | null };
    res.json(
      await updateScreenshot({
        applicationId: requireApplication(req).id,
        screenshotId: req.params.screenshotId,
        ...body,
      })
    );
  })
);

/** Remove a picture. The file itself stays — it may be in use elsewhere. */
router.delete(
  '/:appId/listing/screenshots/:screenshotId',
  validate({ params: storeScreenshotParams }),
  requireAppPermission('app:update'),
  asyncHandler(async (req: AppContextRequest, res) => {
    await deleteScreenshot({
      applicationId: requireApplication(req).id,
      screenshotId: req.params.screenshotId,
    });
    res.status(204).end();
  })
);

export default router;
