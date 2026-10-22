/**
 * The folder-counter backfill, on a REAL Postgres, racing real writers.
 *
 * The races are forced, not hoped for (`Promise.all` alone proves nothing): each
 * test parks one side inside its transaction, waits until `pg_blocking_pids`
 * shows the other side queued behind it — and throws if it never does — then
 * lets it go. Assertions are scoped to folders this file owns: the database is
 * shared with every other file this worker runs.
 */

import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { backfillMailboxCounters } from '../backfill-mailbox-counters';

const unique = () => randomUUID().replace(/-/g, '');

interface Counters {
  total: number | null;
  unseen: number | null;
  bytes: number | null;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

function message(
  userId: string,
  mailboxId: string,
  values: { seen?: boolean; size?: number } = {},
): typeof messages.$inferInsert {
  return {
    userId,
    mailboxId,
    messageId: `<${unique()}@example.com>`,
    fromAddress: 'sender@example.com',
    subject: '',
    size: values.size ?? 100,
    seen: values.seen ?? false,
    date: new Date(),
  };
}

/**
 * A folder as it stood when 0205 ran: it already holds mail, and its counters
 * read NULL. Returns the folder ids in ascending order.
 */
async function uncountedFolders(
  userId: string,
  contents: ReadonlyArray<ReadonlyArray<{ seen?: boolean; size?: number }>>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const rows of contents) {
    const [created] = await getDb()
      .insert(mailboxes)
      .values({ userId, name: 'Folder', path: `F-${unique()}` })
      .returning({ id: mailboxes.id });
    if (rows.length > 0) {
      await getDb()
        .insert(messages)
        .values(rows.map((values) => message(userId, created.id, values)));
    }
    ids.push(created.id);
  }
  await getDb()
    .update(mailboxes)
    .set({ totalMessages: null, unseenMessages: null, sizeBytes: null })
    .where(inArray(mailboxes.id, ids));
  return ids.sort();
}

async function stored(mailboxId: string): Promise<Counters> {
  const [found] = await getDb()
    .select({
      total: mailboxes.totalMessages,
      unseen: mailboxes.unseenMessages,
      bytes: mailboxes.sizeBytes,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  return found;
}

async function aggregated(mailboxId: string): Promise<Counters> {
  const [found] = await getDb()
    .select({
      total: sql<number>`count(*)::int`,
      unseen: sql<number>`(count(*) filter (where not ${messages.seen}))::int`,
      bytes: sql<number>`coalesce(sum(${messages.size}), 0)::int`,
    })
    .from(messages)
    .where(eq(messages.mailboxId, mailboxId));
  return found;
}

async function expectCounted(mailboxId: string, expected: Counters): Promise<void> {
  expect(await aggregated(mailboxId)).toEqual(expected);
  expect(await stored(mailboxId)).toEqual(expected);
}

/** Resolve once `predicate` holds; throw if it never does — a race that never happened proves nothing. */
async function waitFor(description: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`precondition failed: ${description}`);
}

async function someoneBlockedBy(holderPid: number): Promise<boolean> {
  const [found] = await getDb().execute<{ blocked: boolean }>(sql`
    select exists (
      select 1 from pg_stat_activity
      where datname = current_database() and ${holderPid}::int = any (pg_blocking_pids(pid))
    ) as blocked
  `);
  return found?.blocked ?? false;
}

async function isBlocked(pid: number): Promise<boolean> {
  const [found] = await getDb().execute<{ blocked: boolean }>(sql`
    select cardinality(pg_blocking_pids(${pid}::int)) > 0 as blocked
  `);
  return found?.blocked ?? false;
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe('backfillMailboxCounters', () => {
  it('reports without writing in a dry run', async () => {
    const userId = await owner();
    const [folder] = await uncountedFolders(userId, [[{ size: 10 }]]);

    const stats = await backfillMailboxCounters({ apply: false, userId });

    expect(stats).toMatchObject({ uncounted: 1, counted: 0, remaining: 1 });
    expect(await stored(folder)).toEqual({ total: null, unseen: null, bytes: null });
  });

  it('counts every NULL folder exactly, and a re-run finds nothing to do', async () => {
    const userId = await owner();
    const [a, b, empty] = await uncountedFolders(userId, [
      [{ size: 10 }, { size: 20, seen: true }],
      [{ size: 3000 }],
      [],
    ]);

    const first = await backfillMailboxCounters({ apply: true, userId, batchSize: 2 });
    expect(first).toMatchObject({ uncounted: 3, counted: 3, failed: 0, remaining: 0 });

    await expectCounted(a, { total: 2, unseen: 1, bytes: 30 });
    await expectCounted(b, { total: 1, unseen: 1, bytes: 3000 });
    await expectCounted(empty, { total: 0, unseen: 0, bytes: 0 });

    const again = await backfillMailboxCounters({ apply: true, userId });
    expect(again).toMatchObject({ uncounted: 0, counted: 0, remaining: 0 });
  });

  it('resumes after a folder id', async () => {
    const userId = await owner();
    const [first, second, third] = await uncountedFolders(userId, [[{}], [{}], [{}]]);

    const stats = await backfillMailboxCounters({ apply: true, userId, after: second });

    expect(stats).toMatchObject({ counted: 1, lastMailboxId: third, remaining: 2 });
    expect((await stored(first)).total).toBeNull();
    expect((await stored(second)).total).toBeNull();
    await expectCounted(third, { total: 1, unseen: 1, bytes: 100 });
  });

  it('verifies counted folders, and recounts drift only under --apply', async () => {
    const userId = await owner();
    const [folder] = await uncountedFolders(userId, [[{ size: 5 }, { size: 6 }]]);
    await backfillMailboxCounters({ apply: true, userId });
    await getDb().update(mailboxes).set({ totalMessages: 999 }).where(eq(mailboxes.id, folder));

    const report = await backfillMailboxCounters({ apply: false, verify: true, userId });
    expect(report).toMatchObject({ verified: 1, drifted: 1, counted: 0 });
    expect((await stored(folder)).total).toBe(999);

    const repaired = await backfillMailboxCounters({ apply: true, verify: true, userId });
    expect(repaired).toMatchObject({ verified: 1, drifted: 1, counted: 1, failed: 0 });
    await expectCounted(folder, { total: 2, unseen: 2, bytes: 11 });
  });

  it('counts only the owner`s mail, and reports a message filed in another account`s folder', async () => {
    const userId = await owner();
    const stranger = await owner();
    const [folder] = await uncountedFolders(userId, [[{ size: 40 }]]);
    await getDb()
      .insert(messages)
      .values(message(stranger, folder, { size: 900 }));

    const report = await backfillMailboxCounters({ apply: true, verify: true, userId });

    expect(report).toMatchObject({ counted: 1, drifted: 0, crossOwnerMessages: 1 });
    expect(await stored(folder)).toEqual({ total: 1, unseen: 1, bytes: 40 });
  });
});

describe('backfillMailboxCounters racing writers', () => {
  it('waits for a writer that already holds the folder, then counts its rows', async () => {
    const userId = await owner();
    const [folder] = await uncountedFolders(userId, [[{ size: 10 }]]);

    // The writer's trigger has run (NULL stayed NULL) and it holds the folder
    // lock; its row is not committed yet.
    const writerMayCommit = gate();
    const writerInserted = gate();
    let writerPid = 0;
    const writer = getDb().transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      writerPid = pid.pid;
      await tx.insert(messages).values(message(userId, folder, { size: 500 }));
      writerInserted.open();
      await writerMayCommit.promise;
    });
    await writerInserted.promise;

    const backfill = backfillMailboxCounters({ apply: true, userId });
    await waitFor('the backfill never queued behind the writer', () => someoneBlockedBy(writerPid));
    writerMayCommit.open();

    await writer;
    expect(await backfill).toMatchObject({ counted: 1, failed: 0, remaining: 0 });
    await expectCounted(folder, { total: 2, unseen: 2, bytes: 510 });
  });

  it('makes a writer that arrives mid-count queue, then add its delta to the counted value', async () => {
    const userId = await owner();
    const [folder] = await uncountedFolders(userId, [[{ size: 10 }]]);

    const backfillMayCount = gate();
    const backfillLocked = gate();
    const backfill = backfillMailboxCounters({
      apply: true,
      userId,
      onLocked: async () => {
        backfillLocked.open();
        await backfillMayCount.promise;
      },
    });
    await backfillLocked.promise;

    let writerPid = 0;
    const writerStarted = gate();
    const writer = getDb().transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      writerPid = pid.pid;
      writerStarted.open();
      await tx.insert(messages).values(message(userId, folder, { size: 500, seen: true }));
    });
    await writerStarted.promise;
    await waitFor('the writer never queued behind the backfill', () => isBlocked(writerPid));
    backfillMayCount.open();

    expect(await backfill).toMatchObject({ counted: 1, failed: 0, remaining: 0 });
    await writer;
    await expectCounted(folder, { total: 2, unseen: 1, bytes: 510 });
  });
});
