/**
 * account.service tests — unified Account graph, against a REAL Postgres.
 *
 * This suite used to run against a hand-written in-memory emulator of the
 * Mongoose subset the service used, including array-field matching for the
 * embedded `ancestors` path. None of that survives the port, and rebuilding it
 * for Drizzle would be rebuilding the wrong thing: `ancestors` is now the
 * `user_ancestors` TABLE, membership resolution is a real query, and
 * `moveAccount` is a real transaction. An emulator can only assert the calls a
 * service makes; the properties worth protecting here — the subtree rewrite, the
 * last-owner guard, inheritance precedence, the rotation grace window — are
 * properties of stored ROWS.
 *
 * Pure tree/inheritance helpers stay unit-tested with no database, because they
 * are pure.
 *
 * The whole run shares one database, so every test mints its own accounts.
 */

import { and, eq } from 'drizzle-orm';
import {
  ACCOUNT_CATEGORY_IDS,
  CHILD_ACCOUNT_KINDS,
  type AccountCategoryId,
} from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountCredentials } from '../../db/schema/accountCredentials';
import { accountMembers } from '../../db/schema/accountMembers';
import { MAX_ACCOUNT_DEPTH, userAncestors } from '../../db/schema/userAncestors';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import {
  accountService,
  childAncestorsOf,
  childRootOf,
  channelCannotParentChannel,
  resolveEffectiveMembership,
  rewriteDescendantAncestors,
  wouldCreateCycle,
  type AccountMemberRow,
  type AccountRow,
  type MembershipLike,
} from '../account.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

// ===========================================================================
// Fixtures
// ===========================================================================

let seedCounter = 0;
function uniqueUsername(prefix: string): string {
  seedCounter += 1;
  return `${prefix}${seedCounter}z${Date.now().toString(36)}`;
}

interface SeedOptions {
  kind?: 'personal' | 'organization' | 'project' | 'bot' | 'channel';
  username?: string;
  nameFirst?: string;
  nameLast?: string;
  parentAccountId?: string;
  rootAccountId?: string;
  /** Root FIRST, matching `user_ancestors.depth` ordering. */
  ancestors?: string[];
}

async function seedAccount(options: SeedOptions = {}): Promise<AccountRow> {
  const [account] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      kind: options.kind ?? 'personal',
      username: options.username ?? uniqueUsername('acct'),
      nameFirst: options.nameFirst,
      nameLast: options.nameLast,
      parentAccountId: options.parentAccountId,
      rootAccountId: options.rootAccountId,
    })
    .returning();

  const ancestors = options.ancestors ?? [];
  if (ancestors.length > 0) {
    await getDb()
      .insert(userAncestors)
      .values(ancestors.map((ancestorId, depth) => ({ userId: account.id, ancestorId, depth })));
  }
  return account as AccountRow;
}

async function seedMember(
  accountId: string,
  memberUserId: string,
  role: AccountMemberRow['role'],
  extra: {
    inherit?: boolean;
    status?: AccountMemberRow['status'];
    permissionGrants?: string[];
    permissionRevokes?: string[];
  } = {}
): Promise<AccountMemberRow> {
  const [row] = await getDb()
    .insert(accountMembers)
    .values({
      accountId,
      memberUserId,
      role,
      inherit: extra.inherit ?? true,
      status: extra.status ?? 'active',
      permissionGrants: extra.permissionGrants ?? [],
      permissionRevokes: extra.permissionRevokes ?? [],
    })
    .returning();
  return row;
}

/** The stored materialised path, root first. */
async function ancestorsOf(accountId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ ancestorId: userAncestors.ancestorId })
    .from(userAncestors)
    .where(eq(userAncestors.userId, accountId))
    .orderBy(userAncestors.depth);
  return rows.map((row) => row.ancestorId);
}

async function reload(accountId: string) {
  const [row] = await getDb()
    .select({
      rootAccountId: users.rootAccountId,
      parentAccountId: users.parentAccountId,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
    })
    .from(users)
    .where(eq(users.id, accountId));
  return row;
}

async function memberRowById(memberId: string) {
  const [row] = await getDb()
    .select()
    .from(accountMembers)
    .where(eq(accountMembers.id, memberId));
  return row;
}

async function memberRowsFor(accountId: string, memberUserId: string) {
  return getDb()
    .select()
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.memberUserId, memberUserId))
    );
}

async function credentialById(credentialId: string) {
  const [row] = await getDb()
    .select()
    .from(accountCredentials)
    .where(eq(accountCredentials.id, credentialId));
  return row;
}

// ===========================================================================
// Pure helpers — no database
// ===========================================================================

describe('account tree pure helpers', () => {
  const node = (id: string, ancestors: string[], rootAccountId: string | null = null) => ({
    account: { id, rootAccountId } as AccountRow,
    ancestors,
  });

  test('childAncestorsOf appends parent to its ancestors (root → parent order)', () => {
    expect(childAncestorsOf(node('parent', ['root']))).toEqual(['root', 'parent']);
  });

  test('childRootOf inherits the parent root, or the parent itself for a root', () => {
    expect(childRootOf(node('child', [], 'the-root'))).toBe('the-root');
    expect(childRootOf(node('a-root', [], null))).toBe('a-root');
  });

  test('channelCannotParentChannel is true only when both parent and child are channels', () => {
    expect(channelCannotParentChannel('channel', 'channel')).toBe(true);
    expect(channelCannotParentChannel('channel', 'organization')).toBe(false);
    expect(channelCannotParentChannel('personal', 'channel')).toBe(false);
  });

  test('wouldCreateCycle detects self-parenting and descendant-parenting', () => {
    expect(wouldCreateCycle('a', node('a', []))).toBe(true);
    // `b` is a descendant of `a`, so moving `a` under `b` closes a loop.
    expect(wouldCreateCycle('a', node('b', ['a']))).toBe(true);
    expect(wouldCreateCycle('a', node('b', []))).toBe(false);
  });

  test('rewriteDescendantAncestors swaps the moved-node prefix, keeps the suffix', () => {
    expect(rewriteDescendantAncestors(['root'], ['new-root'], ['root', 'self', 'child'])).toEqual([
      'new-root',
      'self',
      'child',
    ]);
  });

  test('resolveEffectiveMembership: a direct row on the account always wins', () => {
    const rows: MembershipLike[] = [
      { accountId: 'account', role: 'viewer', inherit: true, status: 'active' },
      { accountId: 'parent', role: 'owner', inherit: true, status: 'active' },
    ];
    const resolved = resolveEffectiveMembership(rows, 'account', ['parent']);
    expect(resolved?.row.role).toBe('viewer');
    expect(resolved?.source).toBe('direct');
  });

  test('resolveEffectiveMembership: an inheriting ancestor row applies', () => {
    const rows: MembershipLike[] = [
      { accountId: 'parent', role: 'admin', inherit: true, status: 'active' },
    ];
    const resolved = resolveEffectiveMembership(rows, 'account', ['parent']);
    expect(resolved?.row.role).toBe('admin');
    expect(resolved?.source).toBe('inherited');
  });

  test('resolveEffectiveMembership: inherit:false ancestor row does NOT cascade', () => {
    const rows: MembershipLike[] = [
      { accountId: 'parent', role: 'admin', inherit: false, status: 'active' },
    ];
    expect(resolveEffectiveMembership(rows, 'account', ['parent'])).toBeNull();
  });

  test('resolveEffectiveMembership: nearest ancestor wins over a farther one', () => {
    const rows: MembershipLike[] = [
      { accountId: 'grandparent', role: 'owner', inherit: true, status: 'active' },
      { accountId: 'parent', role: 'editor', inherit: true, status: 'active' },
    ];
    // Ancestors are stored root-first, so the immediate parent is LAST.
    const resolved = resolveEffectiveMembership(rows, 'account', ['grandparent', 'parent']);
    expect(resolved?.row.role).toBe('editor');
  });
});

// ===========================================================================
// updateAccount
// ===========================================================================

describe('updateAccount', () => {
  test('merges partial name updates without clobbering existing fields', async () => {
    const account = await seedAccount({ nameFirst: 'Ada', nameLast: 'Lovelace' });

    await accountService.updateAccount(account.id, { name: { first: 'Augusta' } });

    const stored = await reload(account.id);
    expect(stored.nameFirst).toBe('Augusta');
    // The half the caller did not send must survive — a whole-object write here
    // would silently erase the surname.
    expect(stored.nameLast).toBe('Lovelace');
  });

  test('accepts name separators that join real names', async () => {
    const account = await seedAccount({
      kind: 'organization',
      nameFirst: 'Acme',
      nameLast: 'Corp',
    });

    await accountService.updateAccount(account.id, { name: { first: 'Codeur·euses' } });

    const stored = await reload(account.id);
    expect(stored.nameFirst).toBe('Codeur·euses');
    expect(stored.nameLast).toBe('Corp');
  });

  test('rejects invalid display names before persisting', async () => {
    const account = await seedAccount({
      kind: 'organization',
      nameFirst: 'Acme',
      nameLast: 'Corp',
    });

    await expect(
      accountService.updateAccount(account.id, { name: { first: 'Agent007' } }),
    ).rejects.toThrow(/name separators/i);

    // "before persisting" checked against the ROW, not against a call that did
    // not happen: a rejection thrown after the UPDATE would leave 'Agent007' here.
    const stored = await reload(account.id);
    expect(stored.nameFirst).toBe('Acme');
    expect(stored.nameLast).toBe('Corp');
  });
});

// ===========================================================================
// createChildAccount
// ===========================================================================

describe('createChildAccount', () => {
  test('builds ancestors/root, mints the account, records creator as owner', async () => {
    const root = await seedAccount();

    const { account, membership } = await accountService.createChildAccount(root.id, root.id, {
      kind: 'organization',
      username: uniqueUsername('oxy'),
    });

    expect(account.kind).toBe('organization');
    expect(await ancestorsOf(account.id)).toEqual([root.id]);
    expect(account.rootAccountId).toBe(root.id);
    expect(account.parentAccountId).toBe(root.id);

    expect(membership.role).toBe('owner');
    expect(membership.memberUserId).toBe(root.id);
    expect(membership.accountId).toBe(account.id);
  });

  test('rejects a personal child kind', async () => {
    const root = await seedAccount();
    await expect(
      accountService.createChildAccount(root.id, root.id, {
        kind: 'personal' as never,
        username: uniqueUsername('nope'),
      })
    ).rejects.toThrow(/child account kind/i);
  });

  /**
   * A channel is a real child account, minted the same way as every other kind
   * — and with NO credential of any sort. `user_auth_methods` staying empty is
   * the first half of "no login, ever"; the second half is that no bearer whose
   * subject is a channel can ever be minted (see `accountsSwitch.test.ts` and
   * `authSession.service.test.ts`), so nothing can add a row here later.
   */
  test('mints a channel child account with no auth methods', async () => {
    const root = await seedAccount();

    const { account, membership } = await accountService.createChildAccount(root.id, root.id, {
      kind: 'channel',
      username: uniqueUsername('daily-news'),
    });

    expect(account.kind).toBe('channel');
    expect(account.parentAccountId).toBe(root.id);
    expect(membership.role).toBe('owner');
    expect(membership.memberUserId).toBe(root.id);

    const methods = await getDb()
      .select({ id: userAuthMethods.id })
      .from(userAuthMethods)
      .where(eq(userAuthMethods.userId, account.id));
    expect(methods).toEqual([]);
  });

  test('rejects a channel parenting another channel', async () => {
    const root = await seedAccount();
    const parentChannel = await accountService.createChildAccount(root.id, root.id, {
      kind: 'channel',
      username: uniqueUsername('parent-channel'),
    });

    await expect(
      accountService.createChildAccount(parentChannel.account.id, root.id, {
        kind: 'channel',
        username: uniqueUsername('child-channel'),
      })
    ).rejects.toThrow(/channel cannot own another channel/i);
  });

  /**
   * The ORDER the caller gave has to reach the column unchanged, because index
   * 0 is the primary category. The fixture is three long and its primary is
   * neither alphabetically first nor first in the declared vocabulary, so a
   * sort on either key would be visible here.
   */
  test('persists account categories in the caller\'s order', async () => {
    const root = await seedAccount();
    const chosen: AccountCategoryId[] = ['news', 'art', 'film'];
    expect([...chosen].sort()).not.toEqual(chosen);
    expect(
      [...chosen].sort(
        (a, b) => ACCOUNT_CATEGORY_IDS.indexOf(a) - ACCOUNT_CATEGORY_IDS.indexOf(b)
      )
    ).not.toEqual(chosen);

    const { account } = await accountService.createChildAccount(root.id, root.id, {
      kind: 'organization',
      username: uniqueUsername('acme'),
      accountCategories: chosen,
    });
    expect(account.accountCategories).toEqual(chosen);

    // Read back from the database rather than trusting `returning()`, so the
    // round trip through the `text[]` column is what is asserted.
    const [stored] = await getDb()
      .select({ categories: users.accountCategories })
      .from(users)
      .where(eq(users.id, account.id));
    expect(stored.categories).toEqual(chosen);
  });

  test('accepts categories on every non-personal kind', async () => {
    const root = await seedAccount();
    for (const kind of CHILD_ACCOUNT_KINDS) {
      const { account } = await accountService.createChildAccount(root.id, root.id, {
        kind,
        username: uniqueUsername(`cat-${kind}`),
        accountCategories: ['technology'],
      });
      expect(account.accountCategories).toEqual(['technology']);
    }
  });

  test('defaults to no categories rather than null', async () => {
    const root = await seedAccount();
    const { account } = await accountService.createChildAccount(root.id, root.id, {
      kind: 'project',
      username: uniqueUsername('bare'),
    });
    expect(account.accountCategories).toEqual([]);
  });

  describe('updateAccount categories', () => {
    test('refuses them on a PERSONAL account', async () => {
      const person = await seedAccount({ kind: 'personal' });

      await expect(
        accountService.updateAccount(person.id, { accountCategories: ['news'] })
      ).rejects.toThrow(/personal.*cannot carry categories/i);

      // The refusal must be about the KIND and nothing else: the SAME call on a
      // non-personal account has to succeed, or this test would also pass
      // against a rule that refused everyone.
      const org = await accountService.createChildAccount(person.id, person.id, {
        kind: 'organization',
        username: uniqueUsername('org'),
      });
      const updated = await accountService.updateAccount(org.account.id, {
        accountCategories: ['news'],
      });
      expect(updated.accountCategories).toEqual(['news']);
    });

    test('leaves categories alone when the field is absent', async () => {
      const root = await seedAccount();
      const { account } = await accountService.createChildAccount(root.id, root.id, {
        kind: 'channel',
        username: uniqueUsername('chan'),
        accountCategories: ['news', 'politics'],
      });

      // The `bio: null` failure with another face: an update that never
      // mentions categories must not disturb them.
      const updated = await accountService.updateAccount(account.id, { bio: 'hello' });
      expect(updated.bio).toBe('hello');
      expect(updated.accountCategories).toEqual(['news', 'politics']);
    });

    test('replaces the whole list, preserving the new order', async () => {
      const root = await seedAccount();
      const { account } = await accountService.createChildAccount(root.id, root.id, {
        kind: 'channel',
        username: uniqueUsername('chan'),
        accountCategories: ['news', 'art', 'film'],
      });

      // Promoting `film` to primary is expressed as a re-ordering, which is
      // the only reason the update replaces the list rather than patching it.
      const updated = await accountService.updateAccount(account.id, {
        accountCategories: ['film', 'news', 'art'],
      });
      expect(updated.accountCategories).toEqual(['film', 'news', 'art']);
    });

    test('clears them with an empty list', async () => {
      const root = await seedAccount();
      const { account } = await accountService.createChildAccount(root.id, root.id, {
        kind: 'channel',
        username: uniqueUsername('chan'),
        accountCategories: ['news'],
      });
      const updated = await accountService.updateAccount(account.id, {
        accountCategories: [],
      });
      expect(updated.accountCategories).toEqual([]);
    });
  });

  test('rejects invalid display names on create', async () => {
    const root = await seedAccount({ kind: 'personal' });
    const username = uniqueUsername('proj');

    await expect(
      accountService.createChildAccount(root.id, root.id, {
        kind: 'project',
        username,
        name: { first: 'Agent007' },
      }),
    ).rejects.toThrow(/name separators/i);

    // Nothing was created: the username the call claimed is still free.
    const [row] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username));
    expect(row).toBeUndefined();
  });

  test('suffixes the username on collision', async () => {
    const root = await seedAccount();
    const taken = uniqueUsername('oxy');
    await seedAccount({ kind: 'organization', username: taken });

    const { account } = await accountService.createChildAccount(root.id, root.id, {
      kind: 'organization',
      username: taken,
    });
    expect(account.username).toBe(`${taken}1`);
  });

  test('enforces MAX_ACCOUNT_DEPTH', async () => {
    // A parent already sitting at the maximum depth.
    const chain: string[] = [];
    for (let i = 0; i < MAX_ACCOUNT_DEPTH; i += 1) {
      chain.push((await seedAccount({ kind: 'project' })).id);
    }
    const parent = await seedAccount({ kind: 'project', ancestors: chain });

    await expect(
      accountService.createChildAccount(parent.id, parent.id, {
        kind: 'project',
        username: uniqueUsername('too-deep'),
      })
    ).rejects.toThrow(/depth/i);
  });
});

// ===========================================================================
// moveAccount
// ===========================================================================

describe('moveAccount', () => {
  test('rewrites the whole subtree ancestors + root', async () => {
    const root = await seedAccount();
    const a = await seedAccount({
      kind: 'organization',
      parentAccountId: root.id,
      rootAccountId: root.id,
      ancestors: [root.id],
    });
    const child = await seedAccount({
      kind: 'project',
      parentAccountId: a.id,
      rootAccountId: root.id,
      ancestors: [root.id, a.id],
    });
    const newRoot = await seedAccount();

    await accountService.moveAccount(a.id, newRoot.id);

    // The moved node...
    expect(await ancestorsOf(a.id)).toEqual([newRoot.id]);
    expect((await reload(a.id)).rootAccountId).toBe(newRoot.id);
    // ...and every descendant: prefix swapped, suffix intact. A PARTIAL rewrite
    // is what the deleted session-less transaction fallback used to leave behind
    // on a standalone deployment, silently.
    expect(await ancestorsOf(child.id)).toEqual([newRoot.id, a.id]);
    expect((await reload(child.id)).rootAccountId).toBe(newRoot.id);
    expect((await reload(child.id)).parentAccountId).toBe(a.id);
  });

  test('rejects self-parenting', async () => {
    const account = await seedAccount({ kind: 'organization' });
    await expect(accountService.moveAccount(account.id, account.id)).rejects.toThrow(
      /its own parent/i
    );
  });

  test('rejects moving an account beneath its own descendant (cycle)', async () => {
    const root = await seedAccount();
    const a = await seedAccount({
      kind: 'organization',
      parentAccountId: root.id,
      rootAccountId: root.id,
      ancestors: [root.id],
    });
    const descendant = await seedAccount({
      kind: 'project',
      parentAccountId: a.id,
      rootAccountId: root.id,
      ancestors: [root.id, a.id],
    });

    await expect(accountService.moveAccount(a.id, descendant.id)).rejects.toThrow(
      /beneath itself/i
    );
  });

  test('rejects moving a personal account', async () => {
    const personal = await seedAccount({ kind: 'personal' });
    const target = await seedAccount({ kind: 'organization' });
    await expect(accountService.moveAccount(personal.id, target.id)).rejects.toThrow(
      /always a root/i
    );
  });

  test('rejects moving a channel beneath another channel', async () => {
    const root = await seedAccount();
    const parentChannel = await accountService.createChildAccount(root.id, root.id, {
      kind: 'channel',
      username: uniqueUsername('parent-channel'),
    });
    const childChannel = await accountService.createChildAccount(root.id, root.id, {
      kind: 'channel',
      username: uniqueUsername('child-channel'),
    });

    await expect(
      accountService.moveAccount(childChannel.account.id, parentChannel.account.id)
    ).rejects.toThrow(/channel cannot own another channel/i);
  });
});

// ===========================================================================
// Inheritance + verifyActingAs
// ===========================================================================

describe('membership inheritance + verifyActingAs', () => {
  async function seedOrgTree() {
    const root = await seedAccount({ kind: 'personal' });
    const org = await seedAccount({
      kind: 'organization',
      parentAccountId: root.id,
      rootAccountId: root.id,
      ancestors: [root.id],
    });
    const project = await seedAccount({
      kind: 'project',
      parentAccountId: org.id,
      rootAccountId: root.id,
      ancestors: [root.id, org.id],
    });
    return { root, org, project };
  }

  test('a member of the parent reaches the child via inheritance', async () => {
    const { org, project } = await seedOrgTree();
    const bob = await seedAccount();
    await seedMember(org.id, bob.id, 'editor', { inherit: true });

    const access = await accountService.resolveEffectiveAccess(bob.id, project.id);
    expect(access?.role).toBe('editor');
    expect(access?.source).toBe('inherited');
  });

  test('a direct row on the child overrides the inherited ancestor row', async () => {
    const { org, project } = await seedOrgTree();
    const bob = await seedAccount();
    await seedMember(org.id, bob.id, 'owner', { inherit: true });
    await seedMember(project.id, bob.id, 'viewer', { inherit: true });

    const access = await accountService.resolveEffectiveAccess(bob.id, project.id);
    expect(access?.role).toBe('viewer');
    expect(access?.source).toBe('direct');
  });

  test('inherit:false on the ancestor row opts the child subtree out', async () => {
    const { org, project } = await seedOrgTree();
    const bob = await seedAccount();
    await seedMember(org.id, bob.id, 'admin', { inherit: false });

    expect(await accountService.resolveEffectiveAccess(bob.id, project.id)).toBeNull();
    // The membership still applies to the account it was granted on.
    expect((await accountService.resolveEffectiveAccess(bob.id, org.id))?.role).toBe('admin');
  });

  test('verifyActingAs authorises act_as roles via an ancestor, denies others', async () => {
    const { org, project } = await seedOrgTree();
    const bob = await seedAccount();
    await seedMember(org.id, bob.id, 'admin', { inherit: true });
    expect(await accountService.verifyActingAs(bob.id, project.id)).toBe('admin');

    const stranger = await seedAccount();
    expect(await accountService.verifyActingAs(stranger.id, project.id)).toBeNull();
  });

  test('a user is the implicit owner of their own account (self)', async () => {
    const alice = await seedAccount();
    const access = await accountService.resolveEffectiveAccess(alice.id, alice.id);
    expect(access?.role).toBe('owner');
    expect(access?.source).toBe('self');
    expect(access?.membership).toBeNull();
  });

  test('a managed account is not its own implicit owner', async () => {
    const org = await seedAccount({ kind: 'organization' });

    expect(await accountService.resolveEffectiveAccess(org.id, org.id)).toBeNull();
    expect(await accountService.effectiveAccessForAccount(org.id, org)).toBeNull();
  });

  test('a per-member GRANT reaches resolveEffectiveAccess', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const bob = await seedAccount();
    await seedMember(org.id, bob.id, 'developer', { permissionGrants: ['members:read'] });

    const access = await accountService.resolveEffectiveAccess(bob.id, org.id);
    expect(access?.role).toBe('developer');
    expect(access?.permissions).toContain('members:read');
  });

  test('a per-member REVOKE reaches resolveEffectiveAccess', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const bob = await seedAccount();
    await seedMember(org.id, bob.id, 'admin', { permissionRevokes: ['members:remove'] });

    const access = await accountService.resolveEffectiveAccess(bob.id, org.id);
    expect(access?.role).toBe('admin');
    expect(access?.permissions).not.toContain('members:remove');
    // Narrowed, not emptied.
    expect(access?.permissions).toContain('members:invite');
  });

  test('deltas travel through INHERITANCE with the row that carries them', async () => {
    // Inheritance resolves to a ROW, and the row's adjustments are part of what
    // it grants — an implementation that carried only the role down the tree
    // would widen an intentionally-narrowed member on every descendant account.
    const { org, project } = await seedOrgTree();
    const bob = await seedAccount();
    await seedMember(org.id, bob.id, 'admin', {
      inherit: true,
      permissionRevokes: ['account:act_as'],
    });

    const access = await accountService.resolveEffectiveAccess(bob.id, project.id);
    expect(access?.source).toBe('inherited');
    expect(access?.permissions).not.toContain('account:act_as');
  });

  test('verifyActingAs honours a revoke of account:act_as', async () => {
    // The measurement that makes this endpoint's guarantee real: `admin` carries
    // `account:act_as` in its baseline, so a role-driven check returns 'admin'
    // here and only a permission-driven one returns null.
    const org = await seedAccount({ kind: 'organization' });
    const bob = await seedAccount();
    await seedMember(org.id, bob.id, 'admin', { permissionRevokes: ['account:act_as'] });

    expect(await accountService.verifyActingAs(bob.id, org.id)).toBeNull();
  });

  test('verifyActingAs honours a grant of account:act_as to a role without it', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const bob = await seedAccount();
    // `developer` has no `account:act_as` baseline — asserted, so the case
    // cannot quietly become vacuous if the role map changes.
    await seedMember(org.id, bob.id, 'developer');
    expect(await accountService.verifyActingAs(bob.id, org.id)).toBeNull();

    await getDb()
      .update(accountMembers)
      .set({ permissionGrants: ['account:act_as'] })
      .where(
        and(eq(accountMembers.accountId, org.id), eq(accountMembers.memberUserId, bob.id))
      );

    expect(await accountService.verifyActingAs(bob.id, org.id)).toBe('developer');
  });
});

// ===========================================================================
// listAccessibleAccounts
// ===========================================================================

describe('listAccessibleAccounts', () => {
  test('returns self + direct memberships + their subtree, annotated', async () => {
    const bob = await seedAccount();
    const org = await seedAccount({ kind: 'organization' });
    const project = await seedAccount({
      kind: 'project',
      parentAccountId: org.id,
      rootAccountId: org.id,
      ancestors: [org.id],
    });
    await seedMember(org.id, bob.id, 'admin', { inherit: true });

    const byId = new Map(
      (await accountService.listAccessibleAccounts(bob.id)).map((node) => [node.accountId, node])
    );

    expect(byId.get(bob.id)?.relationship).toBe('self');
    expect(byId.get(org.id)?.relationship).toBe('member');
    expect(byId.get(org.id)?.callerMembershipSource).toBe('direct');
    // The subtree comes along, annotated as inherited rather than direct.
    expect(byId.get(project.id)?.callerMembershipSource).toBe('inherited');
  });

  test('an owner membership is reported as relationship owner', async () => {
    const bob = await seedAccount();
    const org = await seedAccount({ kind: 'organization' });
    await seedMember(org.id, bob.id, 'owner', { inherit: true });

    const nodes = await accountService.listAccessibleAccounts(bob.id);
    expect(nodes.find((node) => node.accountId === org.id)?.relationship).toBe('owner');
  });
});

// ===========================================================================
// Members CRUD + last-owner protection + transfer
// ===========================================================================

describe('members CRUD', () => {
  test('addMember creates then rejects a duplicate active member', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const owner = await seedAccount();
    const charlie = await seedAccount();

    const member = await accountService.addMember(org.id, owner.id, charlie.id, 'developer');
    expect(member.role).toBe('developer');
    expect(member.status).toBe('active');

    await expect(
      accountService.addMember(org.id, owner.id, charlie.id, 'viewer')
    ).rejects.toThrow(/already a member/i);
  });

  test('addMember re-activates a previously removed membership', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const owner = await seedAccount();
    const charlie = await seedAccount();
    await seedMember(org.id, charlie.id, 'viewer', { status: 'removed' });

    const member = await accountService.addMember(org.id, owner.id, charlie.id, 'developer');
    expect(member.status).toBe('active');
    expect(member.role).toBe('developer');
    // Re-activated in place — a second row would break the `(account, member)`
    // uniqueness the inheritance resolution assumes.
    expect(await memberRowsFor(org.id, charlie.id)).toHaveLength(1);
  });

  test('updateMember rejects changing an owner row', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const owner = await seedAccount();
    const ownerMember = await seedMember(org.id, owner.id, 'owner');

    await expect(
      accountService.updateMember(org.id, ownerMember.id, { role: 'admin' })
    ).rejects.toThrow(/transfer-ownership/i);
  });

  test('updateMember refuses a PERMISSION edit on an owner row, not just a role edit', async () => {
    // An owner row is uneditable through this endpoint, so a revoke landing on
    // one would be irreversible: there is no way back short of transferring the
    // account away and back again.
    const org = await seedAccount({ kind: 'organization' });
    const owner = await seedAccount();
    const ownerMember = await seedMember(org.id, owner.id, 'owner');

    await expect(
      accountService.updateMember(org.id, ownerMember.id, {
        permissionRevokes: ['account:delete'],
      })
    ).rejects.toThrow(/transfer-ownership/i);
    expect((await memberRowById(ownerMember.id)).permissionRevokes).toEqual([]);
  });

  test('addMember RESETS the delta columns when it reactivates a removed row', async () => {
    // A removed member carrying a grant must not carry it back in silently on
    // re-invitation: the invite names a role, and the row has to mean what the
    // invite said.
    const org = await seedAccount({ kind: 'organization' });
    const owner = await seedAccount();
    const charlie = await seedAccount();
    await seedMember(org.id, charlie.id, 'admin', {
      status: 'removed',
      permissionGrants: ['ownership:transfer'],
      permissionRevokes: ['account:read'],
    });

    const member = await accountService.addMember(org.id, owner.id, charlie.id, 'viewer');

    expect(member.permissionGrants).toEqual([]);
    expect(member.permissionRevokes).toEqual([]);
    expect(
      (await accountService.resolveEffectiveAccess(charlie.id, org.id))?.permissions
    ).not.toContain('ownership:transfer');
  });

  test('transferOwnership clears the promoted row deltas', async () => {
    // An owner row can never be edited again, so an admin-era revoke carried
    // into ownership would be a permanent, unfixable hole in that owner's
    // authority.
    const org = await seedAccount({ kind: 'organization' });
    const alice = await seedAccount();
    const bob = await seedAccount();
    await seedMember(org.id, alice.id, 'owner');
    const bobMember = await seedMember(org.id, bob.id, 'admin', {
      permissionRevokes: ['account:update'],
      permissionGrants: ['ownership:transfer'],
    });

    await accountService.transferOwnership(org.id, alice.id, bob.id);

    const promoted = await memberRowById(bobMember.id);
    expect(promoted.role).toBe('owner');
    expect(promoted.permissionRevokes).toEqual([]);
    expect(promoted.permissionGrants).toEqual([]);
    expect(
      (await accountService.resolveEffectiveAccess(bob.id, org.id))?.permissions
    ).toContain('account:update');
  });

  test('removeMember refuses to remove the last owner', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const owner = await seedAccount();
    const ownerMember = await seedMember(org.id, owner.id, 'owner');

    await expect(accountService.removeMember(org.id, ownerMember.id, true)).rejects.toThrow(
      /last owner/i
    );
    // Refused means UNCHANGED — an account with no owner is unadministrable.
    expect((await memberRowById(ownerMember.id)).status).toBe('active');
  });

  test('removeMember soft-removes a non-owner', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const dev = await seedAccount();
    const member = await seedMember(org.id, dev.id, 'developer');

    await accountService.removeMember(org.id, member.id, true);

    // SOFT — the row survives with `status: 'removed'`, which is what lets
    // `addMember` re-activate it rather than mint a second row.
    expect((await memberRowById(member.id)).status).toBe('removed');
  });

  test('transferOwnership promotes the target and demotes the caller', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const alice = await seedAccount();
    const bob = await seedAccount();
    const aliceMember = await seedMember(org.id, alice.id, 'owner');
    const bobMember = await seedMember(org.id, bob.id, 'admin');

    await accountService.transferOwnership(org.id, alice.id, bob.id);

    // Both halves, in one transaction: an account must never briefly have two
    // owners or none.
    expect((await memberRowById(bobMember.id)).role).toBe('owner');
    expect((await memberRowById(aliceMember.id)).role).toBe('admin');
  });

  test('transferOwnership rejects a personal account', async () => {
    const alice = await seedAccount({ kind: 'personal' });
    const bob = await seedAccount();
    await seedMember(alice.id, bob.id, 'admin');

    await expect(accountService.transferOwnership(alice.id, alice.id, bob.id)).rejects.toThrow(
      /personal account cannot be transferred/i
    );
  });
});

// ===========================================================================
// Credentials (bot accounts)
// ===========================================================================

describe('bot account credentials', () => {
  test('createCredential returns a secret once for a bot account', async () => {
    const bot = await seedAccount({ kind: 'bot' });
    const creator = await seedAccount();

    const { credential, secret } = await accountService.createCredential(bot.id, creator.id, {
      name: 'ci',
      environment: 'production',
    });
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(credential.publicKey).toMatch(/^oxy_dk_/);
    expect(credential.type).toBe('service');

    // The plaintext secret is never persisted — only its hash.
    const stored = await credentialById(credential.id);
    expect(stored.secretHash).toEqual(expect.any(String));
    expect(stored.secretHash).not.toBe(secret);
  });

  test('createCredential refuses a non-bot account', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const creator = await seedAccount();
    await expect(
      accountService.createCredential(org.id, creator.id, {
        name: 'x',
        environment: 'production',
      })
    ).rejects.toThrow(/bot accounts/i);
  });

  test('rotateCredential deprecates the previous credential with a grace expiry', async () => {
    const bot = await seedAccount({ kind: 'bot' });
    const creator = await seedAccount();
    const { credential } = await accountService.createCredential(bot.id, creator.id, {
      name: 'ci',
      environment: 'production',
    });

    const result = await accountService.rotateCredential(bot.id, credential.id, creator.id);

    expect(result.rotatedFrom).toBe(credential.id);
    expect(result.credential.publicKey).not.toBe(credential.publicKey);

    const previous = await credentialById(credential.id);
    // Deprecated, NOT revoked: the old secret keeps working for the grace window
    // so a rotation does not break a running deployment mid-flight.
    expect(previous.status).toBe('deprecated');
    expect(previous.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  test('revokeCredential marks the credential revoked', async () => {
    const bot = await seedAccount({ kind: 'bot' });
    const creator = await seedAccount();
    const { credential } = await accountService.createCredential(bot.id, creator.id, {
      name: 'ci',
      environment: 'production',
    });

    await accountService.revokeCredential(bot.id, credential.id);

    expect((await credentialById(credential.id)).status).toBe('revoked');
  });
});
