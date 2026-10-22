/**
 * The folder counter triggers (`mailboxCounters.ts`, migration 0206), against a
 * REAL Postgres.
 *
 * The claim under test is that NO write path can make `mailboxes.total_messages`,
 * `unseen_messages` or `size_bytes` disagree with the messages they count. So
 * every scenario writes `messages` with plain SQL — no service code — which is
 * exactly what the image that predates the counters does, and what a cascade
 * does. Each one then compares the columns with the aggregate they replace and
 * with the numbers the scenario expects, so an equality that holds at zero can
 * never pass on its own.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import {
  MAILBOX_COUNTERS_FUNCTION,
  MAILBOX_COUNTERS_FUNCTION_DDL,
  MAILBOX_COUNTERS_TRIGGER_DDL,
  MAILBOX_COUNTERS_TRIGGERS,
} from '../mailboxCounters';
import { mailboxes } from '../mailboxes';
import { messages } from '../messages';
import { users } from '../users';

const MIGRATION_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'drizzle',
  '0193_mailbox_counter_triggers.sql',
);

const unique = () => randomUUID().replace(/-/g, '');

interface Counters {
  total: number | null;
  unseen: number | null;
  bytes: number | null;
}

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/** A folder created the way the image that predates the counters creates one: naming none of them. */
async function folder(userId: string): Promise<string> {
  const id = randomUUID();
  await getDb().execute(sql`
    insert into mailboxes (id, user_id, name, path) values (${id}, ${userId}, 'Folder', ${`F-${unique()}`})
  `);
  return id;
}

/** Folders in ascending id order, so a test can name the one the trigger locks first. */
async function folders(userId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(await folder(userId));
  return ids.sort();
}

function row(
  userId: string,
  mailboxId: string,
  values: { seen?: boolean; size?: number; labels?: string[] } = {},
): typeof messages.$inferInsert {
  return {
    userId,
    mailboxId,
    messageId: `<${unique()}@example.com>`,
    fromAddress: 'sender@example.com',
    subject: '',
    size: values.size ?? 100,
    seen: values.seen ?? false,
    labels: values.labels ?? [],
    date: new Date(),
  };
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
  return { total: found.total, unseen: found.unseen, bytes: found.bytes };
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

/** The stored counters equal both the aggregate and the numbers the scenario states. */
async function expectCounted(mailboxId: string, expected: Counters): Promise<void> {
  expect(await aggregated(mailboxId)).toEqual(expected);
  expect(await stored(mailboxId)).toEqual(expected);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the migration and the installed triggers', () => {
  const migration = readFileSync(MIGRATION_PATH, 'utf8');

  it('carries the DDL the schema module declares authoritative, verbatim', () => {
    expect(migration).toContain(MAILBOX_COUNTERS_FUNCTION_DDL);
    for (const ddl of MAILBOX_COUNTERS_TRIGGER_DDL) expect(migration).toContain(ddl);
    expect(migration.split('\n')[0]).toBe('-- oxy:deploy-phase=pre');
  });

  it('installs four statement-level AFTER triggers on messages, all running the one function', async () => {
    const rows = await getDb().execute<{ definition: string }>(sql`
      select pg_get_triggerdef(t.oid) as definition
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      where not t.tgisinternal and c.relname = 'messages'
        and t.tgname like 'messages_mailbox_counters_%'
      order by t.tgname
    `);
    const run = `FOR EACH STATEMENT EXECUTE FUNCTION ${MAILBOX_COUNTERS_FUNCTION}()`;
    expect(rows.map((found) => found.definition)).toEqual([
      `CREATE TRIGGER ${MAILBOX_COUNTERS_TRIGGERS.delete} AFTER DELETE ON public.messages REFERENCING OLD TABLE AS old_rows ${run}`,
      `CREATE TRIGGER ${MAILBOX_COUNTERS_TRIGGERS.insert} AFTER INSERT ON public.messages REFERENCING NEW TABLE AS new_rows ${run}`,
      `CREATE TRIGGER ${MAILBOX_COUNTERS_TRIGGERS.truncate} AFTER TRUNCATE ON public.messages ${run}`,
      `CREATE TRIGGER ${MAILBOX_COUNTERS_TRIGGERS.update} AFTER UPDATE ON public.messages REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows ${run}`,
    ]);
  });
});

describe('the counters follow every write to messages', () => {
  it('starts a new folder at zero, even one created without naming the columns', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    expect(await stored(mailboxId)).toEqual({ total: 0, unseen: 0, bytes: 0 });
  });

  it('adds a multi-row insert to each folder it lands in', async () => {
    const userId = await owner();
    const [a, b] = await folders(userId, 2);
    await getDb()
      .insert(messages)
      .values([
        row(userId, a, { size: 100 }),
        row(userId, a, { size: 250, seen: true }),
        row(userId, b, { size: 4000 }),
      ]);
    await expectCounted(a, { total: 2, unseen: 1, bytes: 350 });
    await expectCounted(b, { total: 1, unseen: 1, bytes: 4000 });
  });

  it('follows flags and size in both directions', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const ids = (
      await getDb()
        .insert(messages)
        .values([row(userId, mailboxId), row(userId, mailboxId), row(userId, mailboxId)])
        .returning({ id: messages.id })
    ).map((found) => found.id);

    await getDb()
      .update(messages)
      .set({ seen: true })
      .where(inArray(messages.id, ids.slice(0, 2)));
    await expectCounted(mailboxId, { total: 3, unseen: 1, bytes: 300 });

    await getDb().update(messages).set({ seen: false }).where(eq(messages.id, ids[0]));
    await getDb().update(messages).set({ size: 900 }).where(eq(messages.id, ids[2]));
    await expectCounted(mailboxId, { total: 3, unseen: 2, bytes: 1100 });
  });

  it('moves counts between folders, both directions in ONE statement', async () => {
    const userId = await owner();
    const [a, b] = await folders(userId, 2);
    await getDb()
      .insert(messages)
      .values([
        row(userId, a, { size: 10 }),
        row(userId, a, { size: 20, seen: true }),
        row(userId, b, { size: 300 }),
      ]);

    // Swap every row's folder: A's two rows go to B and B's one goes to A.
    await getDb().execute(sql`
      update messages set mailbox_id = case when mailbox_id = ${a} then ${b} else ${a} end
      where mailbox_id in (${a}, ${b})
    `);
    await expectCounted(a, { total: 1, unseen: 1, bytes: 300 });
    await expectCounted(b, { total: 2, unseen: 1, bytes: 30 });
  });

  it('neither writes nor locks the folder for an update that moves no counter', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const [message] = await getDb()
      .insert(messages)
      .values(row(userId, mailboxId))
      .returning({ id: messages.id });
    const tuple = async () =>
      (
        await getDb().execute<{ ctid: string; xmax: string }>(sql`
          select ctid::text as ctid, xmax::text as xmax from mailboxes where id = ${mailboxId}
        `)
      )[0];
    const before = await tuple();

    await getDb()
      .update(messages)
      .set({ labels: ['Receipts'], starred: true, pinned: true })
      .where(eq(messages.id, message.id));

    // Same tuple (no UPDATE) and the same xmax: a FOR NO KEY UPDATE by this
    // statement would have recorded its own transaction there.
    expect(await tuple()).toEqual(before);
    await expectCounted(mailboxId, { total: 1, unseen: 1, bytes: 100 });
  });

  it('subtracts deleted rows', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    const ids = (
      await getDb()
        .insert(messages)
        .values([
          row(userId, mailboxId, { size: 1 }),
          row(userId, mailboxId, { size: 2, seen: true }),
          row(userId, mailboxId, { size: 4 }),
        ])
        .returning({ id: messages.id })
    ).map((found) => found.id);

    await getDb()
      .delete(messages)
      .where(inArray(messages.id, ids.slice(0, 2)));
    await expectCounted(mailboxId, { total: 1, unseen: 1, bytes: 4 });
  });

  it('leaves a folder that is not counted yet at NULL, and still counts the others', async () => {
    const userId = await owner();
    const [counted, uncounted] = await folders(userId, 2);
    await getDb()
      .update(mailboxes)
      .set({ totalMessages: null, unseenMessages: null, sizeBytes: null })
      .where(eq(mailboxes.id, uncounted));

    await getDb()
      .insert(messages)
      .values([row(userId, counted), row(userId, uncounted)]);
    await getDb()
      .update(messages)
      .set({ mailboxId: counted })
      .where(eq(messages.mailboxId, uncounted));

    expect(await stored(uncounted)).toEqual({ total: null, unseen: null, bytes: null });
    await expectCounted(counted, { total: 2, unseen: 2, bytes: 200 });
  });

  it('counts only the owner`s mail, as the aggregate it replaces did', async () => {
    const userId = await owner();
    const stranger = await owner();
    const mailboxId = await folder(userId);
    await getDb()
      .insert(messages)
      .values(row(userId, mailboxId, { size: 10 }));
    // No service path files a row under another account's folder; if one ever
    // did, the old `where user_id = $1` aggregate ignored it. Its own
    // statement, so the stranger's row is the only delta the trigger sees.
    await getDb()
      .insert(messages)
      .values(row(stranger, mailboxId, { size: 999 }));
    expect(await stored(mailboxId)).toEqual({ total: 1, unseen: 1, bytes: 10 });

    // Re-owning the row (an UPDATE of user_id alone) brings it into the count.
    await getDb().update(messages).set({ userId }).where(eq(messages.userId, stranger));
    await expectCounted(mailboxId, { total: 2, unseen: 2, bytes: 1009 });
  });

  it('survives TRUNCATE: every folder is empty afterwards, so every counter reads 0', async () => {
    const userId = await owner();
    const mailboxId = await folder(userId);
    await getDb().insert(messages).values(row(userId, mailboxId));
    expect((await stored(mailboxId)).total).toBe(1);

    // Rolled back: the database is shared with the rest of this worker's files.
    const rollback = new Error('rollback');
    await expect(
      getDb().transaction(async (tx) => {
        await tx.execute(sql`truncate messages cascade`);
        const [after] = await tx
          .select({
            total: mailboxes.totalMessages,
            unseen: mailboxes.unseenMessages,
            bytes: mailboxes.sizeBytes,
          })
          .from(mailboxes)
          .where(eq(mailboxes.id, mailboxId));
        expect(after).toEqual({ total: 0, unseen: 0, bytes: 0 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    await expectCounted(mailboxId, { total: 1, unseen: 1, bytes: 100 });
  });
});

describe('the counters through cascades', () => {
  it('deletes a folder with its messages, and leaves a folder its snoozes pointed from exact', async () => {
    const userId = await owner();
    const [doomed, kept] = await folders(userId, 2);
    await getDb()
      .insert(messages)
      .values([
        row(userId, doomed),
        { ...row(userId, kept, { size: 70 }), snoozedFromMailbox: doomed },
      ]);

    // Two cascades: DELETE of doomed's messages, SET NULL on kept's snooze origin.
    await getDb().delete(mailboxes).where(eq(mailboxes.id, doomed));

    expect(await getDb().select().from(mailboxes).where(eq(mailboxes.id, doomed))).toEqual([]);
    await expectCounted(kept, { total: 1, unseen: 1, bytes: 70 });
  });

  it('deletes a user — folders and messages cascade together — without touching anyone else', async () => {
    const doomedUser = await owner();
    const otherUser = await owner();
    const [first, second] = await folders(doomedUser, 2);
    const other = await folder(otherUser);
    await getDb()
      .insert(messages)
      .values([row(doomedUser, first), row(doomedUser, second), row(otherUser, other)]);

    await getDb().delete(users).where(eq(users.id, doomedUser));

    expect(
      await getDb()
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(eq(mailboxes.userId, doomedUser)),
    ).toEqual([]);
    await expectCounted(other, { total: 1, unseen: 1, bytes: 100 });
  });
});

describe('lock order', () => {
  /** Resolve when `waiterPid` is blocked by `holderPid`; throw if it never is. */
  async function waitUntilBlocked(waiterPid: number, holderPid: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const [found] = await getDb().execute<{ blocked: boolean }>(sql`
        select ${holderPid}::int = any (pg_blocking_pids(${waiterPid}::int)) as blocked
      `);
      if (found?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('precondition failed: the second statement never waited on the first');
  }

  it('locks folders in id order, so a statement that waits holds nothing the holder needs next', async () => {
    const userId = await owner();
    const [low, high] = await folders(userId, 2);
    const seeded = await getDb()
      .insert(messages)
      // Different sizes, so swapping them leaves a non-zero delta on both folders
      // (a swap of two identical rows moves no counter and rightly locks nothing).
      .values([row(userId, low, { size: 100 }), row(userId, high, { size: 300 })])
      .returning({ id: messages.id });

    let releaseHolder: () => void = () => undefined;
    const holderMayFinish = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderPid = 0;
    let holderLocked: () => void = () => undefined;
    const holderHasLow = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });

    // The holder writes into `low` (locking it), then — in a LATER statement —
    // into `high`.
    const holder = getDb().transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      holderPid = pid.pid;
      await tx.insert(messages).values(row(userId, low));
      holderLocked();
      await holderMayFinish;
      await tx.insert(messages).values(row(userId, high));
    });
    await holderHasLow;

    // The waiter's one statement touches both folders. Locking in id order, it
    // queues on `low` before it takes `high`; locking `high` first would
    // deadlock with the holder's next statement.
    const waiter = getDb().transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      const waiting = waitUntilBlocked(pid.pid, holderPid).then(releaseHolder);
      await tx.execute(sql`
        update messages set mailbox_id = case when mailbox_id = ${low} then ${high} else ${low} end
        where id in (${seeded[0].id}, ${seeded[1].id})
      `);
      await waiting;
    });

    await Promise.all([holder, waiter]);
    await expectCounted(low, { total: 2, unseen: 2, bytes: 400 });
    await expectCounted(high, { total: 2, unseen: 2, bytes: 200 });
  });
});
