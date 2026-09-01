/**
 * The message lifecycle, against a REAL Postgres.
 *
 * Drafts, snooze, bulk operations, deletion, settings and the block-sender half
 * of unsubscribe. Each of these lost a block of counter bookkeeping in the port
 * — twenty lines of read-group-write around one `updateMany`, in the unsubscribe
 * case — so what is left has to be checked to actually do the thing the
 * bookkeeping used to surround.
 *
 * The two `matchedCount` / `modifiedCount` numbers are the subtle ones: Mongo's
 * `modifiedCount` skipped documents the write would not change, and the wire
 * reports both separately. A port that returns the same number twice looks
 * right on every test that changes something.
 */

const mockSend = jest.fn();

jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../aiLabeling.service', () => ({ aiLabelingService: { enqueueClassification: jest.fn() } }));
jest.mock('../cardExtraction.service', () => ({ cardExtractionService: { extractAndUpdate: jest.fn() } }));
jest.mock('../smtp.outbound', () => ({
  __esModule: true,
  smtpOutbound: {
    send: (...args: unknown[]) => mockSend(...args),
    sendRaw: (...args: unknown[]) => mockSend(...args),
    sendMdn: (...args: unknown[]) => mockSend(...args),
  },
  default: {},
}));
jest.mock('../emailPushDelivery.service', () => ({ sendInboxEmailPush: jest.fn() }));
jest.mock('../assetServiceSingleton', () => ({ assetService: { unlinkFile: jest.fn() } }));
jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import userCache from '../../utils/userCache';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

/** An account with a username, so the compose paths can derive its address. */
async function owner(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `user${unique().slice(0, 10)}`, nameFirst: 'Test', color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

async function store(
  userId: string,
  mailboxId: string,
  values: Partial<typeof messages.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId,
      messageId: `<${unique()}@example.com>`,
      fromAddress: 'sender@example.com',
      subject: '',
      size: 10,
      date: new Date(),
      ...values,
    })
    .returning({ id: messages.id });
  return row.id;
}

async function mailboxIdFor(userId: string, specialUse: string): Promise<string> {
  const mailbox = await emailService.getMailboxBySpecialUse(userId, specialUse);
  if (!mailbox) throw new Error(`no ${specialUse} mailbox`);
  return mailbox.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ messageId: `<sent-${unique()}@oxy.so>`, queued: false });
});

describe('drafts', () => {
  it('creates a draft in the Drafts folder, seen and flagged as a draft', async () => {
    const userId = await owner();

    const draft = await emailService.saveDraft(userId, {
      to: [{ name: 'Bob', address: 'BOB@Example.com' }],
      subject: 'Later',
      text: 'Body',
    });

    expect(draft.flags).toMatchObject({ draft: true, seen: true });
    expect(draft.mailboxId).toBe(await mailboxIdFor(userId, '\\Drafts'));
    // The call-site normalization applies on the compose path too.
    expect(draft.to).toEqual([{ name: 'Bob', address: 'bob@example.com' }]);
    expect(draft.size).toBe(Buffer.byteLength('Body', 'utf8'));
  });

  it('REPLACES a draft`s recipients on edit rather than accumulating them', async () => {
    // The three headers are a child table now, so "set the arrays" is a delete
    // plus an insert — in one transaction, or an edit can leave the draft
    // addressed to a mixture of two versions.
    const userId = await owner();
    const draft = await emailService.saveDraft(userId, {
      to: [{ address: 'first@example.com' }, { address: 'second@example.com' }],
      cc: [{ address: 'cc@example.com' }],
      subject: 'v1',
    });

    const edited = await emailService.saveDraft(userId, {
      existingDraftId: draft.id,
      to: [{ address: 'third@example.com' }],
      subject: 'v2',
    });

    expect(edited.id).toBe(draft.id);
    expect(edited.subject).toBe('v2');
    expect(edited.to).toEqual([{ name: '', address: 'third@example.com' }]);
    expect(edited.cc).toEqual([]);
  });

  it('creates a NEW draft when the id given is not the caller`s draft', async () => {
    const mine = await owner();
    const theirs = await owner();
    const foreign = await emailService.saveDraft(theirs, { subject: 'theirs' });

    const created = await emailService.saveDraft(mine, {
      existingDraftId: foreign.id,
      subject: 'mine',
    });

    expect(created.id).not.toBe(foreign.id);
    expect(created.userId).toBe(mine);
  });
});

describe('snooze', () => {
  it('moves the message to Snoozed and remembers where it came from', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const snoozeBox = await mailboxIdFor(userId, '\\Snoozed');
    const messageId = await store(userId, inbox, { seen: true });
    const until = new Date(Date.now() + 3_600_000);

    const snoozed = await emailService.snoozeMessage(userId, messageId, until);

    expect(snoozed.mailboxId).toBe(snoozeBox);
    expect(snoozed.snoozedFromMailbox).toBe(inbox);
    expect(snoozed.snoozedUntil?.getTime()).toBe(until.getTime());
  });

  it('re-snoozing only moves the deadline, keeping the original origin', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const messageId = await store(userId, inbox);

    await emailService.snoozeMessage(userId, messageId, new Date(Date.now() + 3_600_000));
    const later = new Date(Date.now() + 7_200_000);
    const again = await emailService.snoozeMessage(userId, messageId, later);

    expect(again.snoozedFromMailbox).toBe(inbox);
    expect(again.snoozedUntil?.getTime()).toBe(later.getTime());
  });

  it('unsnoozes back to the origin, marked unread so it stands out', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const messageId = await store(userId, inbox, { seen: true });
    await emailService.snoozeMessage(userId, messageId, new Date(Date.now() + 3_600_000));

    const restored = await emailService.unsnoozeMessage(userId, messageId);

    expect(restored.mailboxId).toBe(inbox);
    expect(restored.snoozedUntil).toBeNull();
    expect(restored.snoozedFromMailbox).toBeNull();
    expect(restored.flags.seen).toBe(false);
  });

  it('refuses to unsnooze a message that is not snoozed', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const messageId = await store(userId, await mailboxIdFor(userId, '\\Inbox'));

    await expect(emailService.unsnoozeMessage(userId, messageId)).rejects.toThrow(/not snoozed/);
  });

  it('the cron restores every message whose deadline has passed, and no others', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const due = await store(userId, inbox);
    const notDue = await store(userId, inbox);
    await emailService.snoozeMessage(userId, due, new Date(Date.now() + 3_600_000));
    await emailService.snoozeMessage(userId, notDue, new Date(Date.now() + 7_200_000));
    // Backdate one deadline into the past.
    await getDb()
      .update(messages)
      .set({ snoozedUntil: new Date(Date.now() - 1_000) })
      .where(eq(messages.id, due));

    const processed = await emailService.processSnoozedMessages();

    expect(processed).toBeGreaterThanOrEqual(1);
    const [restored] = await getDb()
      .select({ mailboxId: messages.mailboxId, snoozedUntil: messages.snoozedUntil })
      .from(messages)
      .where(eq(messages.id, due));
    expect(restored.mailboxId).toBe(inbox);
    expect(restored.snoozedUntil).toBeNull();

    const [untouched] = await getDb()
      .select({ snoozedUntil: messages.snoozedUntil })
      .from(messages)
      .where(eq(messages.id, notDue));
    expect(untouched.snoozedUntil).not.toBeNull();
  });
});

describe('bulk operations — matched is not modified', () => {
  it('counts the owned messages as matched and only the changed ones as modified', async () => {
    const userId = await owner();
    const mailbox = await emailService.createMailbox(userId, `Bulk-${unique()}`);
    const alreadySeen = await store(userId, mailbox.id, { seen: true });
    const unseen = await store(userId, mailbox.id, { seen: false });

    const result = await emailService.bulkUpdateMessageFlags(userId, [alreadySeen, unseen], {
      seen: true,
    });

    expect(result).toEqual({ matchedCount: 2, modifiedCount: 1 });
  });

  it('reports zero modified when every message is already in the requested state', async () => {
    const userId = await owner();
    const mailbox = await emailService.createMailbox(userId, `Bulk-${unique()}`);
    const ids = [
      await store(userId, mailbox.id, { starred: true }),
      await store(userId, mailbox.id, { starred: true }),
    ];

    expect(await emailService.bulkUpdateMessageFlags(userId, ids, { starred: true })).toEqual({
      matchedCount: 2,
      modifiedCount: 0,
    });
  });

  it('counts only the caller`s messages as matched', async () => {
    const mine = await owner();
    const theirs = await owner();
    const myBox = await emailService.createMailbox(mine, `Mine-${unique()}`);
    const theirBox = await emailService.createMailbox(theirs, `Theirs-${unique()}`);
    const myMessage = await store(mine, myBox.id);
    const theirMessage = await store(theirs, theirBox.id);

    const result = await emailService.bulkUpdateMessageFlags(mine, [myMessage, theirMessage], {
      starred: true,
    });

    expect(result).toEqual({ matchedCount: 1, modifiedCount: 1 });
    const [untouched] = await getDb()
      .select({ starred: messages.starred })
      .from(messages)
      .where(eq(messages.id, theirMessage));
    expect(untouched.starred).toBe(false);
  });

  it('moves in bulk, and does not count a message already in the target', async () => {
    const userId = await owner();
    const source = await emailService.createMailbox(userId, `Src-${unique()}`);
    const target = await emailService.createMailbox(userId, `Dst-${unique()}`);
    const toMove = await store(userId, source.id);
    const alreadyThere = await store(userId, target.id);

    const result = await emailService.bulkMoveMessages(userId, [toMove, alreadyThere], target.id);

    expect(result).toEqual({ matchedCount: 2, modifiedCount: 1 });
    const listed = await emailService.listMailboxes(userId);
    expect(listed.find((m) => m.id === target.id)?.totalMessages).toBe(2);
  });

  it('refuses a move to a folder the caller does not own', async () => {
    const mine = await owner();
    const theirs = await owner();
    const theirBox = await emailService.createMailbox(theirs, `Theirs-${unique()}`);

    await expect(emailService.bulkMoveMessages(mine, [], theirBox.id)).rejects.toThrow(
      /Target mailbox not found/,
    );
  });
});

describe('deletion', () => {
  it('moves to Trash by default and removes the row when permanent', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const trash = await mailboxIdFor(userId, '\\Trash');
    const messageId = await store(userId, inbox);

    await emailService.deleteMessage(userId, messageId);
    const [moved] = await getDb()
      .select({ mailboxId: messages.mailboxId })
      .from(messages)
      .where(eq(messages.id, messageId));
    expect(moved.mailboxId).toBe(trash);

    await emailService.deleteMessage(userId, messageId, true);
    expect(
      await getDb().select({ id: messages.id }).from(messages).where(eq(messages.id, messageId)),
    ).toEqual([]);
  });

  it('refuses to delete another account`s message', async () => {
    const mine = await owner();
    const theirs = await owner();
    const theirBox = await emailService.createMailbox(theirs, `Theirs-${unique()}`);
    const messageId = await store(theirs, theirBox.id);

    await expect(emailService.deleteMessage(mine, messageId, true)).rejects.toThrow(
      /Message not found/,
    );
  });

  it('removes every mailbox and message when the account`s mail is purged', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    await store(userId, await mailboxIdFor(userId, '\\Inbox'));

    await emailService.deleteAllUserData(userId);

    expect(
      await getDb().select({ id: messages.id }).from(messages).where(eq(messages.userId, userId)),
    ).toEqual([]);
    expect(
      await getDb().select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.userId, userId)),
    ).toEqual([]);
  });
});

describe('unsubscribe — blocking a sender', () => {
  it('moves every message from that sender to Junk, and nobody else`s', async () => {
    // What is left after the counter bookkeeping went: one statement.
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const junk = await mailboxIdFor(userId, '\\Junk');
    const spammer = `spam-${unique().slice(0, 8)}@example.com`;

    const first = await store(userId, inbox, { fromAddress: spammer });
    const second = await store(userId, inbox, { fromAddress: spammer });
    const innocent = await store(userId, inbox, { fromAddress: 'friend@example.com' });

    const result = await emailService.unsubscribe(userId, spammer.toUpperCase(), 'block');

    expect(result).toEqual({ success: true, method: 'blocked' });
    for (const id of [first, second]) {
      const [row] = await getDb()
        .select({ mailboxId: messages.mailboxId })
        .from(messages)
        .where(eq(messages.id, id));
      expect(row.mailboxId).toBe(junk);
    }
    const [untouched] = await getDb()
      .select({ mailboxId: messages.mailboxId })
      .from(messages)
      .where(eq(messages.id, innocent));
    expect(untouched.mailboxId).toBe(inbox);
  });

  it('falls back to blocking when the sender published no List-Unsubscribe', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const sender = `nolist-${unique().slice(0, 8)}@example.com`;
    await store(userId, inbox, { fromAddress: sender });

    await expect(emailService.unsubscribe(userId, sender)).resolves.toEqual({
      success: true,
      method: 'blocked',
    });
  });
});

describe('email settings', () => {
  it('round-trips the flattened auto-reply as the nested object the wire carries', async () => {
    const userId = await owner();
    const start = new Date(Date.UTC(2026, 0, 1));
    const end = new Date(Date.UTC(2026, 0, 8));

    await emailService.updateEmailSettings(userId, {
      signature: '-- Test',
      autoReply: { enabled: true, subject: 'Away', body: 'Back soon', startDate: start, endDate: end },
      autoForwardTo: 'other@example.com',
      autoForwardKeepCopy: false,
    });

    const settings = await emailService.getEmailSettings(userId);
    expect(settings.signature).toBe('-- Test');
    expect(settings.autoReply).toEqual({
      enabled: true,
      subject: 'Away',
      body: 'Back soon',
      startDate: start,
      endDate: end,
    });
    expect(settings.autoForwardTo).toBe('other@example.com');
    expect(settings.autoForwardKeepCopy).toBe(false);
    expect(settings.address).toMatch(/@/);
    expect(userCache.invalidate).toHaveBeenCalledWith(userId);
  });

  it('clears every part of the auto-reply when a smaller one replaces it', async () => {
    // Replacing a Mongo sub-document replaced ALL of it. Flattened to five
    // columns, a partial write would leave the old subject behind.
    const userId = await owner();
    await emailService.updateEmailSettings(userId, {
      autoReply: { enabled: true, subject: 'Away', body: 'Back soon' },
    });

    await emailService.updateEmailSettings(userId, { autoReply: { enabled: false } });

    expect((await emailService.getEmailSettings(userId)).autoReply).toEqual({ enabled: false });
  });

  it('defaults to an empty signature and no forwarding for a fresh account', async () => {
    const userId = await owner();

    const settings = await emailService.getEmailSettings(userId);
    expect(settings).toMatchObject({
      signature: '',
      autoForwardTo: '',
      autoForwardKeepCopy: true,
      autoReply: { enabled: false },
    });
  });
});

describe('read receipts', () => {
  it('sends the MDN once and refuses a second time', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const messageId = await store(userId, inbox, {
      readReceiptRequested: true,
      headers: { 'disposition-notification-to': 'Alice <alice@example.com>' },
    });

    await emailService.sendReadReceipt(userId, messageId);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'alice@example.com' }),
    );
    await expect(emailService.sendReadReceipt(userId, messageId)).rejects.toThrow(
      /already been sent/,
    );
  });

  it('refuses a message that never asked for one', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const messageId = await store(userId, await mailboxIdFor(userId, '\\Inbox'));

    await expect(emailService.sendReadReceipt(userId, messageId)).rejects.toThrow(
      /did not request a read receipt/,
    );
  });
});

describe('send limits', () => {
  it('counts today`s Sent mail and refuses once the tier`s ceiling is reached', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const sent = await mailboxIdFor(userId, '\\Sent');

    expect(await emailService.getDailySendCount(userId)).toBe(0);
    await store(userId, sent, { receivedAt: new Date() });
    await store(userId, sent, { receivedAt: new Date() });
    expect(await emailService.getDailySendCount(userId)).toBe(2);

    // Yesterday's mail is not today's quota.
    await store(userId, sent, { receivedAt: new Date(Date.now() - 48 * 3_600_000) });
    expect(await emailService.getDailySendCount(userId)).toBe(2);

    await expect(emailService.enforceSendLimit(userId)).resolves.toBeUndefined();
  });
});

describe('export', () => {
  it('reconstructs an RFC 5322 message from the row and its recipients', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);

    const draft = await emailService.saveDraft(userId, {
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      cc: [{ address: 'carol@example.com' }],
      subject: 'Quarterly',
      text: 'Plain body',
      html: '<p>Rich body</p>',
    });

    const eml = await emailService.exportMessage(userId, draft.id);

    expect(eml).toContain('Subject: Quarterly');
    expect(eml).toContain('To: "Bob" <bob@example.com>');
    expect(eml).toContain('Cc: carol@example.com');
    expect(eml).toContain('Content-Type: multipart/alternative');
    expect(eml).toContain('Plain body');
    expect(eml).toContain('<p>Rich body</p>');
    expect(eml.split('\r\n')[0]).toMatch(/^From: /);
  });

  it('refuses to export another account`s message', async () => {
    const mine = await owner();
    const theirs = await owner();
    const theirBox = await emailService.createMailbox(theirs, `Theirs-${unique()}`);
    const messageId = await store(theirs, theirBox.id);

    await expect(emailService.exportMessage(mine, messageId)).rejects.toThrow(/not found/);
  });
});
