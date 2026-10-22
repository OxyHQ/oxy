import { insertAccountFixture } from '../../db/__fixtures__/accountIdentity';
/**
 * account.service tests — unified Account graph, against a REAL Postgres.
 *
 * `ancestors` is the `user_ancestors` TABLE, membership resolution is a real
 * query, and `moveAccount` is a real transaction. An emulator can only assert the calls a
 * service makes; the properties worth protecting here — the subtree rewrite, the
 * last-owner guard, inheritance precedence, the rotation grace window — are
 * properties of stored ROWS.
 *
 * Pure tree/inheritance helpers stay unit-tested with no database, because they
 * are pure.
 *
 * The whole run shares one database, so every test mints its own accounts.
 */

import { and, eq, inArray } from 'drizzle-orm';
import {
  ACCOUNT_CATEGORY_IDS,
  CHILD_ACCOUNT_KINDS,
  type AccountCategoryId,
} from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { MAX_ACCOUNT_DEPTH, userAncestors } from '../../db/schema/userAncestors';
import { organizationProfiles } from '../../db/schema/organizationProfiles';
import { userAuthMethods } from '../../db/schema/userAuthMethods';
import { users } from '../../db/schema/users';
import {
  accountService,
  childAncestorsOf,
  childRootOf,
  accountCannotParentSameKind,
  resolveEffectiveMembership,
  rewriteDescendantAncestors,
  wouldCreateCycle,
  type AccountMemberRow,
  type AccountRow,
  type MembershipLike,
} from '../account.service';
import { userService } from '../user.service';

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

/**
 * A handle legal for `kind`. Only `bot` differs — `botUsernameSchema`
 * (`@oxy.so/contracts`) requires its handle to end in `bot` — so a loop over every
 * child kind has to carry the label for that one member, or the iteration 400s
 * on a question that has nothing to do with what the case is testing.
 */
function uniqueUsernameFor(kind: (typeof CHILD_ACCOUNT_KINDS)[number], prefix: string): string {
  const handle = uniqueUsername(prefix);
  return kind === 'bot' ? `${handle}bot` : handle;
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
  const account = await insertAccountFixture({
    color: 'teal',
    kind: options.kind ?? 'personal',
    username: options.username ?? uniqueUsername('acct'),
    nameFirst: options.nameFirst,
    nameLast: options.nameLast,
    parentAccountId: options.parentAccountId,
    rootAccountId: options.rootAccountId,
  });

  const ancestors = options.ancestors ?? [];
  if (ancestors.length > 0) {
    await getDb()
      .insert(userAncestors)
      .values(ancestors.map((ancestorId, depth) => ({ userId: account.id, ancestorId, depth })));
  }
  return account as AccountRow;
}

// One account whose handle is in COMMUNITY_PREVIEW_HANDLES (stored in another
// case, so the gate's case-insensitivity is exercised too). Handles are unique,
// so it is seeded once per file.
let previewAccount: Promise<AccountRow> | undefined;
function previewCreator(): Promise<AccountRow> {
  previewAccount ??= seedAccount({ username: 'Nate' });
  return previewAccount;
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
  } = {},
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
  const [row] = await getDb().select().from(accountMembers).where(eq(accountMembers.id, memberId));
  return row;
}

async function memberRowsFor(accountId: string, memberUserId: string) {
  return getDb()
    .select()
    .from(accountMembers)
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.memberUserId, memberUserId)),
    );
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

  test('accountCannotParentSameKind is true only for a member-operated kind under itself', () => {
    expect(accountCannotParentSameKind('channel', 'channel')).toBe(true);
    expect(accountCannotParentSameKind('community', 'community')).toBe(true);
    expect(accountCannotParentSameKind('channel', 'organization')).toBe(false);
    expect(accountCannotParentSameKind('channel', 'community')).toBe(false);
    expect(accountCannotParentSameKind('organization', 'organization')).toBe(false);
    expect(accountCannotParentSameKind('personal', 'channel')).toBe(false);
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

    // An organization is named by the title policy: digits pass, markup does not.
    await expect(
      accountService.updateAccount(account.id, { name: { first: '<b>Acme</b>' } }),
    ).rejects.toThrow(/plain text/i);

    // "before persisting" checked against the ROW, not against a call that did
    // not happen: a rejection thrown after the UPDATE would leave the name here.
    const stored = await reload(account.id);
    expect(stored.nameFirst).toBe('Acme');
    expect(stored.nameLast).toBe('Corp');
  });
});

// ===========================================================================
// A community's public moderators
// ===========================================================================

describe('getCommunityModerators', () => {
  test("lists a community's active members, and 404s any other kind", async () => {
    const creator = await previewCreator();
    const invited = await seedAccount();
    const removed = await seedAccount();
    const { account: community } = await accountService.createChildAccount(creator.id, creator.id, {
      kind: 'community',
      username: uniqueUsername('forum'),
    });
    await seedMember(community.id, invited.id, 'editor');
    await seedMember(community.id, removed.id, 'editor', { status: 'removed' });

    const moderators = await userService.getCommunityModerators(community.id);
    expect(moderators.map((user) => user.id).sort()).toEqual([creator.id, invited.id].sort());

    const { account: channel } = await accountService.createChildAccount(creator.id, creator.id, {
      kind: 'channel',
      username: uniqueUsername('chan'),
    });
    await expect(userService.getCommunityModerators(channel.id)).rejects.toThrow(
      'Community not found',
    );
  });
});

// ===========================================================================
// createChildAccount
// ===========================================================================

describe('createChildAccount', () => {
  // The temporary community preview gate: refused like an unknown kind unless the
  // creating account's stored handle (any case) is in COMMUNITY_PREVIEW_HANDLES.
  test('refuses a community from a non-preview account as an invalid kind', async () => {
    const root = await seedAccount();
    await expect(
      accountService.createChildAccount(root.id, root.id, {
        kind: 'community',
        username: uniqueUsername('forum'),
      }),
    ).rejects.toThrow(/child account kind must be one of/i);
  });

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

  /**
   * `users.verified` is personhood (`recomputePersonhood`), and it promotes the
   * account to the `verified` trust tier — validator pool, ranking weight. A
   * child account is not a person, so creating one must not mint either.
   */
  test('a new child account of every kind is not verified', async () => {
    const root = await previewCreator();
    for (const kind of CHILD_ACCOUNT_KINDS) {
      const { account } = await accountService.createChildAccount(root.id, root.id, {
        kind,
        username: uniqueUsernameFor(kind, 'unverified'),
      });
      expect(account.verified).toBe(false);
    }
  });

  /**
   * An owned organization is born WITH its directory profile — `claimed`, with
   * the type asked for — written by the create itself. Nothing conjures it from
   * the owner membership any more (migration 0188 dropped that trigger), so a
   * create that forgot it would fail the deferred `organization_directory_required`
   * check rather than leave an organization without a profile.
   */
  test('writes an owned organization its claimed directory profile and type', async () => {
    const root = await seedAccount();

    const { account } = await accountService.createChildAccount(root.id, root.id, {
      kind: 'organization',
      username: uniqueUsername('typed'),
      organizationType: 'nonprofit',
    });
    const untyped = await accountService.createChildAccount(root.id, root.id, {
      kind: 'organization',
      username: uniqueUsername('untyped'),
    });

    const profiles = await getDb()
      .select({
        accountId: organizationProfiles.accountId,
        claimStatus: organizationProfiles.claimStatus,
        organizationType: organizationProfiles.organizationType,
      })
      .from(organizationProfiles)
      .where(inArray(organizationProfiles.accountId, [account.id, untyped.account.id]));
    expect(profiles).toEqual(
      expect.arrayContaining([
        { accountId: account.id, claimStatus: 'claimed', organizationType: 'nonprofit' },
        { accountId: untyped.account.id, claimStatus: 'claimed', organizationType: 'other' },
      ]),
    );
  });

  test('writes no directory profile for a kind that is not an organization', async () => {
    const root = await seedAccount();
    const { account } = await accountService.createChildAccount(root.id, root.id, {
      kind: 'project',
      username: uniqueUsername('proj'),
    });
    const rows = await getDb()
      .select()
      .from(organizationProfiles)
      .where(eq(organizationProfiles.accountId, account.id));
    expect(rows).toEqual([]);
  });

  test('refuses to hang a child under an archived parent', async () => {
    const root = await seedAccount();
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, root.id));

    await expect(
      accountService.createChildAccount(root.id, root.id, {
        kind: 'project',
        username: uniqueUsername('orphan'),
      }),
    ).rejects.toThrow(/parent account not found/i);
  });

  describe('with authorize', () => {
    test("creates under the creator's own personal account", async () => {
      const root = await seedAccount();
      const { account } = await accountService.createChildAccount(
        root.id,
        root.id,
        { kind: 'project', username: uniqueUsername('own') },
        { authorize: {} },
      );
      expect(account.parentAccountId).toBe(root.id);
    });

    test('creates under an account where an inherited role grants children:create', async () => {
      const owner = await seedAccount();
      const admin = await seedAccount();
      const org = await accountService.createChildAccount(owner.id, owner.id, {
        kind: 'organization',
        username: uniqueUsername('org'),
      });
      const project = await accountService.createChildAccount(org.account.id, owner.id, {
        kind: 'project',
        username: uniqueUsername('proj'),
      });
      await seedMember(org.account.id, admin.id, 'admin', { inherit: true });

      const { account, membership } = await accountService.createChildAccount(
        project.account.id,
        admin.id,
        { kind: 'channel', username: uniqueUsername('chan') },
        { authorize: {} },
      );
      expect(await ancestorsOf(account.id)).toEqual([owner.id, org.account.id, project.account.id]);
      expect(membership.memberUserId).toBe(admin.id);
    });

    test('refuses a creator with no access, without creating anything', async () => {
      const owner = await seedAccount();
      const stranger = await seedAccount();
      const username = uniqueUsername('nope');

      await expect(
        accountService.createChildAccount(
          owner.id,
          stranger.id,
          { kind: 'project', username },
          { authorize: {} },
        ),
      ).rejects.toThrow(/do not have access to the parent account/i);
      const rows = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username));
      expect(rows).toEqual([]);
    });

    test('refuses a member whose role lacks children:create', async () => {
      const owner = await seedAccount();
      const viewer = await seedAccount();
      const org = await accountService.createChildAccount(owner.id, owner.id, {
        kind: 'organization',
        username: uniqueUsername('org'),
      });
      await seedMember(org.account.id, viewer.id, 'viewer');

      await expect(
        accountService.createChildAccount(
          org.account.id,
          viewer.id,
          { kind: 'project', username: uniqueUsername('proj') },
          { authorize: {} },
        ),
      ).rejects.toThrow(/missing required permission: children:create/i);
    });

    test('answers a missing or archived parent exactly like one out of reach', async () => {
      const owner = await seedAccount();
      const archived = await seedAccount();
      await getDb()
        .update(users)
        .set({ accountStatus: 'archived' })
        .where(eq(users.id, archived.id));

      for (const parentId of [archived.id, '01a00000-0000-7000-8000-000000000000']) {
        await expect(
          accountService.createChildAccount(
            parentId,
            parentId === archived.id ? archived.id : owner.id,
            { kind: 'project', username: uniqueUsername('ghost') },
            { authorize: {} },
          ),
        ).rejects.toThrow(/do not have access to the parent account/i);
      }
    });
  });

  /**
   * THE FIELD REACHES THE COLUMN, and saying nothing leaves the default.
   *
   * Both halves are load-bearing and they fail differently. A create path that
   * ignores `isPrivateAccount` publishes an account its owner never published —
   * silently, because nothing errors and the row looks fine. A create path that
   * defaults it the OTHER way hides every account every existing caller makes,
   * equally silently. So the default case is asserted beside the explicit one
   * rather than assumed from the column definition.
   *
   * Read back from the stored row, never from the service's return value: the
   * question is what the database holds, and a serializer that echoed the input
   * would answer it wrongly.
   */
  test('creates an account opted OUT of discovery when asked, and discoverable when not', async () => {
    const root = await seedAccount();

    const hidden = await accountService.createChildAccount(root.id, root.id, {
      kind: 'bot',
      username: uniqueUsernameFor('bot', 'hidden'),
      isPrivateAccount: true,
    });
    const silent = await accountService.createChildAccount(root.id, root.id, {
      kind: 'bot',
      username: uniqueUsernameFor('bot', 'silent'),
    });
    const explicit = await accountService.createChildAccount(root.id, root.id, {
      kind: 'bot',
      username: uniqueUsernameFor('bot', 'explicit'),
      isPrivateAccount: false,
    });

    const stored = async (id: string) => {
      const [row] = await getDb()
        .select({ isPrivate: users.privacyIsPrivateAccount })
        .from(users)
        .where(eq(users.id, id));
      return row.isPrivate;
    };

    expect(await stored(hidden.account.id)).toBe(true);
    // The unchanged behaviour for every caller that predates this option.
    expect(await stored(silent.account.id)).toBe(false);
    expect(await stored(explicit.account.id)).toBe(false);
  });

  /**
   * Not conditioned on `kind`. `createAccountRequestSchema` takes an explicit
   * position against kind-conditional fields and a contracts test enforces it,
   * so a create path that honoured this only for `bot` would contradict the
   * contract while still passing the case above.
   */
  test('honours the opt-out for every child kind, not only bot', async () => {
    const root = await seedAccount();

    for (const kind of ['organization', 'project', 'bot', 'channel'] as const) {
      const { account } = await accountService.createChildAccount(root.id, root.id, {
        kind,
        username: uniqueUsernameFor(kind, `priv${kind}`),
        isPrivateAccount: true,
      });
      const [row] = await getDb()
        .select({ isPrivate: users.privacyIsPrivateAccount })
        .from(users)
        .where(eq(users.id, account.id));
      expect({ kind, isPrivate: row.isPrivate }).toEqual({ kind, isPrivate: true });
    }
  });

  test('rejects a personal child kind', async () => {
    const root = await seedAccount();
    await expect(
      accountService.createChildAccount(root.id, root.id, {
        kind: 'personal' as never,
        username: uniqueUsername('nope'),
      }),
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
      }),
    ).rejects.toThrow(/channel cannot own another channel/i);
  });

  /**
   * The ORDER the caller gave has to reach the column unchanged, because index
   * 0 is the primary category. The fixture is three long and its primary is
   * neither alphabetically first nor first in the declared vocabulary, so a
   * sort on either key would be visible here.
   */
  test("persists account categories in the caller's order", async () => {
    const root = await seedAccount();
    const chosen: AccountCategoryId[] = ['news', 'art', 'film'];
    expect([...chosen].sort()).not.toEqual(chosen);
    expect(
      [...chosen].sort((a, b) => ACCOUNT_CATEGORY_IDS.indexOf(a) - ACCOUNT_CATEGORY_IDS.indexOf(b)),
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
    const root = await previewCreator();
    for (const kind of CHILD_ACCOUNT_KINDS) {
      const { account } = await accountService.createChildAccount(root.id, root.id, {
        kind,
        username: uniqueUsernameFor(kind, `cat-${kind}`),
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
        accountService.updateAccount(person.id, { accountCategories: ['news'] }),
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
        name: { first: '<b>Agent007</b>' },
      }),
    ).rejects.toThrow(/plain text/i);

    // Nothing was created: the username the call claimed is still free.
    const [row] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username));
    expect(row).toBeUndefined();
  });

  /**
   * This used to assert `${taken}1` — the suffix. Asking for a handle and being
   * given a different one is the server answering a question nobody asked, and
   * the consumers were already written for the refusal: Alia retries on 409, and
   * the cost-centre seed treats a suffix as a failure. `accountUsernameCollision`
   * covers the rename, the case-insensitivity and the lost race.
   */
  test('refuses a taken username rather than suffixing it', async () => {
    const root = await seedAccount();
    const taken = uniqueUsername('oxy');
    await seedAccount({ kind: 'organization', username: taken });

    await expect(
      accountService.createChildAccount(root.id, root.id, {
        kind: 'organization',
        username: taken,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
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
      }),
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

  test('rewrites a deep subtree in one pass: every path, every root, nothing else', async () => {
    const oldRoot = await seedAccount();
    const top = await accountService.createChildAccount(oldRoot.id, oldRoot.id, {
      kind: 'organization',
      username: uniqueUsername('top'),
    });
    const mid = await accountService.createChildAccount(top.account.id, oldRoot.id, {
      kind: 'project',
      username: uniqueUsername('mid'),
    });
    const leaves = await Promise.all(
      ['a', 'b', 'c'].map((tag) =>
        accountService.createChildAccount(mid.account.id, oldRoot.id, {
          kind: 'channel',
          username: uniqueUsername(`leaf-${tag}`),
        }),
      ),
    );
    const sibling = await accountService.createChildAccount(oldRoot.id, oldRoot.id, {
      kind: 'project',
      username: uniqueUsername('sibling'),
    });
    const newRoot = await seedAccount();
    const newParent = await accountService.createChildAccount(newRoot.id, newRoot.id, {
      kind: 'organization',
      username: uniqueUsername('dest'),
    });

    const moved = await accountService.moveAccount(mid.account.id, newParent.account.id);

    expect(moved.parentAccountId).toBe(newParent.account.id);
    expect(moved.rootAccountId).toBe(newRoot.id);
    expect(await ancestorsOf(mid.account.id)).toEqual([newRoot.id, newParent.account.id]);
    for (const leaf of leaves) {
      expect(await ancestorsOf(leaf.account.id)).toEqual([
        newRoot.id,
        newParent.account.id,
        mid.account.id,
      ]);
      expect(await reload(leaf.account.id)).toMatchObject({
        rootAccountId: newRoot.id,
        parentAccountId: mid.account.id,
      });
    }
    // Outside the subtree nothing moved.
    expect(await ancestorsOf(top.account.id)).toEqual([oldRoot.id]);
    expect(await ancestorsOf(sibling.account.id)).toEqual([oldRoot.id]);
    expect((await reload(sibling.account.id)).rootAccountId).toBe(oldRoot.id);
  });

  test('refuses a move that would push the deepest descendant past the depth limit', async () => {
    const root = await seedAccount();
    let parentId = root.id;
    const chain: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { account } = await accountService.createChildAccount(parentId, root.id, {
        kind: 'project',
        username: uniqueUsername(`chain${i}`),
      });
      chain.push(account.id);
      parentId = account.id;
    }
    let deepParentId = root.id;
    for (let i = 0; i < MAX_ACCOUNT_DEPTH - 2; i += 1) {
      const { account } = await accountService.createChildAccount(deepParentId, root.id, {
        kind: 'project',
        username: uniqueUsername(`deep${i}`),
      });
      deepParentId = account.id;
    }

    await expect(accountService.moveAccount(chain[0], deepParentId)).rejects.toThrow(
      /maximum account nesting depth/i,
    );
    expect(await ancestorsOf(chain[2])).toEqual([root.id, chain[0], chain[1]]);
  });

  test('rejects self-parenting', async () => {
    const account = await seedAccount({ kind: 'organization' });
    await expect(accountService.moveAccount(account.id, account.id)).rejects.toThrow(
      /its own parent/i,
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
      /beneath itself/i,
    );
  });

  test('rejects moving a personal account', async () => {
    const personal = await seedAccount({ kind: 'personal' });
    const target = await seedAccount({ kind: 'organization' });
    await expect(accountService.moveAccount(personal.id, target.id)).rejects.toThrow(
      /always a root/i,
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
      accountService.moveAccount(childChannel.account.id, parentChannel.account.id),
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
      .where(and(eq(accountMembers.accountId, org.id), eq(accountMembers.memberUserId, bob.id)));

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
      (await accountService.listAccessibleAccounts(bob.id)).map((node) => [node.accountId, node]),
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

    await expect(accountService.addMember(org.id, owner.id, charlie.id, 'viewer')).rejects.toThrow(
      /already a member/i,
    );
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
      accountService.updateMember(org.id, ownerMember.id, { role: 'admin' }),
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
      }),
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
      (await accountService.resolveEffectiveAccess(charlie.id, org.id))?.permissions,
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
    expect((await accountService.resolveEffectiveAccess(bob.id, org.id))?.permissions).toContain(
      'account:update',
    );
  });

  test('removeMember refuses to remove the last owner', async () => {
    const org = await seedAccount({ kind: 'organization' });
    const owner = await seedAccount();
    const ownerMember = await seedMember(org.id, owner.id, 'owner');

    await expect(accountService.removeMember(org.id, ownerMember.id, true)).rejects.toThrow(
      /last owner/i,
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
      /personal account cannot be transferred/i,
    );
  });
});
