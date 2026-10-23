/**
 * The order a message list is read in, and the plan Postgres reads it with,
 * against a REAL Postgres.
 *
 * The keyset cursor is a single row comparison `(pinned, date, id) < (…)` and
 * the ORDER BY is spelled `desc nulls last`, the spelling the listing indexes
 * are built in. Two things have to hold:
 *
 *  - the pages are the SAME rows in the SAME order as before: every row once,
 *    ties on `pinned` and `date` broken by id, cursor pages agreeing with
 *    offset pages. 120 rows over a handful of dates make most of them ties.
 *  - the plan has no Sort node. Drizzle's bare `desc()` is `desc nulls first`,
 *    which no index matches, so every page sorted the whole folder before its
 *    LIMIT. Asserted with `enable_sort = off`, under which the planner still
 *    sorts when no index can give the order, so a plan without a Sort node
 *    means the index gives it. Today's index stops at `date`, so an
 *    Incremental Sort orders the id ties inside each presorted group — it
 *    reads only as far as the LIMIT, unlike a Sort, and is allowed. The
 *    control case runs the OLD spelling and must find a full Sort, so this
 *    test can tell the two apart.
 */

jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));

import { randomUUID } from 'node:crypto';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService, MESSAGE_LIST_ORDER, messageListAfter } from '../email.service';
import { insertMessageRows } from '../../../test-support/messageRows';

const unique = () => randomUUID().replace(/-/g, '');

const ROWS = 120;
/** Five distinct dates for 120 rows: almost every row ties with another. */
const DATES = [0, 1, 2, 3, 4].map((day) => new Date(Date.UTC(2026, 0, 10 - day, 12)));

interface Seeded {
  userId: string;
  mailboxId: string;
  /** The ids in the order the list must answer them. */
  expected: string[];
}

async function seed(): Promise<Seeded> {
  const [user] = await getDb()
    .insert(users)
    .values({ username: `ord${unique().slice(0, 10)}`, color: 'teal' })
    .returning({ id: users.id });
  const [mailbox] = await getDb()
    .insert(mailboxes)
    .values({ userId: user.id, name: 'Inbox', path: `Inbox-${unique()}` })
    .returning({ id: mailboxes.id });

  const rows = await insertMessageRows(
    Array.from({ length: ROWS }, (_, i) => ({
      userId: user.id,
      mailboxId: mailbox.id,
      messageId: `<${unique()}@example.com>`,
      fromAddress: 'sender@example.com',
      subject: `m${i}`,
      size: 10,
      pinned: i % 12 === 0,
      date: DATES[i % DATES.length],
    })),
  );

  const expected = [...rows]
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.date.getTime() - a.date.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
    .map((row) => row.id);
  return { userId: user.id, mailboxId: mailbox.id, expected };
}

/** Every node type in an `EXPLAIN (FORMAT JSON)` plan. */
function nodeTypes(plan: unknown): string[] {
  if (!plan || typeof plan !== 'object') return [];
  const node = plan as { 'Node Type'?: string; Plans?: unknown[] };
  return [
    ...(node['Node Type'] ? [node['Node Type']] : []),
    ...(node.Plans ?? []).flatMap(nodeTypes),
  ];
}

/** The plan of a first-or-later page of the folder, read in `order`. */
async function planOf(seeded: Seeded, order: readonly SQL[], after?: SQL): Promise<string[]> {
  const db = getDb();
  const page = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.userId, seeded.userId),
        eq(messages.mailboxId, seeded.mailboxId),
        ...(after ? [after] : []),
      ),
    )
    .orderBy(...order)
    .limit(51);
  // LOCAL to this transaction, so neither setting leaks into another test.
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set local enable_seqscan = off`);
    await tx.execute(sql`set local enable_sort = off`);
    return tx.execute<{ 'QUERY PLAN': unknown }>(sql`explain (format json) ${page}`);
  });
  const [{ 'QUERY PLAN': plan }] = rows;
  const [root] = (typeof plan === 'string' ? JSON.parse(plan) : plan) as Array<{ Plan: unknown }>;
  return nodeTypes(root.Plan);
}

let seeded: Seeded;

beforeAll(async () => {
  await connectPostgres();
  seeded = await seed();
});

afterAll(async () => {
  await closePostgres();
});

describe('listMessages pages', () => {
  it('walks 120 tied rows by cursor in order, each exactly once', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const result = await emailService.listMessages(seeded.userId, seeded.mailboxId, {
        limit: 25,
        cursor,
      });
      seen.push(...result.data.map((m) => m.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(seeded.expected);
  });

  it('answers the same order by offset', async () => {
    const seen: string[] = [];
    for (const offset of [0, 50, 100]) {
      const result = await emailService.listMessages(seeded.userId, seeded.mailboxId, {
        limit: 50,
        offset,
      });
      seen.push(...result.data.map((m) => m.id));
    }
    expect(seen).toEqual(seeded.expected);
  });
});

describe('queryless searchMessages pages', () => {
  it('walks every row by cursor, newest first, ties broken by id', async () => {
    // Search ignores `pinned`: date, then id.
    const rows = await getDb()
      .select({ id: messages.id, date: messages.date })
      .from(messages)
      .where(eq(messages.userId, seeded.userId));
    const byDateThenId = rows
      .sort(
        (a, b) => b.date.getTime() - a.date.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )
      .map((row) => row.id);
    expect(byDateThenId).toHaveLength(ROWS);

    const seen: string[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page++) {
      const result = await emailService.searchMessages(seeded.userId, '', { limit: 25, cursor });
      seen.push(...result.data.map((m) => m.id));
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(byDateThenId);
  });
});

describe('the listing plan', () => {
  it('reads the first page in index order, with no Sort node', async () => {
    const plan = await planOf(seeded, MESSAGE_LIST_ORDER);
    expect(plan).not.toContain('Sort');
    expect(plan.some((type) => type.includes('Index'))).toBe(true);
  });

  it('reads a cursor page in index order too', async () => {
    const plan = await planOf(
      seeded,
      MESSAGE_LIST_ORDER,
      messageListAfter({ pinned: false, date: DATES[2].toISOString(), id: seeded.expected[60] }),
    );
    expect(plan).not.toContain('Sort');
  });

  it('control: the old `desc()` spelling DOES sort, so the cases above can fail', async () => {
    const plan = await planOf(seeded, [
      desc(messages.pinned),
      desc(messages.date),
      desc(messages.id),
    ]);
    expect(plan).toContain('Sort');
  });
});
