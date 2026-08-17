/**
 * Account Service — unified Account graph (tree + membership + credentials).
 *
 * The `users` row IS the principal Account. This service owns the graph
 * semantics layered on top of it:
 *  - tree maintenance (create child accounts, reparent with cycle/depth guards,
 *    materialised path rewrite);
 *  - membership resolution WITH inheritance (the nearest membership row over
 *    `[accountId, ...ancestors]` wins; ancestor rows cascade only when
 *    `inherit` is true);
 *  - `verifyActingAs` generalised to "member of accountId (directly or via an
 *    inheriting ancestor) holding `account:act_as`";
 *  - members CRUD + transfer-ownership (never removes/demotes the last owner);
 *  - service credentials for `bot`-kind accounts (7-day rotation grace).
 *
 * ## What the Postgres port changed
 *
 * - **`ancestors` is `user_ancestors`, not an embedded array.** Each edge is a
 *   row with a real foreign key and an explicit `depth`, so the ROOT-FIRST order
 *   the Mongo array carried implicitly is now stated (`db/schema/userAncestors.ts`).
 * - **`account_members.permissions` does not travel.** Every write site set it
 *   to exactly `permissionsForAccountRole(role)`; it is a derivation of `role`,
 *   not data, and the serializer keeps emitting it. What the table stores
 *   instead is the per-member ADJUSTMENT — `permission_grants` /
 *   `permission_revokes` — which a role name genuinely cannot express;
 *   `effectivePermissionsForMember` combines the three.
 * - **The session-less transaction fallback is DELETED, not translated.** The
 *   Mongoose helper string-matched a "no replica set" error and re-ran the work
 *   WITHOUT a transaction, so a subtree move on a standalone deployment ran
 *   non-atomically — a half-rewritten materialised path, silently. Postgres has
 *   no such mode, so there is nothing to fall back to.
 *
 * Pure tree/inheritance helpers are exported separately so they can be unit
 * tested without a database.
 */

import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { getDb, type Database } from '../config/postgres';
import { accountMembers } from '../db/schema/accountMembers';
import { userAncestors, MAX_ACCOUNT_DEPTH } from '../db/schema/userAncestors';
import { users } from '../db/schema/users';
import { publicColumns } from '@oxyhq/db/assert';
import {
  PROTECTED_COLUMNS_BY_TABLE,
  USERS_PROTECTED_COLUMNS,
} from '../db/schema/protectedColumns';
import type { AccountKind } from '../db/schema/users';
import {
  CHILD_ACCOUNT_KINDS,
  RETIRED_ACCOUNT_CATEGORY_IDS,
  isActAsEligibleKind,
  kindAcceptsAccountCategories,
  newlyAddedRetiredCategories,
  type AccountCategoryId,
} from '@oxyhq/contracts';
import {
  effectivePermissionsForMember,
  permissionsForAccountRole,
  type AccountPermission,
  type AccountRole,
} from '../utils/accountRoles';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../utils/error';
import { DISPLAY_NAME_INVALID_MESSAGE, isValidDisplayName } from '@oxyhq/core';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';

/**
 * The permission that authorises assuming an account's identity — what
 * `POST /accounts/:id/switch` gates on, and therefore what operating an account
 * gates on too.
 *
 * Typed as an {@link AccountPermission} so renaming or dropping it in
 * `utils/accountRoles.ts` fails this file's typecheck, rather than leaving a
 * string literal here that quietly matches nothing and reads as "no operator has
 * ever held this".
 */
const ACT_AS_PERMISSION: AccountPermission = 'account:act_as';

/**
 * Reject a name half that the display-name policy would not allow.
 *
 * Account create/update is a second write path onto the same `users` columns
 * `updateUserProfile` guards, so it has to run the same policy — otherwise the
 * policy is only enforced on whichever path the caller happens to pick.
 */
function assertValidAccountName(
  name: { first?: string; last?: string; displayName?: string } | undefined
): void {
  if (!name || typeof name !== 'object') return;
  // `displayName` is validated by the SAME policy as the human halves. It is a
  // third write path onto the display string, so exempting it would mean the
  // character policy holds only on whichever field the caller happened to use.
  for (const part of ['first', 'last', 'displayName'] as const) {
    const value = name[part];
    if (typeof value === 'string' && !isValidDisplayName(value)) {
      throw new BadRequestError(DISPLAY_NAME_INVALID_MESSAGE);
    }
  }
}

/** How the caller is related to an account in their accessible forest. */
export type AccountRelationship = 'self' | 'owner' | 'member';

/** An `account_members` row. */
export type AccountMemberRow = typeof accountMembers.$inferSelect;

/**
 * A `users` row, read as an ACCOUNT rather than as a profile — WITHOUT the
 * protected columns.
 *
 * Every read here goes through `publicColumns(users, ...)`, so the phone number, the
 * contact-discovery hashes and the refresh token never enter this service's
 * memory, let alone an account DTO. Narrowing the TYPE to match is the half that
 * a convention cannot give you: a serializer that reaches for `phone` on an
 * account now fails `tsc` instead of shipping it.
 *
 * `schema/__tests__/protectedColumns.test.ts` is the gate for the other half —
 * it scans `src/` for bare `select()` against a protected table and names the
 * `file:line`. It caught all eight sites in this batch.
 */
export type AccountRow = Omit<
  typeof users.$inferSelect,
  (typeof USERS_PROTECTED_COLUMNS)[number]
>;

/**
 * An account plus its materialised path, which is the shape every tree
 * operation needs and which no single row can carry now that `ancestors` is a
 * child table.
 */
export interface AccountWithAncestors {
  account: AccountRow;
  /** Root FIRST — `depth 0` is the tree root, the last entry is the parent. */
  ancestors: string[];
}

/** A minimal membership shape sufficient for inheritance resolution. */
export interface MembershipLike {
  accountId: string;
  role: AccountRole;
  inherit: boolean;
  status: string;
}

/**
 * One person's membership AS IT APPLIES TO a given account: the row that grants
 * it, and whether that row lives on the account or on an ancestor of it.
 *
 * The pair is the unit rather than the row alone because the row cannot say
 * which account it is being reported for — an inherited entry's `accountId` is
 * the ANCESTOR's, and a caller that reads only the row has no way to tell that
 * it may not edit it through the account it asked about.
 */
export interface EffectiveMember {
  row: AccountMemberRow;
  source: 'direct' | 'inherited';
}

/** Resolved effective access of a caller over an account. */
export interface EffectiveAccess {
  role: AccountRole;
  /**
   * What the caller may actually do: the role's baseline adjusted by the
   * membership row's own grants and revokes. Typed as the permission union
   * rather than `string[]` so a gate cannot be written against a string that is
   * not in the vocabulary — a typo in `requireAccountPermission('acount:read')`
   * would otherwise be a permanently-false check that reads as a working gate.
   */
  permissions: AccountPermission[];
  /** `self` = implicit ownership of one's own personal account. */
  source: 'self' | 'direct' | 'inherited';
  /** The concrete membership row, when the access came from one. */
  membership: AccountMemberRow | null;
}

/** A node in the caller's accessible account forest. */
export interface AccountNode {
  accountId: string;
  kind: AccountKind;
  parentAccountId: string | null;
  rootAccountId: string;
  account: AccountRow;
  relationship: AccountRelationship;
  /** The caller's effective membership ROW over this account (null for `self`). */
  callerMembership: AccountMemberRow | null;
  /** Whether `callerMembership` is a direct row or inherited from an ancestor. */
  callerMembershipSource: 'direct' | 'inherited' | null;
  childCount: number;
}

export interface CreateChildAccountInput {
  kind: Exclude<AccountKind, 'personal'>;
  username: string;
  name?: { first?: string; last?: string; displayName?: string };
  bio?: string;
  avatar?: string;
  description?: string;
  /**
   * Ordered, PRIMARY FIRST. Every child kind may carry these, so there is no
   * kind check on this path — see `createAccountRequestSchema`.
   */
  accountCategories?: AccountCategoryId[];
}

// ===========================================================================
// Pure helpers (no DB) — exported for unit testing
// ===========================================================================

/** The ancestor path a new child of `parent` should carry (root → parent). */
export function childAncestorsOf(parent: AccountWithAncestors): string[] {
  return [...parent.ancestors, parent.account.id];
}

/** The `rootAccountId` a new child of `parent` should carry. */
export function childRootOf(parent: AccountWithAncestors): string {
  return parent.account.rootAccountId ?? parent.account.id;
}

/**
 * A channel has no administrator of its own — only members — so it cannot parent
 * another channel. Stated once here so service and user create/move paths share
 * the same invariant.
 */
export function channelCannotParentChannel(
  parentKind: AccountKind | string | null | undefined,
  childKind: AccountKind | string | null | undefined
): boolean {
  return parentKind === 'channel' && childKind === 'channel';
}

/**
 * Would re-parenting `accountId` under `newParent` create a cycle? True when the
 * new parent IS the account itself, or the account is already an ancestor of the
 * new parent (i.e. the new parent is a descendant of the account).
 */
export function wouldCreateCycle(
  accountId: string,
  newParent: AccountWithAncestors
): boolean {
  if (newParent.account.id === accountId) {
    return true;
  }
  return newParent.ancestors.includes(accountId);
}

/**
 * Rewrite a descendant's path after its subtree root moved. The descendant's
 * ancestors begin with the moved node's OLD ancestors as a prefix (followed by
 * the moved node's id and any intermediate ids). Swapping that prefix for the
 * moved node's NEW ancestors preserves the in-subtree suffix.
 */
export function rewriteDescendantAncestors(
  oldSelfAncestors: string[],
  newSelfAncestors: string[],
  descendantAncestors: string[]
): string[] {
  const suffix = descendantAncestors.slice(oldSelfAncestors.length);
  return [...newSelfAncestors, ...suffix];
}

/**
 * Resolve the effective membership of a caller over an account given the
 * caller's membership rows on the account and any of its ancestors.
 *
 * Resolution walks NEAREST-FIRST: the account itself, then its ancestors from
 * immediate parent up to the root. A direct row on the account always wins
 * (its `inherit` flag only governs whether IT cascades to ITS children). An
 * ancestor row applies to the account only when `inherit` is true. Returns the
 * first matching active row, or null.
 */
export function resolveEffectiveMembership<T extends MembershipLike>(
  rows: T[],
  accountId: string,
  ancestors: string[]
): { row: T; source: 'direct' | 'inherited' } | null {
  const byAccount = new Map<string, T>();
  for (const row of rows) {
    if (row.status === 'active') {
      byAccount.set(row.accountId, row);
    }
  }
  // Nearest-first: the account, then ancestors from immediate parent → root.
  const path = [accountId, ...[...ancestors].reverse()];
  for (let i = 0; i < path.length; i++) {
    const row = byAccount.get(path[i]);
    if (!row) continue;
    if (i === 0) {
      return { row, source: 'direct' };
    }
    if (row.inherit) {
      return { row, source: 'inherited' };
    }
  }
  return null;
}

// ===========================================================================
// Internal reads
// ===========================================================================

/** Load an account with its materialised path, or null. */
async function loadAccount(
  db: Database,
  accountId: string
): Promise<AccountWithAncestors | null> {
  const [account] = await db.select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)).from(users).where(eq(users.id, accountId)).limit(1);
  if (!account) return null;
  return { account, ancestors: await loadAncestors(db, accountId) };
}

/** The root→parent path of one account. */
async function loadAncestors(db: Database, accountId: string): Promise<string[]> {
  const rows = await db
    .select({ ancestorId: userAncestors.ancestorId })
    .from(userAncestors)
    .where(eq(userAncestors.userId, accountId))
    .orderBy(asc(userAncestors.depth));
  return rows.map((row) => row.ancestorId);
}

/**
 * Replace one account's materialised path.
 *
 * Delete-then-insert rather than a positional update: the path is addressed by
 * `(user_id, depth)` and a move changes its LENGTH, so an in-place update would
 * leave the tail of a shortened path behind.
 */
async function writeAncestors(
  tx: Database,
  accountId: string,
  ancestors: string[]
): Promise<void> {
  await tx.delete(userAncestors).where(eq(userAncestors.userId, accountId));
  if (ancestors.length === 0) return;
  await tx.insert(userAncestors).values(
    ancestors.map((ancestorId, depth) => ({ userId: accountId, depth, ancestorId }))
  );
}

export class AccountService {
  // -------------------------------------------------------------------------
  // Tree maintenance
  // -------------------------------------------------------------------------

  /**
   * Create a child account under `parentAccountId`. Mints a no-login account
   * row of the requested non-personal `kind`, wires its tree fields, and records
   * the creator as an `owner` member of the new account.
   *
   * One transaction: an account whose owner membership failed to write is an
   * account nobody can administer.
   */
  async createChildAccount(
    parentAccountId: string,
    creatorUserId: string,
    input: CreateChildAccountInput
  ): Promise<{ account: AccountRow; membership: AccountMemberRow }> {
    if (!CHILD_ACCOUNT_KINDS.includes(input.kind)) {
      throw new BadRequestError(
        `A child account kind must be one of: ${CHILD_ACCOUNT_KINDS.join(', ')}`
      );
    }
    // No kind check for `accountCategories` here: `CHILD_ACCOUNT_KINDS` is
    // checked immediately above, and every child kind accepts categories
    // (`ACCOUNT_CATEGORY_KINDS`). A child kind that did not would make this
    // silently permissive, which is why the two lists are asserted equal in
    // `@oxyhq/contracts`' own test rather than left to agree by luck.
    const db = getDb();
    const parent = await loadAccount(db, parentAccountId);
    if (!parent) {
      throw new NotFoundError('Parent account not found');
    }

    if (parent.ancestors.length + 1 > MAX_ACCOUNT_DEPTH) {
      throw new BadRequestError(
        `Maximum account nesting depth (${MAX_ACCOUNT_DEPTH}) exceeded`
      );
    }
    if (channelCannotParentChannel(parent.account.kind, input.kind)) {
      throw new BadRequestError('A channel cannot own another channel');
    }

    const username = await this.resolveUniqueUsername(input.username);

    assertValidAccountName(input.name);

    const ancestors = childAncestorsOf(parent);
    const rootAccountId = childRootOf(parent);

    const { account, membership } = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          username,
          nameFirst: input.name?.first,
          nameLast: input.name?.last,
          nameDisplay: input.name?.displayName,
          bio: input.bio,
          description: input.description,
          avatar: input.avatar,
          verified: true,
          type: 'local',
          kind: input.kind,
          accountCategories: input.accountCategories,
          parentAccountId: parent.account.id,
          rootAccountId,
          accountStatus: 'active',
        })
        .returning();

      await writeAncestors(tx, created.id, ancestors);

      const [member] = await tx
        .insert(accountMembers)
        .values({
          accountId: created.id,
          memberUserId: creatorUserId,
          role: 'owner',
          inherit: true,
          status: 'active',
          invitedByUserId: creatorUserId,
          joinedAt: new Date(),
        })
        .returning();

      return { account: created, membership: member };
    });

    logger.info('Account created', {
      accountId: account.id,
      parentAccountId: parent.account.id,
      kind: input.kind,
      createdBy: creatorUserId,
    });

    return { account, membership };
  }

  /**
   * Re-parent `accountId` under `newParentId`. Rejects self-parenting, cycles
   * (the new parent being a descendant), and any move that would push the
   * subtree past `MAX_ACCOUNT_DEPTH`. Personal accounts are always roots and may
   * not be moved. The subtree's materialised paths and roots are rewritten
   * atomically — with no session-less fallback, so a standalone deployment can
   * no longer leave the tree half-rewritten.
   */
  async moveAccount(accountId: string, newParentId: string): Promise<AccountRow> {
    if (accountId === newParentId) {
      throw new BadRequestError('An account cannot be its own parent');
    }

    const db = getDb();
    const [account, newParent] = await Promise.all([
      loadAccount(db, accountId),
      loadAccount(db, newParentId),
    ]);
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    if (!newParent) {
      throw new NotFoundError('New parent account not found');
    }
    if (account.account.kind === 'personal') {
      throw new BadRequestError('A personal account is always a root and cannot be moved');
    }
    if (wouldCreateCycle(accountId, newParent)) {
      throw new BadRequestError('Cannot move an account beneath itself or one of its descendants');
    }
    if (channelCannotParentChannel(newParent.account.kind, account.account.kind)) {
      throw new BadRequestError('A channel cannot own another channel');
    }

    const oldSelfAncestors = account.ancestors;
    const newSelfAncestors = childAncestorsOf(newParent);
    const newRoot = childRootOf(newParent);

    const affectedIds: string[] = [accountId];

    const moved = await db.transaction(async (tx) => {
      // Every account whose path contains this one — the whole subtree, in one
      // indexed read (`user_ancestors_ancestor_id_idx`), which is the reason the
      // path is materialised at all.
      const descendantIds = (
        await tx
          .select({ userId: userAncestors.userId })
          .from(userAncestors)
          .where(eq(userAncestors.ancestorId, accountId))
      ).map((row) => row.userId);

      const descendantPaths = new Map<string, string[]>();
      let maxDescDepth = oldSelfAncestors.length;
      for (const descendantId of descendantIds) {
        const path = await loadAncestors(tx, descendantId);
        descendantPaths.set(descendantId, path);
        maxDescDepth = Math.max(maxDescDepth, path.length);
      }

      // Depth guard over the whole subtree.
      const subtreeRelativeDepth = maxDescDepth - oldSelfAncestors.length;
      if (newSelfAncestors.length + subtreeRelativeDepth > MAX_ACCOUNT_DEPTH) {
        throw new BadRequestError(
          `Move would exceed the maximum account nesting depth (${MAX_ACCOUNT_DEPTH})`
        );
      }

      const [updated] = await tx
        .update(users)
        .set({ parentAccountId: newParent.account.id, rootAccountId: newRoot })
        .where(eq(users.id, accountId))
        .returning();
      await writeAncestors(tx, accountId, newSelfAncestors);

      for (const [descendantId, path] of descendantPaths) {
        await writeAncestors(
          tx,
          descendantId,
          rewriteDescendantAncestors(oldSelfAncestors, newSelfAncestors, path)
        );
        await tx
          .update(users)
          .set({ rootAccountId: newRoot })
          .where(eq(users.id, descendantId));
        affectedIds.push(descendantId);
      }

      return updated;
    });

    for (const id of affectedIds) {
      userCache.invalidate(id);
    }

    logger.info('Account moved', {
      accountId,
      newParentId,
      affected: affectedIds.length,
    });

    return moved;
  }

  /**
   * Apply a whitelisted profile update to an account. Never mass-assigns —
   * only the explicit fields below are writable. A username change is validated
   * for the character policy + uniqueness.
   */
  async updateAccount(
    accountId: string,
    input: {
      username?: string;
      name?: { first?: string; last?: string; displayName?: string };
      bio?: string | null;
      avatar?: string | null;
      description?: string;
      color?: string;
      links?: string[];
      accountCategories?: AccountCategoryId[];
    }
  ): Promise<AccountRow> {
    const db = getDb();
    const [account] = await db.select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)).from(users).where(eq(users.id, accountId)).limit(1);
    if (!account) {
      throw new NotFoundError('Account not found');
    }

    const set: Partial<typeof users.$inferInsert> = {};

    if (input.accountCategories !== undefined) {
      // A person has interests, not a sector — and `users_account_categories_
      // kind_check` refuses the row anyway, so this exists to answer with a 400
      // that names the rule instead of a 500 from the driver.
      if (!kindAcceptsAccountCategories(account.kind)) {
        throw new BadRequestError(
          `An account of kind "${account.kind}" cannot carry categories`
        );
      }
      // A WITHDRAWN category may be kept, re-ordered or dropped, but not newly
      // added — which is the whole difference between withdrawing a category
      // and deleting it. Answered here rather than in the schema because it is
      // a question about this account's PREVIOUS value: a schema that refused
      // every withdrawn id would 400 the entire request whenever a client sent
      // back what it had been served.
      const newlyRetired = newlyAddedRetiredCategories(
        input.accountCategories,
        account.accountCategories,
        RETIRED_ACCOUNT_CATEGORY_IDS
      );
      if (newlyRetired.length > 0) {
        throw new BadRequestError(
          `These account categories are no longer available: ${newlyRetired.join(', ')}`
        );
      }
      // Assigned WHOLE and in the order given. Nothing sorts or de-duplicates
      // it — index 0 is the primary category, so any rewrite here would change
      // an editorial choice without erroring.
      set.accountCategories = input.accountCategories;
    }

    if (input.username !== undefined) {
      set.username = await this.resolveUniqueUsername(input.username, accountId);
    }
    if (input.name !== undefined) {
      assertValidAccountName(input.name);
      // Mongo merged the supplied halves over the stored subdocument; the two
      // columns are independent, so only the supplied half is written.
      if (input.name.first !== undefined) set.nameFirst = input.name.first;
      if (input.name.last !== undefined) set.nameLast = input.name.last;
      // An empty string CLEARS the explicit name and falls back to the composed
      // `first`/`last`, which is the only way back once one is set.
      if (input.name.displayName !== undefined) {
        set.nameDisplay = input.name.displayName === '' ? null : input.name.displayName;
      }
    }
    if (input.bio !== undefined) set.bio = input.bio;
    if (input.avatar !== undefined) set.avatar = input.avatar;
    if (input.description !== undefined) set.description = input.description;
    if (input.color !== undefined) set.color = input.color;
    if (input.links !== undefined) set.links = input.links;

    const updated =
      Object.keys(set).length > 0
        ? (await db.update(users).set(set).where(eq(users.id, accountId)).returning())[0]
        : account;

    userCache.invalidate(accountId);

    logger.info('Account updated', { accountId });
    return updated;
  }

  /**
   * Archive an account (the `DELETE /accounts/:id` action). Sets
   * `accountStatus: 'archived'` — NEVER hard-deletes, so the tree edges and
   * history survive. Personal accounts cannot be archived (use the GDPR
   * self-delete flow instead).
   */
  async archiveAccount(accountId: string): Promise<AccountRow> {
    const db = getDb();
    const [account] = await db.select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)).from(users).where(eq(users.id, accountId)).limit(1);
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    if (account.kind === 'personal') {
      throw new BadRequestError('A personal account cannot be archived');
    }

    const [archived] = await db
      .update(users)
      .set({ accountStatus: 'archived' })
      .where(eq(users.id, accountId))
      .returning();
    userCache.invalidate(accountId);

    logger.info('Account archived', { accountId });
    return archived;
  }

  /**
   * Immediate (non-archived) children of an account, annotated with the caller's
   * relationship + effective membership (so the route can emit `AccountNode`s).
   */
  async listChildren(userId: string, accountId: string): Promise<AccountNode[]> {
    const children = await getDb()
      .select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE))
      .from(users)
      .where(and(eq(users.parentAccountId, accountId), ne(users.accountStatus, 'archived')))
      .orderBy(asc(users.createdAt));
    return this.annotateAccounts(userId, children);
  }

  /**
   * The full (non-archived) subtree rooted at `accountId`, including itself,
   * annotated with the caller's relationship + effective membership.
   */
  async getSubtree(userId: string, accountId: string): Promise<AccountNode[]> {
    const subtree = await getDb()
      .select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE))
      .from(users)
      .where(
        and(
          sql`(${users.id} = ${accountId} or exists (
            select 1 from ${userAncestors}
            where ${userAncestors.userId} = ${users.id}
              and ${userAncestors.ancestorId} = ${accountId}
          ))`,
          ne(users.accountStatus, 'archived')
        )
      )
      .orderBy(asc(users.createdAt));
    return this.annotateAccounts(userId, subtree);
  }

  // -------------------------------------------------------------------------
  // Membership + inheritance
  // -------------------------------------------------------------------------

  /**
   * Resolve the caller's effective access over `accountId`, honouring
   * inheritance. A caller over their OWN personal account is an implicit owner.
   * Returns null when the caller has no access.
   */
  async resolveEffectiveAccess(
    userId: string,
    accountId: string
  ): Promise<EffectiveAccess | null> {
    if (userId === accountId) {
      // A user is the implicit owner of their own (personal) account.
      return {
        role: 'owner',
        permissions: permissionsForAccountRole('owner'),
        source: 'self',
        membership: null,
      };
    }

    const db = getDb();
    const [account] = await db
      .select({ id: users.id, accountStatus: users.accountStatus })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);
    if (!account || account.accountStatus === 'archived') {
      return null;
    }
    return this.effectiveAccessForAccount(userId, { id: account.id });
  }

  /**
   * Effective access of `userId` over an already-identified account.
   *
   * Takes an object rather than an id so a caller that has already loaded the
   * account keeps reading naturally; only the id is used, because the
   * materialised path lives in `user_ancestors` now and is read here either way.
   */
  async effectiveAccessForAccount(
    userId: string,
    account: { id?: unknown; _id?: unknown }
  ): Promise<EffectiveAccess | null> {
    const raw = account.id ?? account._id;
    const accountId = typeof raw === 'string' ? raw : String(raw ?? '');
    if (!accountId) {
      return null;
    }

    if (accountId === userId) {
      return {
        role: 'owner',
        permissions: permissionsForAccountRole('owner'),
        source: 'self',
        membership: null,
      };
    }

    const db = getDb();
    const ancestors = await loadAncestors(db, accountId);
    const pathIds = [accountId, ...ancestors];

    const rows = await db
      .select()
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.memberUserId, userId),
          inArray(accountMembers.accountId, pathIds),
          eq(accountMembers.status, 'active')
        )
      );

    const resolved = resolveEffectiveMembership(rows, accountId, ancestors);
    if (!resolved) {
      return null;
    }

    return {
      role: resolved.row.role,
      permissions: effectivePermissionsForMember(resolved.row),
      source: resolved.source,
      membership: resolved.row,
    };
  }

  /**
   * Authorise `userId` to switch INTO `accountId` (`POST /accounts/:id/switch`).
   * Authorised iff the caller's EFFECTIVE permissions carry `account:act_as`.
   * Returns the role on success, null otherwise. Also re-run to keep a
   * managed-account session bound to its operator's membership (revocation kills
   * the session).
   *
   * Read off the permission set, never off the role. The two agreed for as long
   * as permissions were a pure function of the role, but a per-member revoke of
   * `account:act_as` is precisely the grant an operator most wants to be able to
   * withdraw — a ghostwriter who may edit a channel but may not become it — and a
   * role check would silently ignore it. It would ALSO disagree with the copy of
   * this decision consumers already make: they read `account:act_as` out of the
   * `permissions` array this service serialises, so gating the session mint on
   * the role would let an app publish under an identity Oxy refuses to mint a
   * session for, and vice versa.
   */
  async verifyActingAs(userId: string, accountId: string): Promise<AccountRole | null> {
    const access = await this.resolveEffectiveAccess(userId, accountId);
    if (!access) {
      return null;
    }
    return access.permissions.includes('account:act_as') ? access.role : null;
  }

  /**
   * Whether `userId` OPERATES `accountId` — speaks with that account's voice.
   *
   * The question every self-directed moderation refusal actually wants to ask.
   * The one those routes asked was "is this account me?", which is the whole
   * truth only for a personal login: a channel, organization, project or bot is
   * never the caller's own id, and yet the caller may act for it. So an id
   * comparison answers "no" for all four and lets somebody block or restrict an
   * account they themselves operate. Being the account is ONE CASE of operating
   * it, which is why the self branch is here rather than a second rule beside
   * every caller.
   *
   * TWO FAMILIES, TWO AUTHORITIES — collapsing them into one membership test is
   * the easy way to get this wrong, in both directions at once:
   *
   *  - a **channel** can never be acted as ({@link isActAsEligibleKind} refuses
   *    it: it is a content identity, not a seat). No session can be minted whose
   *    subject is a channel, so there is no stronger right than membership to ask
   *    for — acting for a channel simply IS being one of its active members;
   *  - an **act-as-eligible** account (organization / project / bot) CAN be
   *    switched into, and `account:act_as` is the right that governs that switch.
   *    Bare membership is NOT enough: an account's `billing`, `developer` and
   *    `viewer` members are deliberately members who may not act as it, so they
   *    keep every affordance a stranger has over it, this one included;
   *  - a **personal** account that is not the caller is never operated, whoever
   *    asks, and neither is a kind added after this was written — the kinds are
   *    admitted positively, not by excluding `personal`.
   *
   * ONE MEMBERSHIP READER. It resolves through
   * {@link AccountService.resolveEffectiveAccess}, the same call
   * {@link AccountService.verifyActingAs} and the account RBAC middleware use, so
   * this cannot come to a different answer about the same person than the switch
   * endpoint does. That also means an INHERITED membership counts, exactly as it
   * does everywhere else here.
   *
   * The permission is READ off the resolved access rather than inferred from a
   * role list: a list of role names at a call site is a second copy of
   * `ROLE_PERMISSIONS`, and the copy is what goes stale the day a role is added
   * or its grants change.
   *
   * ## It answers `false` for everything it cannot positively confirm
   *
   * A missing account row, no membership, an archived account, a member without
   * the permission, a kind in neither family — all `false`, meaning the caller is
   * not confirmed as an operator and the protective action goes ahead. The
   * guarantee is deliberately the narrow one: you cannot act against an account
   * we can POSITIVELY CONFIRM you operate.
   *
   * That is the opposite direction from `verifyActingAs`, which fails closed, and
   * the two errors are not comparable in the same way. Acting AS an account is a
   * capability — granting one that cannot be verified puts words in somebody
   * else's mouth. Block and restrict are PROTECTIVE, and the caller is usually
   * the person needing protection: wrongly deciding "operates" takes away the
   * only tool they have for getting away from an account that is abusing them,
   * with nothing on screen to say why, while wrongly deciding "does not operate"
   * lets an operator do something pointless to their own account which the UI
   * never offered them and which they can undo.
   *
   * Note what is NOT in that list: a database fault. Unlike a consumer asking
   * Oxy over HTTP, this reads the same database the write it guards is about to
   * use, so there is no state where the question is unanswerable but the action
   * could still succeed. Swallowing that into `false` would convert a real outage
   * into a silent allow for a write that is itself about to fail; it propagates.
   */
  async operatesAccount(userId: string, accountId: string): Promise<boolean> {
    if (!userId || !accountId) {
      return false;
    }
    if (userId === accountId) {
      return true;
    }

    const db = getDb();
    const [account] = await db
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);
    if (!account) {
      return false;
    }

    // Ordered so the dominant case — an ordinary personal target — costs this
    // one indexed lookup and no membership read at all.
    if (account.kind !== 'channel' && !isActAsEligibleKind(account.kind)) {
      return false;
    }

    const access = await this.resolveEffectiveAccess(userId, accountId);
    if (!access) {
      return false;
    }

    return account.kind === 'channel' || access.permissions.includes(ACT_AS_PERMISSION);
  }

  /**
   * The caller's accessible account forest: their own personal account (`self`)
   * plus every account they are a direct member of and the entire subtree below
   * each. Each node is annotated with the caller's relationship + effective
   * membership and a child count.
   */
  async listAccessibleAccounts(userId: string): Promise<AccountNode[]> {
    const db = getDb();

    const directRows = await db
      .select()
      .from(accountMembers)
      .where(
        and(eq(accountMembers.memberUserId, userId), eq(accountMembers.status, 'active'))
      );
    const directAccountIds = directRows.map((row) => row.accountId);

    // `inArray`, never `= any(${jsArray})`: interpolating a JS array into `sql`
    // binds it as a single TUPLE parameter, and Postgres rejects it outright
    // with `malformed array literal`. `inArray` renders a proper `in (...)`
    // list. (The correlated `${users.id}` inside the EXISTS is safe here because
    // a raw `sql` fragment renders columns table-qualified; a subquery built
    // with the query builder would render it BARE and silently match the
    // subquery's own table instead.)
    const reachable =
      directAccountIds.length > 0
        ? or(
            eq(users.id, userId),
            inArray(users.id, directAccountIds),
            sql`exists (
              select 1 from ${userAncestors}
              where ${userAncestors.userId} = ${users.id}
                and ${inArray(userAncestors.ancestorId, directAccountIds)}
            )`
          )
        : eq(users.id, userId);

    const accounts = await db
      .select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE))
      .from(users)
      .where(and(reachable, ne(users.accountStatus, 'archived')))
      .orderBy(asc(users.createdAt));

    return this.annotateAccounts(userId, accounts, directRows);
  }

  /**
   * Annotate a set of accounts with the caller's relationship + effective
   * membership and a child count, producing `AccountNode`s. The caller's direct
   * membership rows are fetched once (or reused when supplied), and every path
   * is read in ONE query, so inheritance is resolved in-memory with no per-node
   * round trip. `childCount` is computed from the supplied set when closed
   * (forest/subtree); for a flat sibling list it falls back to a grouped count.
   */
  private async annotateAccounts(
    userId: string,
    accounts: AccountRow[],
    directRowsArg?: AccountMemberRow[]
  ): Promise<AccountNode[]> {
    const db = getDb();
    const directRows =
      directRowsArg ??
      (await db
        .select()
        .from(accountMembers)
        .where(
          and(eq(accountMembers.memberUserId, userId), eq(accountMembers.status, 'active'))
        ));

    const accountIds = accounts.map((account) => account.id);

    // Every path in one read, ordered so each account's list rebuilds root-first.
    const pathsById = new Map<string, string[]>();
    if (accountIds.length > 0) {
      const pathRows = await db
        .select({ userId: userAncestors.userId, ancestorId: userAncestors.ancestorId })
        .from(userAncestors)
        .where(inArray(userAncestors.userId, accountIds))
        .orderBy(asc(userAncestors.userId), asc(userAncestors.depth));
      for (const row of pathRows) {
        const path = pathsById.get(row.userId) ?? [];
        path.push(row.ancestorId);
        pathsById.set(row.userId, path);
      }
    }

    // Child counts: prefer the in-memory set (closed for forest/subtree). For any
    // account whose children are not in the set, fall back to a grouped count.
    const inSetChildCounts = new Map<string, number>();
    for (const account of accounts) {
      const parentId = account.parentAccountId;
      if (parentId) {
        inSetChildCounts.set(parentId, (inSetChildCounts.get(parentId) ?? 0) + 1);
      }
    }
    const needsCount = accounts.filter((a) => !inSetChildCounts.has(a.id));
    const groupedChildCounts = new Map<string, number>();
    if (needsCount.length > 0) {
      const rows = await db
        .select({ parentId: users.parentAccountId, n: sql<number>`count(*)::int` })
        .from(users)
        .where(
          and(
            inArray(
              users.parentAccountId,
              needsCount.map((a) => a.id)
            ),
            ne(users.accountStatus, 'archived')
          )
        )
        .groupBy(users.parentAccountId);
      for (const row of rows) {
        if (row.parentId) groupedChildCounts.set(row.parentId, row.n);
      }
    }

    return accounts.map((account) => {
      const ancestors = pathsById.get(account.id) ?? [];
      const isSelf = account.id === userId;

      let relationship: AccountRelationship;
      let callerMembership: AccountMemberRow | null = null;
      let callerMembershipSource: 'direct' | 'inherited' | null = null;

      if (isSelf) {
        relationship = 'self';
      } else {
        const resolved = resolveEffectiveMembership(directRows, account.id, ancestors);
        relationship = resolved?.row.role === 'owner' ? 'owner' : 'member';
        if (resolved) {
          callerMembership = resolved.row;
          callerMembershipSource = resolved.source;
        }
      }

      return {
        accountId: account.id,
        kind: account.kind,
        parentAccountId: account.parentAccountId,
        rootAccountId: account.rootAccountId ?? account.id,
        account,
        relationship,
        callerMembership,
        callerMembershipSource,
        childCount: inSetChildCounts.get(account.id) ?? groupedChildCounts.get(account.id) ?? 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Members CRUD
  // -------------------------------------------------------------------------

  /**
   * The people who hold membership OVER an account — its direct rows plus the
   * ancestor rows that cascade into it.
   *
   * ## Why this is not the direct rows alone
   *
   * It was, and the omission was silent. `resolveEffectiveAccess` has always
   * honoured inheritance, so an ancestor row with `inherit: true` confers every
   * account permission on the descendant, `account:act_as` included — the switch
   * endpoint says so in as many words. A roster built from direct rows therefore
   * answered `[]` for an account five people could act on, and it answered it to
   * a reader those five included: measured on a real database, an inherited
   * `editor` of a child account got `200 {"members":[]}` from
   * `GET /accounts/:id/members`, having just been authorised to read it by
   * `members:read` resolved from the very row the list omitted.
   *
   * That is not a stricter answer, it is a WRONG one, and it is wrong in the
   * direction that is hardest to notice: a consumer looking itself up in this
   * list to decide whether it may act (Mention's publish-as gate does exactly
   * that) reads "not a member" for somebody Oxy would let switch INTO the
   * account. Two doors, opposite answers, no error anywhere.
   *
   * ## What each entry is
   *
   * Every direct non-removed row is present, unchanged — including `invited`
   * ones, because a pending invitation IS a member row here and the consoles
   * render the pending list as `members.filter(m => m.status === 'invited')`.
   *
   * On top of that, each person with no ACTIVE direct row contributes their
   * nearest cascading ancestor row, marked `inherited`. Keying the addition on
   * the ACTIVE direct row rather than on any row is what keeps somebody who has
   * both a pending invitation here and live inherited access from losing one of
   * those two facts: they appear in the pending list AND in the active list,
   * which is what is true of them.
   *
   * Resolution runs through {@link resolveEffectiveMembership}, once per person,
   * rather than a rule of its own — the same function
   * {@link AccountService.effectiveAccessForAccount} and
   * {@link AccountService.annotateAccounts} resolve through. So this roster
   * cannot come to a different conclusion about a person than the gate that
   * admits them: an entry marked `active` here is exactly the row
   * `resolveEffectiveAccess` would resolve for that person over this account.
   *
   * ## What it does NOT do
   *
   * It confers nothing. No access decision in this service reads it — the
   * last-owner guard queries `account_members` directly, and every gate goes
   * through `resolveEffectiveAccess` — so widening the roster changes what is
   * DISCLOSED, not what is permitted. The disclosure it adds is the identity of
   * people who can already act on the account, to readers who already hold
   * `members:read` over it, which is the question a roster exists to answer.
   *
   * An entry's `accountId` is the account its ROW lives on, so an inherited
   * entry names the ancestor — and `source` is what a caller must branch on
   * before offering to edit it, since `requireDirectMember` scopes by
   * `accountId` and will 404 an ancestor's row addressed through this account.
   */
  async listMembers(accountId: string): Promise<EffectiveMember[]> {
    const db = getDb();
    const ancestors = await loadAncestors(db, accountId);

    const direct = await db
      .select()
      .from(accountMembers)
      .where(
        and(eq(accountMembers.accountId, accountId), ne(accountMembers.status, 'removed'))
      )
      .orderBy(asc(accountMembers.createdAt));

    const entries: EffectiveMember[] = direct.map((row) => ({ row, source: 'direct' }));
    if (ancestors.length === 0) {
      return entries;
    }

    // Only rows that can actually cascade are worth loading: an ancestor row
    // that is inactive or opted out of inheritance confers nothing here, and
    // reading it would put a person in the roster the gate would refuse.
    const cascading = await db
      .select()
      .from(accountMembers)
      .where(
        and(
          inArray(accountMembers.accountId, ancestors),
          eq(accountMembers.status, 'active'),
          eq(accountMembers.inherit, true)
        )
      )
      .orderBy(asc(accountMembers.createdAt));
    if (cascading.length === 0) {
      return entries;
    }

    const withActiveDirectRow = new Set(
      direct.filter((row) => row.status === 'active').map((row) => row.memberUserId)
    );

    const byMember = new Map<string, AccountMemberRow[]>();
    for (const row of cascading) {
      if (withActiveDirectRow.has(row.memberUserId)) continue;
      const rows = byMember.get(row.memberUserId) ?? [];
      rows.push(row);
      byMember.set(row.memberUserId, rows);
    }

    for (const rows of byMember.values()) {
      // No direct row is passed, so this can only resolve to an ancestor — but
      // it is the shared resolver that decides WHICH ancestor, so nearest-first
      // precedence is the one rule rather than a second copy of it.
      const resolved = resolveEffectiveMembership(rows, accountId, ancestors);
      if (resolved) {
        entries.push({ row: resolved.row, source: resolved.source });
      }
    }

    return entries;
  }

  /**
   * Add (or re-activate) a direct membership on an account. `owner` is not
   * assignable here — ownership is granted only via {@link transferOwnership}.
   *
   * ONE statement: the compound unique on `(account_id, member_user_id)` is what
   * decides between inserting and reactivating, so the read-then-branch the
   * Mongo version ran cannot race with a concurrent invitation.
   */
  async addMember(
    accountId: string,
    callerUserId: string,
    targetUserId: string,
    role: Exclude<AccountRole, 'owner'>,
    inherit = true
  ): Promise<AccountMemberRow> {
    const db = getDb();

    const [existing] = await db
      .select({ status: accountMembers.status })
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.memberUserId, targetUserId)
        )
      )
      .limit(1);
    if (existing?.status === 'active') {
      throw new BadRequestError('User is already a member of this account');
    }

    // Both delta columns are RESET on the conflict path, not just left to their
    // insert default. A `removed` row is reactivated rather than replaced, so
    // without this a member removed while holding a grant of `credentials:create`
    // would silently carry it back in on re-invitation as a `viewer` — the
    // permissions the invite is nominally handing out being a strict subset of
    // what the row actually confers, with nothing in the request to hint at it.
    // A re-invitation is a fresh grant.
    const [member] = await db
      .insert(accountMembers)
      .values({
        accountId,
        memberUserId: targetUserId,
        role,
        permissionGrants: [],
        permissionRevokes: [],
        inherit,
        status: 'active',
        invitedByUserId: callerUserId,
        joinedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accountMembers.accountId, accountMembers.memberUserId],
        set: {
          role,
          permissionGrants: [],
          permissionRevokes: [],
          inherit,
          status: 'active',
          invitedByUserId: callerUserId,
          joinedAt: new Date(),
        },
      })
      .returning();

    logger.info('Account member added', {
      accountId,
      memberId: member.id,
      role,
      by: callerUserId,
    });

    return member;
  }

  /**
   * Change a member's role, inheritance and/or per-member permission deltas.
   *
   * An OWNER row is refused outright — not just its `role`, but its permissions
   * too. Ownership is absolute and is granted only through
   * {@link transferOwnership}; an editable owner row would let anyone holding
   * `members:update` revoke `account:delete` from the account's owner, and there
   * would then be no endpoint able to give it back.
   *
   * The caller is responsible for the escalation guard (an actor may not confer
   * a permission they do not themselves hold). It lives at the route, where the
   * actor's own effective access has already been resolved, rather than here,
   * where it would need to resolve that access a second time — the route is the
   * only caller and the guard is exercised through it.
   */
  async updateMember(
    accountId: string,
    memberId: string,
    patch: {
      role?: Exclude<AccountRole, 'owner'>;
      inherit?: boolean;
      permissionGrants?: AccountPermission[];
      permissionRevokes?: AccountPermission[];
    }
  ): Promise<AccountMemberRow> {
    const member = await this.requireDirectMember(accountId, memberId);
    if (member.role === 'owner') {
      throw new ForbiddenError(
        "An owner's membership can only be changed via transfer-ownership"
      );
    }

    const set: Partial<typeof accountMembers.$inferInsert> = {};
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.inherit !== undefined) set.inherit = patch.inherit;
    // Each delta list is assigned WHOLE, so sending `[]` is how a caller clears
    // one. That is why the route's schema treats "absent" and "empty" as
    // different requests rather than normalising them together.
    if (patch.permissionGrants !== undefined) set.permissionGrants = patch.permissionGrants;
    if (patch.permissionRevokes !== undefined) set.permissionRevokes = patch.permissionRevokes;

    if (Object.keys(set).length === 0) {
      return member;
    }

    const [updated] = await getDb()
      .update(accountMembers)
      .set(set)
      .where(eq(accountMembers.id, memberId))
      .returning();

    logger.info('Account member updated', {
      accountId,
      memberId,
      role: updated.role,
      grants: updated.permissionGrants.length,
      revokes: updated.permissionRevokes.length,
    });
    return updated;
  }

  /**
   * Remove a member. The last active owner can never be removed; an owner may
   * only be removed by another owner (enforced by the caller via `callerIsOwner`).
   */
  async removeMember(
    accountId: string,
    memberId: string,
    callerIsOwner: boolean
  ): Promise<void> {
    const db = getDb();
    const member = await this.requireDirectMember(accountId, memberId);

    if (member.role === 'owner') {
      if (!callerIsOwner) {
        throw new ForbiddenError('Only an owner may remove another owner');
      }
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(accountMembers)
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            eq(accountMembers.role, 'owner'),
            eq(accountMembers.status, 'active')
          )
        );
      if (n <= 1) {
        throw new BadRequestError('Cannot remove the last owner of an account');
      }
    }

    await db
      .update(accountMembers)
      .set({ status: 'removed' })
      .where(eq(accountMembers.id, memberId));

    logger.info('Account member removed', { accountId, memberId });
  }

  /**
   * Transfer ownership to another active member. The target is promoted to
   * `owner`; the caller's direct `owner` row (if any) is demoted to `admin`. A
   * personal account cannot be transferred.
   *
   * One transaction: a promotion whose matching demotion failed leaves TWO
   * owners, which the "cannot remove the last owner" guard then reads as safe.
   */
  async transferOwnership(
    accountId: string,
    callerUserId: string,
    targetUserId: string
  ): Promise<void> {
    const db = getDb();
    const [account] = await db
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1);
    if (!account) {
      throw new NotFoundError('Account not found');
    }
    if (account.kind === 'personal') {
      throw new BadRequestError('A personal account cannot be transferred');
    }

    if (targetUserId === callerUserId) {
      throw new BadRequestError('You already own this account');
    }

    await db.transaction(async (tx) => {
      // The promoted row's per-member deltas are CLEARED, because an owner row
      // can never be edited again (`updateMember` refuses one). Carrying an
      // admin-era revoke of `account:delete` into ownership would mint an owner
      // permanently missing a permission with no endpoint able to restore it —
      // the one shape of lockout this graph has no answer for.
      const promoted = await tx
        .update(accountMembers)
        .set({ role: 'owner', permissionGrants: [], permissionRevokes: [] })
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            eq(accountMembers.memberUserId, targetUserId),
            eq(accountMembers.status, 'active')
          )
        )
        .returning({ id: accountMembers.id });
      if (promoted.length === 0) {
        throw new NotFoundError('Target user is not an active member of this account');
      }

      await tx
        .update(accountMembers)
        .set({ role: 'admin' })
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            eq(accountMembers.memberUserId, callerUserId),
            eq(accountMembers.status, 'active'),
            eq(accountMembers.role, 'owner')
          )
        );
    });

    logger.info('Account ownership transferred', {
      accountId,
      from: callerUserId,
      to: targetUserId,
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a direct, non-removed membership row or throw 404.
   *
   * Public because the member-permission editor's escalation guards run at the
   * route (where the ACTOR's effective access is already resolved) and need the
   * target row to compare against — with the same 404 for a member of another
   * account that every other member operation gives.
   */
  async requireDirectMember(
    accountId: string,
    memberId: string
  ): Promise<AccountMemberRow> {
    const [member] = await getDb()
      .select()
      .from(accountMembers)
      .where(
        and(
          eq(accountMembers.id, memberId),
          eq(accountMembers.accountId, accountId),
          ne(accountMembers.status, 'removed')
        )
      )
      .limit(1);
    if (!member) {
      throw new NotFoundError('Member not found');
    }
    return member;
  }

  /**
   * Resolve a unique username, suffixing a numeric counter on collision (org and
   * bot accounts share the account username index with humans). Validates the
   * username character policy.
   *
   * The collision probe is written against the EXPRESSION the unique index is
   * built on — `lower(btrim(username))`, `db/schema/users.ts` — so a candidate
   * that differs only by case is REJECTED here rather than by the constraint.
   */
  private async resolveUniqueUsername(requested: string, excludeId?: string): Promise<string> {
    const base = requested.trim().toLowerCase();
    if (!base) {
      throw new BadRequestError('Username is required');
    }
    if (!/^[\w.-]+$/.test(base)) {
      throw new BadRequestError(
        'Username may only contain letters, numbers, underscores, hyphens, and dots'
      );
    }

    const db = getDb();
    let candidate = base;
    for (let suffix = 1; suffix <= 1000; suffix++) {
      const clauses = [sql`lower(btrim(${users.username})) = lower(btrim(${candidate}))`];
      if (excludeId) {
        clauses.push(ne(users.id, excludeId));
      }
      const [taken] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(...clauses))
        .limit(1);
      if (!taken) {
        return candidate;
      }
      candidate = `${base}${suffix}`;
    }
    throw new ConflictError('Could not allocate a unique username');
  }
}

export const accountService = new AccountService();
export default accountService;
