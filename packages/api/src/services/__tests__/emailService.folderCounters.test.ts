/**
 * The folder counters as the readers see them, after EVERY write path the
 * email service has, against a REAL Postgres.
 *
 * `listMailboxes`, the quota (`getQuotaUsage`, also what `fileSentMessage` and
 * inbound delivery check) and the realtime `unreadCounts` read the
 * trigger-maintained columns on `mailboxes`. After each write below, the
 * stored columns, what those readers return, and an independent aggregate over
 * `messages` must all agree — with a non-zero floor, so agreement at zero
 * cannot pass for coverage.
 */

const mockEmitEmailChanged = jest.fn();
jest.mock('../inboxRealtime', () => ({
  ...jest.requireActual('../inboxRealtime'),
  emitEmailNew: jest.fn(),
  emitEmailChanged: (...args: unknown[]) => mockEmitEmailChanged(...args),
  emitEmailChangedMany: jest.fn(),
}));
jest.mock('../emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../assetServiceSingleton', () => ({
  assetService: { unlinkFile: jest.fn(), linkFile: jest.fn() },
}));
jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({
  aiLabelingService: { enqueueClassification: jest.fn().mockReturnValue(true) },
}));
jest.mock('../cardExtraction.service', () => ({
  cardExtractionService: { extractAndUpdate: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../smtp.outbound', () => ({
  __esModule: true,
  smtpOutbound: { send: jest.fn() },
  default: { send: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import { storedMail, unreadCounts } from '../folderCounts';

const unique = () => randomUUID().replace(/-/g, '');

interface Counts {
  total: number;
  unseen: number;
  bytes: number;
}

async function account(): Promise<{ id: string; username: string }> {
  const username = `fc${unique().slice(0, 12)}`;
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  await emailService.ensureMailboxes(row.id);
  return { id: row.id, username };
}

async function folder(userId: string, specialUse: string): Promise<string> {
  const box = await emailService.getMailboxBySpecialUse(userId, specialUse);
  if (!box) throw new Error(`no ${specialUse}`);
  return box.id;
}

function deliver(username: string, subject = 'Hello', rawSize = 1000) {
  return emailService.storeIncomingMessage({
    recipientUsername: username,
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: `${username}@oxy.so` }],
    subject,
    text: 'Body',
    messageId: `<fc-${unique()}@example.com>`,
    date: new Date(),
    headers: {},
    rawSize,
  });
}

/** The aggregate the columns replaced, computed independently of every reader. */
async function aggregate(userId: string): Promise<Map<string, Counts>> {
  const rows = await getDb()
    .select({
      mailboxId: messages.mailboxId,
      total: sql<number>`count(*)::int`,
      unseen: sql<number>`(count(*) filter (where not ${messages.seen}))::int`,
      bytes: sql<string>`coalesce(sum(${messages.size}), 0)::bigint`,
    })
    .from(messages)
    .where(eq(messages.userId, userId))
    .groupBy(messages.mailboxId);
  return new Map(
    rows.map((row) => [
      row.mailboxId,
      { total: row.total, unseen: row.unseen, bytes: Number(row.bytes) },
    ]),
  );
}

/**
 * Stored columns == aggregate == every reader, for every folder the user has,
 * and the user holds at least `floor` messages.
 */
async function expectExact(userId: string, floor: number): Promise<void> {
  const expected = await aggregate(userId);
  const stored = await getDb()
    .select({
      id: mailboxes.id,
      total: mailboxes.totalMessages,
      unseen: mailboxes.unseenMessages,
      bytes: mailboxes.sizeBytes,
    })
    .from(mailboxes)
    .where(eq(mailboxes.userId, userId));
  const zero: Counts = { total: 0, unseen: 0, bytes: 0 };

  for (const row of stored) {
    expect({ id: row.id, total: row.total, unseen: row.unseen, bytes: row.bytes }).toEqual({
      id: row.id,
      ...(expected.get(row.id) ?? zero),
    });
  }

  const listed = await emailService.listMailboxes(userId);
  expect(
    listed.map((m) => ({
      id: m.id,
      total: m.totalMessages,
      unseen: m.unseenMessages,
      bytes: m.size,
    })),
  ).toEqual(listed.map((m) => ({ id: m.id, ...(expected.get(m.id) ?? zero) })));

  const unread = await unreadCounts(
    getDb(),
    userId,
    stored.map((row) => row.id),
  );
  for (const row of stored) expect(unread.get(row.id)).toBe((expected.get(row.id) ?? zero).unseen);

  const totals = [...expected.values()].reduce(
    (sum, counts) => ({ total: sum.total + counts.total, bytes: sum.bytes + counts.bytes }),
    { total: 0, bytes: 0 },
  );
  expect(await storedMail(getDb(), userId)).toEqual({ bytes: totals.bytes, count: totals.total });
  expect((await emailService.getQuotaUsage(userId)).used).toBe(totals.bytes);
  expect(totals.total).toBeGreaterThanOrEqual(floor);
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the readers use the stored counters', () => {
  it('reads the columns, not the aggregate, once a folder is counted', async () => {
    const user = await account();
    const inbox = await folder(user.id, '\\Inbox');
    await deliver(user.username);
    // Corrupt the stored counters on purpose: a reader that still aggregated
    // would report the true numbers instead.
    await getDb().execute(sql`
      update mailboxes set total_messages = 41, unseen_messages = 7, size_bytes = 12345
      where id = ${inbox}
    `);

    const listed = (await emailService.listMailboxes(user.id)).find((m) => m.id === inbox);
    expect(listed).toMatchObject({ totalMessages: 41, unseenMessages: 7, size: 12345 });
    expect((await unreadCounts(getDb(), user.id, [inbox])).get(inbox)).toBe(7);
    expect((await emailService.getQuotaUsage(user.id)).used).toBe(12345);
  });

  it('falls back to the aggregate for a folder not counted yet, with the same wire shape', async () => {
    const user = await account();
    const inbox = await folder(user.id, '\\Inbox');
    await deliver(user.username, 'one', 300);
    await deliver(user.username, 'two', 700);
    const counted = await emailService.listMailboxes(user.id);

    // Raw SQL, as a folder that predates 0192 is: the query builder's
    // `$onUpdate` would also move `updated_at`, which no real path does.
    await getDb().execute(sql`
      update mailboxes set total_messages = null, unseen_messages = null, size_bytes = null
      where id = ${inbox}
    `);
    const uncounted = await emailService.listMailboxes(user.id);

    // Byte-identical JSON, key order included, whichever path produced it.
    expect(JSON.stringify(uncounted)).toBe(JSON.stringify(counted));
    const listed = uncounted.find((m) => m.id === inbox);
    // The welcome message provisioning stored, and the two deliveries.
    expect(listed).toMatchObject({ totalMessages: 3, unseenMessages: 3 });
    expect((await unreadCounts(getDb(), user.id, [inbox])).get(inbox)).toBe(3);
    expect((await emailService.getQuotaUsage(user.id)).used).toBe(listed?.size);
    expect(listed?.size).toBeGreaterThan(0);
  });

  it('leaves out a folder the user does not own', async () => {
    const mine = await account();
    const theirs = await account();
    const theirInbox = await folder(theirs.id, '\\Inbox');
    await deliver(theirs.username);
    expect((await unreadCounts(getDb(), mine.id, [theirInbox])).has(theirInbox)).toBe(false);
  });
});

describe('the counters stay exact through every write path', () => {
  it('inbound delivery, flags, bulk flags and labels', async () => {
    const user = await account();
    const first = await deliver(user.username, 'first', 1200);
    const second = await deliver(user.username, 'second', 800);
    const third = await deliver(user.username, 'third', 500);
    await expectExact(user.id, 3);

    await emailService.updateMessageFlags(user.id, first.id, { seen: true });
    await expectExact(user.id, 3);

    await emailService.bulkUpdateMessageFlags(user.id, [second.id, third.id], {
      seen: true,
      starred: true,
    });
    await expectExact(user.id, 3);

    await emailService.bulkUpdateMessageFlags(user.id, [first.id, third.id], { seen: false });
    await expectExact(user.id, 3);

    const label = await emailService.createLabel(
      user.id,
      `Receipts ${unique().slice(0, 6)}`,
      '#123456',
    );
    await emailService.updateMessageLabels(user.id, second.id, [label.name], []);
    await expectExact(user.id, 3);
  });

  it('move, bulk move, soft delete and permanent delete', async () => {
    const user = await account();
    const archive = await folder(user.id, '\\Archive');
    const custom = await emailService.createMailbox(user.id, `Projects-${unique()}`);
    const ids = [];
    for (const size of [100, 200, 300, 400]) ids.push((await deliver(user.username, 's', size)).id);
    await expectExact(user.id, 4);

    await emailService.moveMessage(user.id, ids[0], archive);
    await expectExact(user.id, 4);

    await emailService.bulkMoveMessages(user.id, [ids[1], ids[2]], custom.id);
    await expectExact(user.id, 4);

    await emailService.deleteMessage(user.id, ids[3]);
    await expectExact(user.id, 4);

    await emailService.deleteMessage(user.id, ids[3], true);
    await expectExact(user.id, 3);
  });

  it('filters that file, mark read and delete at delivery', async () => {
    const user = await account();
    const archive = await folder(user.id, '\\Archive');
    await emailService.createFilter(user.id, {
      name: `Rule-${unique()}`,
      enabled: true,
      matchAll: true,
      order: 0,
      conditions: [{ field: 'subject', operator: 'contains', value: 'file me' }],
      actions: [{ type: 'move', value: archive }, { type: 'mark-read' }],
    });
    await emailService.createFilter(user.id, {
      name: `Rule-${unique()}`,
      enabled: true,
      matchAll: true,
      order: 1,
      conditions: [{ field: 'subject', operator: 'contains', value: 'bin me' }],
      actions: [{ type: 'delete' }],
    });

    const filed = await deliver(user.username, 'please file me', 600);
    await deliver(user.username, 'please bin me', 900);
    await deliver(user.username, 'leave me', 300);

    const [where] = await getDb()
      .select({ mailboxId: messages.mailboxId, seen: messages.seen })
      .from(messages)
      .where(eq(messages.id, filed.id));
    expect(where).toEqual({ mailboxId: archive, seen: true });
    await expectExact(user.id, 2);
  });

  it('sent filing, drafts (create, edit, discard) and a scheduled send', async () => {
    const user = await account();
    await emailService.storeSentMessage(user.id, {
      messageId: `<sent-${unique()}@oxy.so>`,
      from: { address: `${user.username}@oxy.so` },
      to: [{ address: 'friend@example.com' }],
      subject: 'Sent',
      text: 'Hello',
      size: 2048,
    });
    await expectExact(user.id, 1);

    const draft = await emailService.saveDraft(user.id, {
      to: [{ address: 'friend@example.com' }],
      subject: 'Draft',
      text: 'short',
    });
    await expectExact(user.id, 2);

    await emailService.saveDraft(user.id, {
      existingDraftId: draft.id,
      expectedRevision: draft.draftRevision,
      to: [{ address: 'friend@example.com' }],
      subject: 'Draft',
      text: 'a much longer body than the first save had, so the size changes',
    });
    await expectExact(user.id, 2);

    await emailService.deleteMessage(user.id, draft.id, true);
    await expectExact(user.id, 1);

    const scheduled = await emailService.scheduleMessage(user.id, {
      from: { address: `${user.username}@oxy.so` },
      to: [{ address: 'friend@example.com' }],
      subject: 'Later',
      text: 'Body',
      scheduledAt: new Date(Date.now() + 48 * 3_600_000),
    });
    await expectExact(user.id, 2);

    await emailService.deleteMessage(user.id, scheduled.id, true);
    await expectExact(user.id, 1);
  });

  it('snooze, unsnooze and a snooze waking up on its own', async () => {
    const user = await account();
    const first = await deliver(user.username, 'a', 100);
    const second = await deliver(user.username, 'b', 200);
    await expectExact(user.id, 2);

    await emailService.snoozeMessage(user.id, first.id, new Date(Date.now() + 3_600_000));
    await emailService.snoozeMessage(user.id, second.id, new Date(Date.now() + 3_600_000));
    await expectExact(user.id, 2);

    await emailService.unsnoozeMessage(user.id, first.id);
    await expectExact(user.id, 2);

    await getDb()
      .update(messages)
      .set({ snoozedUntil: new Date(Date.now() - 1000) })
      .where(eq(messages.id, second.id));
    await emailService.processSnoozedMessages();
    await expectExact(user.id, 2);
  });

  it('an .eml import', async () => {
    const user = await account();
    const eml = Buffer.from(
      [
        'From: Alice <alice@example.com>',
        `To: ${user.username}@oxy.so`,
        'Subject: Imported',
        `Message-ID: <imp-${unique()}@example.com>`,
        'Date: Mon, 05 Jan 2026 10:00:00 +0000',
        '',
        'An imported body.',
        '',
      ].join('\r\n'),
    );
    expect(
      await emailService.importMessages(user.id, [{ buffer: eml, originalname: 'a.eml' }]),
    ).toBe(1);
    await expectExact(user.id, 1);
  });

  it('deleting a folder files its mail in Archive', async () => {
    const user = await account();
    const custom = await emailService.createMailbox(user.id, `Temp-${unique()}`);
    const ids = [
      (await deliver(user.username, 'x', 100)).id,
      (await deliver(user.username, 'y', 50)).id,
    ];
    await emailService.bulkMoveMessages(user.id, ids, custom.id);
    await expectExact(user.id, 2);

    await emailService.deleteMailbox(user.id, custom.id);
    await expectExact(user.id, 2);
  });

  it('deleting an account, by the service and by the users-row cascade, leaves others exact', async () => {
    const bystander = await account();
    await deliver(bystander.username, 'keep', 700);

    const purged = await account();
    await deliver(purged.username, 'gone', 100);
    await emailService.deleteAllUserData(purged.id);
    expect(await getDb().select().from(mailboxes).where(eq(mailboxes.userId, purged.id))).toEqual(
      [],
    );

    const cascaded = await account();
    await deliver(cascaded.username, 'gone', 100);
    await getDb().delete(users).where(eq(users.id, cascaded.id));
    expect(await getDb().select().from(mailboxes).where(eq(mailboxes.userId, cascaded.id))).toEqual(
      [],
    );

    await expectExact(bystander.id, 1);
  });
});
