/**
 * The `thread_id` backfill, on a REAL Postgres.
 *
 * Every fixture row is inserted directly, without a thread — the state of a row
 * stored before the column existed. The oracle is the `WITH RECURSIVE` row walk
 * `getThread` runs: after the backfill, the rows sharing a `thread_id` must be
 * exactly the walk's components. Every run is scoped to the fixture's own user
 * (`userId`), so another file's rows in the same database cannot move a count.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { threadAdjacency, threadKeys } from '../../services/emailThreading';
import { backfillMessageThreads } from '../backfill-message-threads';

const unique = () => randomUUID().replace(/-/g, '');

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function fixtureUser() {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({ username: `bf${unique().slice(0, 10)}`, color: 'teal' })
    .returning({ id: users.id });
  const [mailbox] = await db
    .insert(mailboxes)
    .values({ userId: user.id, name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' })
    .returning({ id: mailboxes.id });
  const insert = async (values: {
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    threadId?: string;
  }) => {
    const [row] = await db
      .insert(messages)
      .values({
        userId: user.id,
        mailboxId: mailbox.id,
        messageId: values.messageId ?? `<m-${unique()}@example.com>`,
        fromAddress: 'a@example.com',
        subject: 's',
        size: 1,
        date: new Date(),
        inReplyTo: values.inReplyTo,
        references: values.references ?? [],
        threadId: values.threadId,
      })
      .returning({ id: messages.id, messageId: messages.messageId });
    return row;
  };
  return { userId: user.id, insert };
}

/** A small mailbox of every shape: a chain, a star, a pair, singletons. */
async function mixedMailbox() {
  const fixture = await fixtureUser();
  const chain = [await fixture.insert({})];
  for (let n = 0; n < 5; n++) {
    chain.push(await fixture.insert({ inReplyTo: chain[chain.length - 1].messageId }));
  }
  const root = `<root-${unique()}@example.com>`;
  const star = [];
  for (let n = 0; n < 12; n++) star.push(await fixture.insert({ references: [root] }));
  const pair = [await fixture.insert({})];
  pair.push(await fixture.insert({ references: [pair[0].messageId] }));
  const singles = [await fixture.insert({}), await fixture.insert({})];
  return { ...fixture, chain, star, pair, singles };
}

async function threadsOf(userId: string) {
  return getDb()
    .select({ id: messages.id, threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.userId, userId));
}

/** The stored grouping, as sorted member lists. */
async function storedPartition(userId: string): Promise<string[][]> {
  const groups = new Map<string, string[]>();
  for (const row of await threadsOf(userId)) {
    if (row.threadId === null) throw new Error(`row ${row.id} has no thread`);
    groups.set(row.threadId, [...(groups.get(row.threadId) ?? []), row.id]);
  }
  return [...groups.values()].map((group) => group.sort()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The walk's components, the same shape. */
async function walkPartition(userId: string): Promise<string[][]> {
  const placed = new Set<string>();
  const groups: string[][] = [];
  for (const { id } of await threadsOf(userId)) {
    if (placed.has(id)) continue;
    const members = await getDb().execute<{ id: string }>(sql`
      with recursive walk(id, ks) as (
          select seed.id, ${threadKeys('seed')}
          from messages seed
          where seed.user_id = ${userId} and seed.id = ${id}
        union
          select linked.id, ${threadKeys('linked')}
          from walk
          join messages linked
            on linked.user_id = ${userId}
           and ${threadAdjacency('linked', sql.raw('walk.ks'))}
      )
      select id from walk
    `);
    const group = [...new Set(members.map((row) => row.id))].sort();
    for (const member of group) placed.add(member);
    groups.push(group);
  }
  return groups.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

describe('backfillMessageThreads', () => {
  it('reports without writing in a dry run', async () => {
    const { userId } = await mixedMailbox();
    const stats = await backfillMessageThreads({ apply: false, userId });
    expect(stats.unassigned).toBe(22);
    expect(stats.stamped).toBe(0);
    expect(stats.remaining).toBe(22);
    expect((await threadsOf(userId)).every((row) => row.threadId === null)).toBe(true);
  });

  it('stamps every row so the stored grouping is the walk', async () => {
    const { userId, chain, star } = await mixedMailbox();
    const stats = await backfillMessageThreads({ apply: true, userId });
    expect(stats).toMatchObject({ users: 1, unassigned: 22, stamped: 22, remaining: 0 });

    const partition = await storedPartition(userId);
    expect(partition).toEqual(await walkPartition(userId));
    // Non-vacuous: the chain and the star are each one thread, the singletons apart.
    expect(partition.map((group) => group.length).sort((a, b) => a - b)).toEqual([1, 1, 2, 6, 12]);
    const byId = new Map((await threadsOf(userId)).map((row) => [row.id, row.threadId]));
    expect(new Set(chain.map((row) => byId.get(row.id))).size).toBe(1);
    expect(new Set(star.map((row) => byId.get(row.id))).size).toBe(1);
  });

  it('gives the same answer in batches of two, and a re-run changes nothing', async () => {
    const { userId } = await mixedMailbox();
    const first = await backfillMessageThreads({ apply: true, userId, batchSize: 2 });
    expect(first.remaining).toBe(0);
    expect(first.batches).toBeGreaterThan(1);
    const after = await threadsOf(userId);
    expect(await storedPartition(userId)).toEqual(await walkPartition(userId));

    const again = await backfillMessageThreads({ apply: true, userId, verify: true });
    expect(again).toMatchObject({ unassigned: 0, stamped: 0, mismatched: 0, remaining: 0 });
    expect(await threadsOf(userId)).toEqual(after);
  });

  it('keeps the id an already-assigned part of a conversation carries', async () => {
    // A reply that arrived after the deploy stamped its own row, and only it,
    // because its parent was still unassigned — then the rest is backfilled.
    const fixture = await fixtureUser();
    const parent = await fixture.insert({});
    const stamped = await fixture.insert({ inReplyTo: parent.messageId, threadId: 'kept-thread' });
    const sibling = await fixture.insert({ references: [parent.messageId] });

    await backfillMessageThreads({ apply: true, userId: fixture.userId });
    const byId = new Map((await threadsOf(fixture.userId)).map((row) => [row.id, row.threadId]));
    expect([parent, stamped, sibling].map((row) => byId.get(row.id))).toEqual([
      'kept-thread',
      'kept-thread',
      'kept-thread',
    ]);
  });

  it('finds, and with --apply repairs, two conversations sharing one id', async () => {
    // What a delete by an image older than the threading one leaves: the
    // bridge is gone, both halves still carry the id. No NULL points at it,
    // so only the verify pass can see it.
    const fixture = await fixtureUser();
    const left = await fixture.insert({ threadId: 'stale' });
    const leftReply = await fixture.insert({ inReplyTo: left.messageId, threadId: 'stale' });
    const right = await fixture.insert({ threadId: 'stale' });

    const report = await backfillMessageThreads({
      apply: false,
      verify: true,
      userId: fixture.userId,
    });
    expect(report.mismatched).toBe(3);
    expect((await threadsOf(fixture.userId)).every((row) => row.threadId === 'stale')).toBe(true);

    const repaired = await backfillMessageThreads({
      apply: true,
      verify: true,
      userId: fixture.userId,
    });
    expect(repaired).toMatchObject({ mismatched: 3, unrepaired: 0 });
    const byId = new Map((await threadsOf(fixture.userId)).map((row) => [row.id, row.threadId]));
    // The larger half keeps the id; the other gets its own.
    expect(byId.get(left.id)).toBe('stale');
    expect(byId.get(leftReply.id)).toBe('stale');
    expect(byId.get(right.id)).not.toBe('stale');
    expect(await storedPartition(fixture.userId)).toEqual(await walkPartition(fixture.userId));
  });
});
