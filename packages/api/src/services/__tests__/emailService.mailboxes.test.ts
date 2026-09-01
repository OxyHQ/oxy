/**
 * The three mailbox counters, and the quota, against a REAL Postgres.
 *
 * `total_messages`, `unseen_messages` and `size` were columns on `mailboxes`
 * kept current by eighteen hand-written `$inc` sites. They are now derived from
 * `messages`, which means the DTO is identical and the drift is gone — but it
 * also means every one of these numbers now comes from a JOIN that can be
 * wrong in a way that produces ZERO rather than an error.
 *
 * So every assertion here is an EXACT NON-ZERO number against rows written in
 * the same test. `toBeGreaterThanOrEqual(0)` or "a mailbox came back" would
 * pass against a correlated predicate that matches nothing, which is the
 * failure mode `db/schema/CONVENTIONS.md` records as costing data rather than
 * raising.
 */

jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({ aiLabelingService: { enqueueClassification: jest.fn() } }));
jest.mock('../cardExtraction.service', () => ({ cardExtractionService: { extractAndUpdate: jest.fn() } }));
jest.mock('../smtp.outbound', () => ({ __esModule: true, smtpOutbound: {}, default: {} }));
jest.mock('../emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../assetServiceSingleton', () => ({ assetService: { unlinkFile: jest.fn() } }));

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

async function store(
  userId: string,
  mailboxId: string,
  values: { size: number; seen?: boolean },
): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<${unique()}@example.com>`,
      fromAddress: 'sender@example.com',
      subject: '',
      size: values.size,
      seen: values.seen ?? false,
      date: new Date(),
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

describe('listMailboxes — the counters that replaced the dropped columns', () => {
  it('reports exact totals, unseen counts and byte sizes per folder', async () => {
    // Folders created directly rather than provisioned: provisioning also
    // writes a welcome email into the Inbox, and an assertion that has to
    // account for someone else's row is no longer an exact one.
    const userId = await owner();
    const first = await emailService.createMailbox(userId, `First-${unique()}`);
    const second = await emailService.createMailbox(userId, `Second-${unique()}`);

    // Three in the first folder — two unread, 100 + 250 + 400 bytes.
    await store(userId, first.id, { size: 100, seen: false });
    await store(userId, first.id, { size: 250, seen: false });
    await store(userId, first.id, { size: 400, seen: true });
    // One in the second, read.
    await store(userId, second.id, { size: 700, seen: true });

    const after = await emailService.listMailboxes(userId);
    const firstAfter = after.find((m) => m.id === first.id);
    const secondAfter = after.find((m) => m.id === second.id);

    // Exact, and non-zero on every axis: a correlated join that matched
    // nothing would report 0/0/0 here and nothing else would notice.
    expect(firstAfter).toMatchObject({
      totalMessages: 3,
      unseenMessages: 2,
      size: 750,
    });
    expect(secondAfter).toMatchObject({
      totalMessages: 1,
      unseenMessages: 0,
      size: 700,
    });
  });

  it('reports zero for an empty folder rather than dropping it from the list', async () => {
    // The join is a LEFT join precisely so an empty folder still appears. An
    // inner join would silently hide every folder the user has not used yet.
    const userId = await owner();
    await emailService.provisionMailboxes(userId);

    const listed = await emailService.listMailboxes(userId);
    const drafts = listed.find((m) => m.specialUse === '\\Drafts');

    expect(drafts).toBeDefined();
    expect(drafts?.totalMessages).toBe(0);
    expect(drafts?.size).toBe(0);
  });

  it('counts only the owner`s mail', async () => {
    const mine = await owner();
    const theirs = await owner();
    const [myBox] = await getDb()
      .insert(mailboxes)
      .values({ userId: mine, name: 'Shared', path: `Shared-${unique()}` })
      .returning({ id: mailboxes.id });
    const [theirBox] = await getDb()
      .insert(mailboxes)
      .values({ userId: theirs, name: 'Shared', path: `Shared-${unique()}` })
      .returning({ id: mailboxes.id });

    await store(mine, myBox.id, { size: 111 });
    await store(theirs, theirBox.id, { size: 999 });

    const mineListed = await emailService.listMailboxes(mine);
    expect(mineListed.find((m) => m.id === myBox.id)).toMatchObject({
      totalMessages: 1,
      size: 111,
    });
    expect(mineListed.map((m) => m.id)).not.toContain(theirBox.id);
  });

  it('follows a flag change with no counter write anywhere', async () => {
    // The eighteen `$inc` sites are gone; flipping `seen` IS the update.
    const userId = await owner();
    const folder = await emailService.createMailbox(userId, `Flags-${unique()}`);

    const messageId = await store(userId, folder.id, { size: 50, seen: false });
    expect((await emailService.listMailboxes(userId)).find((m) => m.id === folder.id)?.unseenMessages).toBe(1);

    await emailService.updateMessageFlags(userId, messageId, { seen: true });
    expect((await emailService.listMailboxes(userId)).find((m) => m.id === folder.id)?.unseenMessages).toBe(0);
  });

  it('follows a move between folders on both sides at once', async () => {
    const userId = await owner();
    const source = await emailService.createMailbox(userId, `Source-${unique()}`);
    const target = await emailService.createMailbox(userId, `Target-${unique()}`);

    const messageId = await store(userId, source.id, { size: 321, seen: false });
    await emailService.moveMessage(userId, messageId, target.id);

    const after = await emailService.listMailboxes(userId);
    expect(after.find((m) => m.id === source.id)).toMatchObject({
      totalMessages: 0,
      unseenMessages: 0,
      size: 0,
    });
    expect(after.find((m) => m.id === target.id)).toMatchObject({
      totalMessages: 1,
      unseenMessages: 1,
      size: 321,
    });
  });

  it('creates a folder reporting zeroes, in the same shape as a populated one', async () => {
    const userId = await owner();
    const created = await emailService.createMailbox(userId, `Receipts-${unique()}`);

    expect(created.totalMessages).toBe(0);
    expect(created.unseenMessages).toBe(0);
    expect(created.size).toBe(0);
    expect(created._id).toBe(created.id);
    expect(Object.keys(created).sort()).toEqual(
      Object.keys((await emailService.listMailboxes(userId))[0]).sort(),
    );
  });

  it('refuses a duplicate path', async () => {
    const userId = await owner();
    const path = `Projects-${unique()}`;
    await emailService.createMailbox(userId, path);

    await expect(emailService.createMailbox(userId, path)).rejects.toThrow(/already exists/);
  });

  it('refuses to delete a system folder', async () => {
    const userId = await owner();
    await emailService.provisionMailboxes(userId);
    const inbox = (await emailService.listMailboxes(userId)).find((m) => m.specialUse === '\\Inbox');
    if (!inbox) throw new Error('no inbox');

    await expect(emailService.deleteMailbox(userId, inbox.id)).rejects.toThrow(/system mailbox/);
  });

  it('backfills a default folder a user is missing, without re-provisioning', async () => {
    // `provisionMailboxes` short-circuits the moment the user owns ANY mailbox
    // — the same guard Mongo had — so a user who created a folder before a new
    // default was introduced would never get it. `ensureMailboxes` is the path
    // that syncs the gap, and it is the one every route calls.
    const userId = await owner();
    await emailService.createMailbox(userId, `Custom-${unique()}`);
    expect(await emailService.provisionMailboxes(userId)).toHaveLength(1);

    await emailService.ensureMailboxes(userId);
    const listed = await emailService.listMailboxes(userId);

    expect(listed.map((m) => m.specialUse)).toEqual(
      expect.arrayContaining(['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive', '\\Snoozed']),
    );
  });

  it('takes a folder`s messages with it when the folder is deleted', async () => {
    const userId = await owner();
    const created = await emailService.createMailbox(userId, `Temp-${unique()}`);
    const messageId = await store(userId, created.id, { size: 10 });

    await emailService.deleteMailbox(userId, created.id);

    const remaining = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(remaining).toEqual([]);
  });
});

describe('getQuotaUsage — summed from the messages, not from a counter', () => {
  it('sums every folder`s bytes for the owner and nobody else', async () => {
    const userId = await owner();
    const other = await owner();
    await emailService.provisionMailboxes(userId);
    await emailService.provisionMailboxes(other);

    const listed = await emailService.listMailboxes(userId);
    const inbox = listed.find((m) => m.specialUse === '\\Inbox');
    const archive = listed.find((m) => m.specialUse === '\\Archive');
    if (!inbox || !archive) throw new Error('no folders');

    const before = await emailService.getQuotaUsage(userId);
    await store(userId, inbox.id, { size: 1_000 });
    await store(userId, archive.id, { size: 2_500 });

    const otherInbox = (await emailService.listMailboxes(other)).find(
      (m) => m.specialUse === '\\Inbox',
    );
    if (!otherInbox) throw new Error('no inbox');
    await store(other, otherInbox.id, { size: 9_999_999 });

    const after = await emailService.getQuotaUsage(userId);

    expect(after.used - before.used).toBe(3_500);
    expect(after.limit).toBeGreaterThan(0);
    expect(after.percentage).toBeCloseTo((after.used / after.limit) * 100, 6);
  });

  it('refuses a write that would cross the allowance', async () => {
    const userId = await owner();
    const { limit } = await emailService.getQuotaUsage(userId);
    await expect(emailService.enforceQuota(userId, limit + 1)).rejects.toThrow(/quota exceeded/);
    await expect(emailService.enforceQuota(userId, 1)).resolves.toBeUndefined();
  });
});
