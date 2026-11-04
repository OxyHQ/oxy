/**
 * Application roles — an application's own permission vocabulary, the grants
 * of it to Oxy users, and the read an application's backend makes to learn what
 * the person in front of it holds (`docs/auth/application-roles.md`).
 *
 * The routes are in `routes/applications.ts`, gated on `roles:read` /
 * `roles:manage` (`utils/accountRoles.ts`); `GET /applications/:id/roles/me`
 * is the one read every signed-in person may make, about themselves.
 *
 * ## Every actor and every subject is a HUMAN operator
 *
 * The caller passes `resolveOperatorId(req)` for both "who is granting" and
 * "who is asking", never the account the session speaks as. A person acting as
 * their organization holds the app powers granted to THEM, and a grant names the
 * person who made it — an organization cannot be an operator.
 *
 * ## Self-escalation
 *
 * A holder of `roles:manage` may not grant THEMSELVES a key, unless the
 * application is owned by their own personal account (there is nobody else who
 * could). `roles:manage` is the power to decide who operates the app, which is
 * not the same as operating it: an organization admin who wants Mercaria's
 * payments desk needs a second admin to agree. Revoking your own grant is always
 * allowed — it only ever narrows.
 *
 * ## Oxy's own applications hold keys by ROLE (ADR 0056)
 *
 * A first-party application's keys are declared in code (the first-party
 * registry) and each names the owning account's roles that hold it
 * (`held_by_account_roles`). A person holds such a key while their effective
 * role over the owning account is one of them; nobody is granted anything.
 * {@link declareFirstPartyPermissions} (the seed) is the only writer of those
 * roles, and it revokes every grant on the application. The routes refuse a
 * Console declaration or grant on one of Oxy's own applications. The read,
 * {@link permissionsHeldBy}, is the same for every application: live grants
 * plus role-held keys.
 */

import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  APPLICATION_ROLE_ERROR_CODES,
  APPLICATION_ROLE_GRANTS_PAGE_DEFAULT,
  type ApplicationPermissionDeclaration,
  type ApplicationPermissionDefinition,
  type ApplicationRoleGrant,
  type DeclareApplicationPermissionsResponse,
} from '@oxy.so/contracts';
import { getDb, type Transaction } from '../config/postgres';
import {
  applicationRoleGrants,
  applicationRolePermissions,
  applications,
  users,
} from '../db/schema';
import {
  type AccountRole,
  canonicalAccountRoles,
  operatorKeysHeldByAccountRole,
} from '../utils/accountRoles';
import { ApiError, BadRequestError, NotFoundError } from '../utils/error';
import { accountService } from './account.service';

/** What a grant revoked by retiring its key says about why. */
export const RETIRED_PERMISSION_REVOKE_REASON = 'Permission retired';

/** What a grant revoked because its application is one of Oxy's own says. */
export const FIRST_PARTY_GRANT_REVOKE_REASON =
  'First-party operator keys are held by role in the owning account (ADR 0056)';

/**
 * Whether an application is one of Oxy's own: every type but `third_party`.
 * `type` is staff-set (a non-staff PATCH drops it), so no self-service
 * application can opt into or out of this.
 */
export function isOwnApplicationType(type: string): boolean {
  return type !== 'third_party';
}

type PermissionRow = typeof applicationRolePermissions.$inferSelect;

function serializePermission(row: PermissionRow): ApplicationPermissionDefinition {
  return {
    key: row.key,
    description: row.description,
    heldByAccountRoles: [...row.heldByAccountRoles],
    declaredAt: row.createdAt.toISOString(),
    declaredByUserId: row.declaredByUserId,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
    retiredByUserId: row.retiredByUserId,
  };
}

/** The columns a grant is read with, joined to its key and grantee. */
const GRANT_COLUMNS = {
  id: applicationRoleGrants.id,
  applicationId: applicationRolePermissions.applicationId,
  permission: applicationRolePermissions.key,
  userId: applicationRoleGrants.userId,
  username: users.username,
  grantedByUserId: applicationRoleGrants.grantedByUserId,
  grantedAt: applicationRoleGrants.createdAt,
  grantReason: applicationRoleGrants.grantReason,
  revokedAt: applicationRoleGrants.revokedAt,
  revokedByUserId: applicationRoleGrants.revokedByUserId,
  revokeReason: applicationRoleGrants.revokeReason,
};

interface GrantRow {
  id: string;
  applicationId: string;
  permission: string;
  userId: string;
  username: string | null;
  grantedByUserId: string | null;
  grantedAt: Date;
  grantReason: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
}

function serializeGrant(row: GrantRow): ApplicationRoleGrant {
  return {
    ...row,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

function grantsQuery() {
  return getDb()
    .select(GRANT_COLUMNS)
    .from(applicationRoleGrants)
    .innerJoin(
      applicationRolePermissions,
      eq(applicationRolePermissions.id, applicationRoleGrants.permissionId),
    )
    .innerJoin(users, eq(users.id, applicationRoleGrants.userId));
}

// ── The read an application makes ──────────────────────────────────────────

/**
 * The live keys `userId` holds for `applicationId`, sorted: the keys granted to
 * them, plus the keys their effective role over the application's owning
 * account holds (ADR 0056).
 *
 * A grant counts only while it is unrevoked AND its key is unretired —
 * retirement revokes the grants in the same transaction, and this reads both
 * anyway so the answer can never depend on that having happened.
 *
 * A third-party application has no role-held key (nothing writes
 * `held_by_account_roles` for one), so its answer is its grants; one of Oxy's
 * own has no grants, so its answer is its role-held keys. The owning account is
 * asked only when the application has a role-held key.
 */
export async function permissionsHeldBy(applicationId: string, userId: string): Promise<string[]> {
  const db = getDb();
  const granted = await db
    .select({ key: applicationRolePermissions.key })
    .from(applicationRoleGrants)
    .innerJoin(
      applicationRolePermissions,
      eq(applicationRolePermissions.id, applicationRoleGrants.permissionId),
    )
    .where(
      and(
        eq(applicationRoleGrants.userId, userId),
        isNull(applicationRoleGrants.revokedAt),
        eq(applicationRolePermissions.applicationId, applicationId),
        isNull(applicationRolePermissions.retiredAt),
      ),
    );

  const roleHeld = await db
    .select({
      key: applicationRolePermissions.key,
      heldByAccountRoles: applicationRolePermissions.heldByAccountRoles,
      ownerAccountId: applications.ownerAccountId,
    })
    .from(applicationRolePermissions)
    .innerJoin(applications, eq(applications.id, applicationRolePermissions.applicationId))
    .where(
      and(
        eq(applicationRolePermissions.applicationId, applicationId),
        isNull(applicationRolePermissions.retiredAt),
        sql`cardinality(${applicationRolePermissions.heldByAccountRoles}) > 0`,
      ),
    );

  const held = new Set(granted.map((row) => row.key));
  const ownerAccountId = roleHeld[0]?.ownerAccountId;
  if (ownerAccountId !== undefined) {
    const access = await accountService.resolveEffectiveAccess(userId, ownerAccountId);
    if (access) {
      for (const key of operatorKeysHeldByAccountRole(access.role, roleHeld)) held.add(key);
    }
  }
  return [...held].sort();
}

// ── The vocabulary ──────────────────────────────────────────────────────────

/** The declared keys, live only unless `includeRetired`, by key then age. */
export async function listPermissions(
  applicationId: string,
  options: { includeRetired?: boolean } = {},
): Promise<ApplicationPermissionDefinition[]> {
  const rows = await getDb()
    .select()
    .from(applicationRolePermissions)
    .where(
      and(
        eq(applicationRolePermissions.applicationId, applicationId),
        options.includeRetired ? undefined : isNull(applicationRolePermissions.retiredAt),
      ),
    )
    .orderBy(
      applicationRolePermissions.key,
      applicationRolePermissions.createdAt,
      applicationRolePermissions.id,
    );
  return rows.map(serializePermission);
}

/** One key as a declaration states it, holders included. */
export interface PermissionDeclaration {
  key: string;
  description: string;
  /** Empty: held only through grants (a third-party key). */
  heldByAccountRoles: readonly AccountRole[];
}

/** What reconciling a vocabulary with a declaration does, before it is done. */
export interface DeclarationPlan {
  /** Declarations that become a new live row. */
  add: PermissionDeclaration[];
  /** Live rows to retire — missing from the declaration, or holders changed. */
  retire: PermissionRow[];
  /** Live rows that stay and take a new description. */
  describe: { row: PermissionRow; description: string }[];
}

function sameRoles(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((role) => right.includes(role));
}

/**
 * Reconcile the live vocabulary with `declared` (pure). A key whose holders
 * changed is retired and added again: `held_by_account_roles` is part of a key's
 * identity, so who could operate the application stays readable in the history.
 */
export function planDeclaration(
  live: readonly PermissionRow[],
  declared: readonly PermissionDeclaration[],
): DeclarationPlan {
  const liveByKey = new Map(live.map((row) => [row.key, row]));
  const declaredByKey = new Map(declared.map((permission) => [permission.key, permission]));
  const plan: DeclarationPlan = { add: [], retire: [], describe: [] };

  for (const row of live) {
    const wanted = declaredByKey.get(row.key);
    if (!wanted || !sameRoles(row.heldByAccountRoles, wanted.heldByAccountRoles)) {
      plan.retire.push(row);
    } else if (row.description !== wanted.description) {
      plan.describe.push({ row, description: wanted.description });
    }
  }
  for (const permission of declared) {
    const existing = liveByKey.get(permission.key);
    if (!existing || !sameRoles(existing.heldByAccountRoles, permission.heldByAccountRoles)) {
      plan.add.push({
        ...permission,
        heldByAccountRoles: canonicalAccountRoles(permission.heldByAccountRoles),
      });
    }
  }
  return plan;
}

/** The application row locked for a declaration, or 404. */
async function lockApplication(tx: Transaction, applicationId: string): Promise<void> {
  const [application] = await tx
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, applicationId), ne(applications.status, 'deleted')))
    .limit(1)
    .for('update');
  if (!application) {
    throw new NotFoundError('Application not found');
  }
}

async function liveRows(tx: Transaction, applicationId: string): Promise<PermissionRow[]> {
  return tx
    .select()
    .from(applicationRolePermissions)
    .where(
      and(
        eq(applicationRolePermissions.applicationId, applicationId),
        isNull(applicationRolePermissions.retiredAt),
      ),
    )
    .orderBy(
      applicationRolePermissions.key,
      applicationRolePermissions.createdAt,
      applicationRolePermissions.id,
    );
}

/**
 * Write `plan`. Retiring a key revokes its live grants in the same statement
 * set, so no reader ever sees a retired key still held. Returns how many grants
 * the retirement revoked.
 */
async function applyDeclaration(
  tx: Transaction,
  applicationId: string,
  actorId: string | null,
  plan: DeclarationPlan,
): Promise<number> {
  const now = new Date();
  let revokedGrants = 0;

  if (plan.retire.length > 0) {
    const retiredIds = plan.retire.map((row) => row.id);
    await tx
      .update(applicationRolePermissions)
      .set({ retiredAt: now, retiredByUserId: actorId })
      .where(inArray(applicationRolePermissions.id, retiredIds));
    const revoked = await tx
      .update(applicationRoleGrants)
      .set({
        revokedAt: now,
        revokedByUserId: actorId,
        revokeReason: RETIRED_PERMISSION_REVOKE_REASON,
      })
      .where(
        and(
          inArray(applicationRoleGrants.permissionId, retiredIds),
          isNull(applicationRoleGrants.revokedAt),
        ),
      )
      .returning({ id: applicationRoleGrants.id });
    revokedGrants = revoked.length;
  }

  for (const { row, description } of plan.describe) {
    await tx
      .update(applicationRolePermissions)
      .set({ description })
      .where(eq(applicationRolePermissions.id, row.id));
  }

  if (plan.add.length > 0) {
    await tx.insert(applicationRolePermissions).values(
      plan.add.map((permission) => ({
        applicationId,
        key: permission.key,
        description: permission.description,
        heldByAccountRoles: [...permission.heldByAccountRoles],
        declaredByUserId: actorId,
      })),
    );
  }
  return revokedGrants;
}

/**
 * Replace a THIRD-PARTY application's vocabulary with `declared` (the Console's
 * `PUT /roles/permissions`): add the new keys, re-describe the kept ones, retire
 * the missing ones and revoke every live grant of a retired key — all in one
 * transaction. Every key it writes is held through grants only.
 *
 * Serialized on the application row (`FOR UPDATE`), which also refuses a
 * declaration racing the application's deletion.
 */
export async function declarePermissions(input: {
  applicationId: string;
  actorId: string;
  declared: readonly ApplicationPermissionDeclaration[];
}): Promise<DeclareApplicationPermissionsResponse> {
  const { applicationId, actorId } = input;
  const declared = input.declared.map((permission) => ({ ...permission, heldByAccountRoles: [] }));
  return getDb().transaction(async (tx) => {
    await lockApplication(tx, applicationId);
    const plan = planDeclaration(await liveRows(tx, applicationId), declared);
    const revokedGrants = await applyDeclaration(tx, applicationId, actorId, plan);
    const after = await liveRows(tx, applicationId);
    return {
      items: after.map(serializePermission),
      added: plan.add.map((permission) => permission.key),
      retired: plan.retire.map((row) => row.key),
      described: plan.describe.map(({ row }) => row.key),
      revokedGrants,
    };
  });
}

/** What {@link declareFirstPartyPermissions} did, or would do in a dry run. */
export interface FirstPartyDeclarationResult {
  plan: DeclarationPlan;
  /** Every grant on the application that was live, and is revoked. */
  revokedGrants: { grantId: string; userId: string; permission: string }[];
}

/**
 * Make one of Oxy's own applications' vocabulary EXACTLY its registry entry
 * (ADR 0056): keys and the roles holding them from code, and no per-person
 * grant left on any of its keys. Called by the first-party seed only; there is
 * no human declarer (`declared_by_user_id` null — the commit is the declarer).
 *
 * `dryRun` computes the same plan and the same grant list under the same lock
 * and writes nothing.
 */
export async function declareFirstPartyPermissions(input: {
  applicationId: string;
  declared: readonly PermissionDeclaration[];
  dryRun: boolean;
}): Promise<FirstPartyDeclarationResult> {
  const { applicationId, declared, dryRun } = input;
  return getDb().transaction(async (tx) => {
    await lockApplication(tx, applicationId);
    const plan = planDeclaration(await liveRows(tx, applicationId), declared);
    const live = await tx
      .select({
        grantId: applicationRoleGrants.id,
        userId: applicationRoleGrants.userId,
        permission: applicationRolePermissions.key,
      })
      .from(applicationRoleGrants)
      .innerJoin(
        applicationRolePermissions,
        eq(applicationRolePermissions.id, applicationRoleGrants.permissionId),
      )
      .where(
        and(
          eq(applicationRolePermissions.applicationId, applicationId),
          isNull(applicationRoleGrants.revokedAt),
        ),
      )
      .orderBy(applicationRolePermissions.key, applicationRoleGrants.userId);
    if (dryRun) {
      return { plan, revokedGrants: live };
    }

    await applyDeclaration(tx, applicationId, null, plan);
    if (live.length > 0) {
      await tx
        .update(applicationRoleGrants)
        .set({ revokedAt: new Date(), revokeReason: FIRST_PARTY_GRANT_REVOKE_REASON })
        .where(
          and(
            inArray(
              applicationRoleGrants.id,
              live.map((grant) => grant.grantId),
            ),
            isNull(applicationRoleGrants.revokedAt),
          ),
        );
    }
    return { plan, revokedGrants: live };
  });
}

// ── Grants ──────────────────────────────────────────────────────────────────

/** A grant list cursor: the last row's position, bound to the list's filters. */
interface GrantCursor {
  t: string;
  i: string;
  f: string;
}

function grantListFingerprint(filters: {
  applicationId: string;
  permission?: string;
  userId?: string;
  includeRevoked: boolean;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'application_role_grants',
        filters.applicationId,
        filters.permission ?? null,
        filters.userId ?? null,
        filters.includeRevoked,
      ]),
    )
    .digest('base64url')
    .slice(0, 16);
}

function encodeCursor(cursor: GrantCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string, fingerprint: string): { at: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('Invalid cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as GrantCursor).t !== 'string' ||
    typeof (parsed as GrantCursor).i !== 'string' ||
    (parsed as GrantCursor).f !== fingerprint
  ) {
    throw new BadRequestError('Invalid cursor');
  }
  const at = new Date((parsed as GrantCursor).t);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestError('Invalid cursor');
  }
  return { at, id: (parsed as GrantCursor).i };
}

/** Grants of the application's keys, newest first, live only unless `includeRevoked`. */
export async function listGrants(input: {
  applicationId: string;
  permission?: string;
  userId?: string;
  includeRevoked?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ items: ApplicationRoleGrant[]; nextCursor: string | null }> {
  const includeRevoked = input.includeRevoked === true;
  const limit = input.limit ?? APPLICATION_ROLE_GRANTS_PAGE_DEFAULT;
  const fingerprint = grantListFingerprint({ ...input, includeRevoked });
  const after = input.cursor ? decodeCursor(input.cursor, fingerprint) : null;

  const rows = await grantsQuery()
    .where(
      and(
        eq(applicationRolePermissions.applicationId, input.applicationId),
        input.permission ? eq(applicationRolePermissions.key, input.permission) : undefined,
        input.userId ? eq(applicationRoleGrants.userId, input.userId) : undefined,
        includeRevoked ? undefined : isNull(applicationRoleGrants.revokedAt),
        after
          ? or(
              lt(applicationRoleGrants.createdAt, after.at),
              and(
                eq(applicationRoleGrants.createdAt, after.at),
                lt(applicationRoleGrants.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(applicationRoleGrants.createdAt), desc(applicationRoleGrants.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(serializeGrant),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ t: last.grantedAt.toISOString(), i: last.id, f: fingerprint })
        : null,
  };
}

async function findGrant(applicationId: string, grantId: string): Promise<GrantRow | undefined> {
  const [row] = await grantsQuery()
    .where(
      and(
        eq(applicationRoleGrants.id, grantId),
        eq(applicationRolePermissions.applicationId, applicationId),
      ),
    )
    .limit(1);
  return row;
}

/** Who a grant names, resolved and checked to be a person. */
async function resolveGrantee(
  grantee: { userId: string } | { username: string },
): Promise<{ id: string; username: string | null }> {
  const [row] = await getDb()
    .select({
      id: users.id,
      username: users.username,
      kind: users.kind,
      accountStatus: users.accountStatus,
    })
    .from(users)
    .where(
      'userId' in grantee
        ? eq(users.id, grantee.userId)
        : sql`lower(btrim(${users.username})) = lower(btrim(${grantee.username}))`,
    )
    .limit(1);
  if (row?.accountStatus !== 'active') {
    throw new NotFoundError('User not found');
  }
  if (row.kind !== 'personal') {
    throw new ApiError(
      422,
      'Application permissions are granted to people, not to organizations, projects, bots or channels',
      APPLICATION_ROLE_ERROR_CODES.granteeNotAPerson,
    );
  }
  return { id: row.id, username: row.username };
}

/**
 * Grant a live key to a person. Refuses a self-grant on an application the
 * actor does not own personally (see the header), an unknown or retired key,
 * a non-person grantee, and a key the grantee already holds (409, naming the
 * live grant — a second row would make "who granted this" ambiguous).
 *
 * The key row is read `FOR SHARE`, so a concurrent retirement waits for this
 * grant to commit and then revokes it, instead of the grant landing on a key
 * that was retired underneath it.
 */
export async function grantPermission(input: {
  application: { id: string; ownerAccountId: string };
  actorId: string;
  grantee: { userId: string } | { username: string };
  permission: string;
  reason?: string;
}): Promise<ApplicationRoleGrant> {
  const { application, actorId, permission } = input;
  const grantee = await resolveGrantee(input.grantee);

  if (grantee.id === actorId && application.ownerAccountId !== actorId) {
    throw new ApiError(
      403,
      'You cannot grant yourself a permission of an application you do not own personally; another holder of roles:manage must grant it',
      APPLICATION_ROLE_ERROR_CODES.selfGrantForbidden,
    );
  }

  return getDb().transaction(async (tx) => {
    const [definition] = await tx
      .select({ id: applicationRolePermissions.id, key: applicationRolePermissions.key })
      .from(applicationRolePermissions)
      .where(
        and(
          eq(applicationRolePermissions.applicationId, application.id),
          eq(applicationRolePermissions.key, permission),
          isNull(applicationRolePermissions.retiredAt),
        ),
      )
      .limit(1)
      .for('share');
    if (!definition) {
      throw new ApiError(
        422,
        `${permission} is not a declared permission of this application`,
        APPLICATION_ROLE_ERROR_CODES.unknownPermission,
      );
    }

    // No conflict target: the only unique index a fresh uuid row can hit is the
    // live-grant one, so DO NOTHING here means "already held" and no statement
    // in this transaction fails.
    const [inserted] = await tx
      .insert(applicationRoleGrants)
      .values({
        permissionId: definition.id,
        userId: grantee.id,
        grantedByUserId: actorId,
        grantReason: input.reason ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [existing] = await tx
        .select({ id: applicationRoleGrants.id })
        .from(applicationRoleGrants)
        .where(
          and(
            eq(applicationRoleGrants.permissionId, definition.id),
            eq(applicationRoleGrants.userId, grantee.id),
            isNull(applicationRoleGrants.revokedAt),
          ),
        )
        .limit(1);
      throw new ApiError(
        409,
        `The user already holds ${permission}`,
        APPLICATION_ROLE_ERROR_CODES.alreadyGranted,
        existing ? { grantId: existing.id } : undefined,
      );
    }

    return serializeGrant({
      id: inserted.id,
      applicationId: application.id,
      permission: definition.key,
      userId: inserted.userId,
      username: grantee.username,
      grantedByUserId: inserted.grantedByUserId,
      grantedAt: inserted.createdAt,
      grantReason: inserted.grantReason,
      revokedAt: inserted.revokedAt,
      revokedByUserId: inserted.revokedByUserId,
      revokeReason: inserted.revokeReason,
    });
  });
}

/** Revoke a live grant of one of the application's keys. */
export async function revokeGrant(input: {
  applicationId: string;
  grantId: string;
  actorId: string;
  reason?: string;
}): Promise<ApplicationRoleGrant> {
  const { applicationId, grantId, actorId } = input;
  const revoked = await getDb()
    .update(applicationRoleGrants)
    .set({ revokedAt: new Date(), revokedByUserId: actorId, revokeReason: input.reason ?? null })
    .where(
      and(
        eq(applicationRoleGrants.id, grantId),
        isNull(applicationRoleGrants.revokedAt),
        inArray(
          applicationRoleGrants.permissionId,
          getDb()
            .select({ id: applicationRolePermissions.id })
            .from(applicationRolePermissions)
            .where(eq(applicationRolePermissions.applicationId, applicationId)),
        ),
      ),
    )
    .returning({ id: applicationRoleGrants.id });

  const grant = await findGrant(applicationId, grantId);
  if (!grant) {
    throw new NotFoundError('Grant not found');
  }
  if (revoked.length === 0) {
    throw new ApiError(
      409,
      'The grant was already revoked',
      APPLICATION_ROLE_ERROR_CODES.alreadyRevoked,
    );
  }
  return serializeGrant(grant);
}
