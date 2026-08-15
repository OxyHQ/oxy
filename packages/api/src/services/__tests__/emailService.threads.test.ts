/**
 * Thread stitching, against a REAL Postgres.
 *
 * Mongo fetched every message adjacent to the union of a page's Message-ID
 * tokens and then resolved siblings per page message IN JS — one hop. The port
 * walks the same adjacency transitively with `WITH RECURSIVE`, and three things
 * about that walk are load-bearing and could each be wrong while looking right:
 *
 *   1. **It is transitive.** A one-hop walk passes every test built from a
 *      thread whose members all share one reference — which is most real
 *      threads. The chain case below is the one that separates them.
 *   2. **`root_id` rides along.** Without it the walk returns ONE merged set
 *      and every page message reports the union of every thread on the page.
 *      Two unrelated threads in one page is the case that catches it.
 *   3. **`union`, not `union all`.** It is the cycle guard. A `References` loop
 *      recurses forever otherwise — the test would hang rather than fail, so it
 *      runs under a timeout.
 *
 * `getThread` shares the same walk deliberately, so a list that says
 * `threadCount: 5` cannot open onto a thread view showing three; that agreement
 * is asserted rather than assumed.
 */

jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({ aiLabelingService: { enqueueClassification: jest.fn() } }));
jest.mock('../cardExtraction.service', () => ({ cardExtractionService: { extractAndUpdate: jest.fn() } }));
jest.mock('../smtp.outbound', () => ({ __esModule: true, smtpOutbound: {}, default: {} }));
jest.mock('../emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../assetServiceSingleton', () => ({ assetService: {} }));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function owner(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function inbox(userId: string): Promise<string> {
  const [row] = await getDb()
    .insert(mailboxes)
    .values({ userId, name: 'INBOX', path: `INBOX-${unique()}`, specialUse: '\\Inbox' })
    .returning({ id: mailboxes.id });
  return row.id;
}

/** One stored message, with only the threading headers that matter here. */
async function store(
  userId: string,
  mailboxId: string,
  headers: {
    messageId: string;
    inReplyTo?: string;
    references?: string[];
    fromAddress?: string;
    date?: Date;
  },
): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: headers.messageId,
      fromAddress: headers.fromAddress ?? 'sender@example.com',
      subject: '',
      size: 10,
      inReplyTo: headers.inReplyTo,
      references: headers.references ?? [],
      date: headers.date ?? new Date(),
    })
    .returning({ id: messages.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('listMessages — the thread walk is transitive', () => {
  it('counts a message two hops away that shares no reference with the anchor', async () => {
    // A —(R1)— B —(R2)— C. A and C share NOTHING: the only path between them
    // runs through B. Mongo's one-hop resolution counted A's thread as two;
    // the recursive walk counts three. Deleting the recursive term of the CTE
    // — or replacing the `join` with a second seed scan — makes this go red.
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const r1 = `<r1-${unique()}@example.com>`;
    const r2 = `<r2-${unique()}@example.com>`;

    const a = await store(userId, mailboxId, {
      messageId: `<a-${unique()}@example.com>`,
      references: [r1],
      fromAddress: 'ada@example.com',
    });
    await store(userId, mailboxId, {
      messageId: `<b-${unique()}@example.com>`,
      references: [r1, r2],
      fromAddress: 'grace@example.com',
    });
    await store(userId, mailboxId, {
      messageId: `<c-${unique()}@example.com>`,
      references: [r2],
      fromAddress: 'alan@example.com',
    });

    const { data } = await emailService.listMessages(userId, mailboxId, { limit: 50 });
    const anchor = data.find((m) => m.id === a);

    expect(anchor?.threadCount).toBe(3);
    expect(anchor?.threadParticipants?.slice().sort()).toEqual([
      'ada@example.com',
      'alan@example.com',
      'grace@example.com',
    ]);
  });

  it('follows an In-Reply-To chain in both directions', async () => {
    // parent ← child ← grandchild, linked only by In-Reply-To. The walk has to
    // traverse the edge from a message to the one that replies to it AND the
    // edge back, or one end of the chain reports a short count.
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const parentId = `<p-${unique()}@example.com>`;
    const childId = `<c-${unique()}@example.com>`;

    const parent = await store(userId, mailboxId, { messageId: parentId, references: [parentId] });
    const child = await store(userId, mailboxId, {
      messageId: childId,
      inReplyTo: parentId,
    });
    const grandchild = await store(userId, mailboxId, {
      messageId: `<g-${unique()}@example.com>`,
      inReplyTo: childId,
    });

    const { data } = await emailService.listMessages(userId, mailboxId, { limit: 50 });
    const counts = new Map(data.map((m) => [m.id, m.threadCount]));
    const threadIds = new Set(data.filter((m) => m.threadCount === 3).map((m) => m.threadId));

    expect(counts.get(child)).toBe(3);
    expect(counts.get(grandchild)).toBe(3);
    // `parent` carries a `References` header, so it is a seed too.
    expect(counts.get(parent)).toBe(3);
    expect(threadIds.size).toBe(1);
  });

  it('keeps two unrelated threads on one page apart', async () => {
    // Without `root_id` the walk returns one merged component and BOTH of these
    // report 4. This is the assertion that catches a dropped root column.
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const left = `<left-${unique()}@example.com>`;
    const right = `<right-${unique()}@example.com>`;

    const leftHead = await store(userId, mailboxId, {
      messageId: `<l1-${unique()}@example.com>`,
      references: [left],
    });
    await store(userId, mailboxId, {
      messageId: `<l2-${unique()}@example.com>`,
      references: [left],
    });
    const rightHead = await store(userId, mailboxId, {
      messageId: `<r1-${unique()}@example.com>`,
      references: [right],
    });
    await store(userId, mailboxId, {
      messageId: `<r2-${unique()}@example.com>`,
      references: [right],
    });

    const { data } = await emailService.listMessages(userId, mailboxId, { limit: 50 });
    const counts = new Map(data.map((m) => [m.id, m.threadCount]));

    expect(counts.get(leftHead)).toBe(2);
    expect(counts.get(rightHead)).toBe(2);
  });

  it('terminates on a References cycle instead of recursing forever', async () => {
    // Two messages that each reference the other's Message-ID. `union all`
    // would never settle; `union` refuses to re-expand a row already in the
    // result. The timeout is the assertion for the failure mode.
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const first = `<cycle-a-${unique()}@example.com>`;
    const second = `<cycle-b-${unique()}@example.com>`;

    const a = await store(userId, mailboxId, { messageId: first, references: [second] });
    await store(userId, mailboxId, { messageId: second, references: [first] });

    const { data } = await emailService.listMessages(userId, mailboxId, { limit: 50 });
    expect(data.find((m) => m.id === a)?.threadCount).toBe(2);
  }, 15_000);

  it('leaves a lone message with threading headers uncounted', async () => {
    // A message is always in its own component, so the count is never zero —
    // the rule is "more than one", exactly as Mongo's `siblings.length > 1`.
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const lonely = await store(userId, mailboxId, {
      messageId: `<lonely-${unique()}@example.com>`,
      inReplyTo: `<gone-${unique()}@example.com>`,
    });

    const { data } = await emailService.listMessages(userId, mailboxId, { limit: 50 });
    const message = data.find((m) => m.id === lonely);

    expect(message?.threadCount).toBeUndefined();
    expect(message?.threadParticipants).toBeUndefined();
  });

  it('never reaches another account`s mail', async () => {
    const mine = await owner();
    const theirs = await owner();
    const myBox = await inbox(mine);
    const theirBox = await inbox(theirs);
    const shared = `<shared-${unique()}@example.com>`;

    const anchor = await store(mine, myBox, {
      messageId: `<m1-${unique()}@example.com>`,
      references: [shared],
    });
    await store(theirs, theirBox, {
      messageId: `<t1-${unique()}@example.com>`,
      references: [shared],
    });

    const { data } = await emailService.listMessages(mine, myBox, { limit: 50 });
    expect(data.find((m) => m.id === anchor)?.threadCount).toBeUndefined();
  });
});

describe('getThread — the same walk, so the two can never disagree', () => {
  it('returns exactly the messages listMessages counted, oldest first', async () => {
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const r1 = `<r1-${unique()}@example.com>`;
    const r2 = `<r2-${unique()}@example.com>`;
    const base = Date.now();

    const a = await store(userId, mailboxId, {
      messageId: `<a-${unique()}@example.com>`,
      references: [r1],
      date: new Date(base),
    });
    const b = await store(userId, mailboxId, {
      messageId: `<b-${unique()}@example.com>`,
      references: [r1, r2],
      date: new Date(base + 1000),
    });
    const c = await store(userId, mailboxId, {
      messageId: `<c-${unique()}@example.com>`,
      references: [r2],
      date: new Date(base + 2000),
    });

    const { data } = await emailService.listMessages(userId, mailboxId, { limit: 50 });
    const counted = data.find((m) => m.id === a)?.threadCount;

    const thread = await emailService.getThread(userId, a);

    expect(thread.map((m) => m.id)).toEqual([a, b, c]);
    expect(thread).toHaveLength(counted ?? 0);
    expect(new Set(thread.map((m) => m.threadId)).size).toBe(1);
  });

  it('keeps cursor pages stable and non-overlapping', async () => {
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const base = Date.now();
    await store(userId, mailboxId, {
      messageId: `<cursor-a-${unique()}@example.com>`,
      date: new Date(base),
    });
    await store(userId, mailboxId, {
      messageId: `<cursor-b-${unique()}@example.com>`,
      date: new Date(base + 1000),
    });
    await store(userId, mailboxId, {
      messageId: `<cursor-c-${unique()}@example.com>`,
      date: new Date(base + 2000),
    });

    const first = await emailService.listMessages(userId, mailboxId, { limit: 2, cursor: '' });
    expect(first.nextCursor).toBeTruthy();
    const second = await emailService.listMessages(userId, mailboxId, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    expect(second.data.map((message) => message.id)).not.toEqual(
      expect.arrayContaining(first.data.map((message) => message.id)),
    );
    expect(new Set([...first.data, ...second.data].map((message) => message.id)).size).toBe(
      first.data.length + second.data.length,
    );
  });

  it('returns a message with no thread relations as a thread of one', async () => {
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const solo = await store(userId, mailboxId, { messageId: `<solo-${unique()}@example.com>` });

    const thread = await emailService.getThread(userId, solo);
    expect(thread.map((m) => m.id)).toEqual([solo]);
  });

  it('serves the bodies, which the list view withholds', async () => {
    const userId = await owner();
    const mailboxId = await inbox(userId);
    const id = await store(userId, mailboxId, { messageId: `<body-${unique()}@example.com>` });
    await getDb().update(messages).set({ text: 'the body' }).where(eq(messages.id, id));

    const [threaded] = await emailService.getThread(userId, id);
    expect(threaded.text).toBe('the body');

    const { data } = await emailService.listMessages(userId, mailboxId, { limit: 50 });
    expect(data[0].text).toBeUndefined();
  });
});
