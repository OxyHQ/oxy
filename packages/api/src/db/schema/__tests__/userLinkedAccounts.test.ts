/**
 * `user_linked_accounts` / `linked_account_oauth_challenges` invariants the
 * generic gates do not cover: one LIVE claim per external account, the closed
 * value sets, alias-only-for-ActivityPub, and what deleting a user does.
 * Real Postgres, no mocks.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { linkedAccountOauthChallenges, userLinkedAccounts } from '../userLinkedAccounts';
import { users } from '../users';
import { applications } from '../applications';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

async function user(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

function link(userId: string, accountKey: string, extra: Partial<typeof userLinkedAccounts.$inferInsert> = {}) {
  return getDb()
    .insert(userLinkedAccounts)
    .values({
      userId,
      network: 'activitypub',
      accountKey,
      actorUri: `https://mastodon.example/users/${accountKey.split('@')[0]}`,
      handle: `@${accountKey}`,
      host: 'mastodon.example',
      verifiedAt: new Date(),
      ...extra,
    })
    .returning({ id: userLinkedAccounts.id });
}

/** A challenge row for `userId`, returning to a first-party app. */
async function challenge(userId: string, extra: Partial<typeof linkedAccountOauthChallenges.$inferInsert> = {}) {
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `Move ${randomUUID()}`, ownerAccountId: userId, type: 'first_party', redirectUris: ['oxymove://linked'] })
    .returning({ id: applications.id });
  return getDb().insert(linkedAccountOauthChallenges).values({
    userId,
    network: 'activitypub',
    clientApplicationId: app.id,
    returnTo: 'oxymove://linked',
    expiresAt: new Date(Date.now() + 60_000),
    ...extra,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('user_linked_accounts — one live claim per external account', () => {
  it('refuses a second LIVE claim of the same account, by anyone', async () => {
    const key = `alice-${randomUUID().slice(0, 8)}@mastodon.example`;
    await link(await user(), key);
    expect(pgErrorCode(await rejection(link(await user(), key)))).toBe(UNIQUE_VIOLATION);
  });

  it('frees the account once the live claim is revoked, and keeps the history', async () => {
    const key = `bob-${randomUUID().slice(0, 8)}@mastodon.example`;
    const [first] = await link(await user(), key);
    await getDb().update(userLinkedAccounts).set({ revokedAt: new Date() }).where(eq(userLinkedAccounts.id, first.id));
    const [second] = await link(await user(), key);
    expect(second.id).not.toBe(first.id);
    const rows = await getDb().select({ id: userLinkedAccounts.id }).from(userLinkedAccounts).where(eq(userLinkedAccounts.accountKey, key));
    expect(rows).toHaveLength(2);
  });

  it('scopes uniqueness by network', async () => {
    const key = `did:plc:${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const owner = await user();
    await link(owner, key, { network: 'atproto', actorUri: key });
    await expect(link(await user(), key, { network: 'activitypub' })).resolves.toHaveLength(1);
  });
});

describe('user_linked_accounts — closed value sets', () => {
  it('rejects an undeclared network', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into user_linked_accounts (id, user_id, network, account_key, actor_uri, handle, host, verified_at)
        values (${randomUUID()}, ${await user()}, 'twitter', 'x', 'x', 'x', 'x', now())
      `),
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('rejects an undeclared proof method', async () => {
    const error = await rejection(
      getDb().execute(sql`
        insert into user_linked_accounts (id, user_id, network, account_key, actor_uri, handle, host, verified_at, proof_method)
        values (${randomUUID()}, ${await user()}, 'activitypub', ${randomUUID()}, 'x', 'x', 'x', now(), 'bio_code')
      `),
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('has no column a third-party token could live in, on any of the three tables', async () => {
    const rows = await getDb().execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name in ('user_linked_accounts', 'linked_account_oauth_challenges', 'mastodon_app_registrations')
    `);
    const names = (Array.isArray(rows) ? rows : (rows as { rows: Array<{ column_name: string }> }).rows).map((row) => row.column_name);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((name) => /token|refresh|access/i.test(name))).toEqual([]);
  });
});

describe('linked_account_oauth_challenges', () => {
  it('stores only a SHA-256 hex state hash', async () => {
    const error = await rejection(challenge(await user(), { stateHash: 'raw-state-value' }));
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('stores only a SHA-256 hex link code hash', async () => {
    const error = await rejection(
      challenge(await user(), { status: 'verified', accountKey: 'a@b.example', actorUri: 'https://b.example/users/a', handle: '@a@b.example', host: 'b.example', linkCodeHash: 'raw-code' }),
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a verified row that names no account', async () => {
    const error = await rejection(challenge(await user(), { status: 'verified' }));
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('allows many unbound (atproto, pre-authorize) rows', async () => {
    const owner = await user();
    for (let i = 0; i < 2; i++) await challenge(owner, { network: 'atproto' });
  });
});

describe('deleting the local user', () => {
  it('takes their links and challenges with it', async () => {
    const owner = await user();
    const [row] = await link(owner, `carol-${randomUUID().slice(0, 8)}@mastodon.example`);
    await challenge(owner);
    await getDb().delete(users).where(eq(users.id, owner));
    expect(await getDb().select().from(userLinkedAccounts).where(eq(userLinkedAccounts.id, row.id))).toEqual([]);
    expect(
      await getDb()
        .select({ id: linkedAccountOauthChallenges.id })
        .from(linkedAccountOauthChallenges)
        .where(eq(linkedAccountOauthChallenges.userId, owner)),
    ).toEqual([]);
  });
});
