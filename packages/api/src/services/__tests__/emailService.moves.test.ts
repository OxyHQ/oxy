/**
 * Moving mail, and what a move tells the other devices, against a REAL
 * Postgres.
 *
 * Every move ends in `email:changed` naming the folders it touched and an
 * `email:unread_count` for each, and the counts are what a badge shows. So
 * what is asserted is the exact sequence of emits, with exact non-zero
 * numbers, rather than that "an event was sent". The folder a row LEFT is the
 * one that goes wrong quietly: it is read, not written, and a stale read still
 * produces a plausible event.
 */

const mockGetIO = jest.fn();

jest.mock('../../utils/socket', () => ({
  getIO: (...args: unknown[]) => mockGetIO(...args),
}));
jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../assetServiceSingleton', () => ({ assetService: { unlinkFile: jest.fn() } }));

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';

const unique = () => randomUUID().replace(/-/g, '');

async function owner(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `move${unique().slice(0, 10)}`, nameFirst: 'Test', color: 'teal' })
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

/** Route every socket emit into one list, as `{ event, payload }` pairs in order. */
function captureEmits(): Array<{ event: string; payload: unknown }> {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  mockGetIO.mockReturnValue({
    to: () => ({ emit: (event: string, payload: unknown) => emitted.push({ event, payload }) }),
  });
  return emitted;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetIO.mockReturnValue(null);
});

describe('bulk changes', () => {
  it('announces a 100-row bulk change row by row, but recounts each folder once', async () => {
    const userId = await owner();
    const source = await emailService.createMailbox(userId, `Src-${unique()}`);
    const target = await emailService.createMailbox(userId, `Dst-${unique()}`);
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) ids.push(await store(userId, source.id, { seen: false }));

    let emitted = captureEmits();
    await emailService.bulkUpdateMessageFlags(userId, ids, { seen: true });
    expect(emitted.filter((e) => e.event === 'email:changed')).toHaveLength(100);
    expect(emitted.filter((e) => e.event === 'email:unread_count')).toEqual([
      { event: 'email:unread_count', payload: { mailboxId: source.id, unread: 0 } },
    ]);

    await emailService.bulkUpdateMessageFlags(userId, ids.slice(0, 3), { seen: false });
    emitted = captureEmits();
    await emailService.bulkMoveMessages(userId, ids, target.id);
    const changed = emitted.filter((e) => e.event === 'email:changed');
    expect(changed).toHaveLength(100);
    // Every row names the folder it left as well as the one it landed in.
    expect(changed[0].payload).toEqual({
      id: expect.any(String),
      mailboxIds: [source.id, target.id],
      reason: 'moved',
    });
    expect(emitted.filter((e) => e.event === 'email:unread_count')).toEqual([
      { event: 'email:unread_count', payload: { mailboxId: source.id, unread: 0 } },
      { event: 'email:unread_count', payload: { mailboxId: target.id, unread: 3 } },
    ]);
  });
});

describe('moving one message', () => {
  it('announces a move to Trash from the folder it left, and moves nothing else', async () => {
    const userId = await owner();
    await emailService.ensureMailboxes(userId);
    const inbox = await mailboxIdFor(userId, '\\Inbox');
    const trash = await mailboxIdFor(userId, '\\Trash');
    const messageId = await store(userId, inbox, { seen: false });
    const bystander = await store(userId, inbox, { seen: false });

    const emitted = captureEmits();
    await emailService.deleteMessage(userId, messageId);

    expect(emitted).toEqual([
      {
        event: 'email:changed',
        payload: { id: messageId, mailboxIds: [inbox, trash], reason: 'moved' },
      },
      // The bystander and the welcome message provisioning filed.
      { event: 'email:unread_count', payload: { mailboxId: inbox, unread: 2 } },
      { event: 'email:unread_count', payload: { mailboxId: trash, unread: 1 } },
    ]);
    const [kept] = await getDb()
      .select({ mailboxId: messages.mailboxId })
      .from(messages)
      .where(eq(messages.id, bystander));
    expect(kept.mailboxId).toBe(inbox);
  });

  it('reports a message that is not the caller`s before a missing Trash', async () => {
    const mine = await owner();
    const theirs = await owner();
    const myBox = await emailService.createMailbox(mine, `Mine-${unique()}`);
    const theirBox = await emailService.createMailbox(theirs, `Theirs-${unique()}`);
    const myMessage = await store(mine, myBox.id);
    const theirMessage = await store(theirs, theirBox.id);

    // Neither account was provisioned, so neither has a Trash.
    await expect(emailService.deleteMessage(mine, theirMessage)).rejects.toThrow(
      /^Message not found$/,
    );
    await expect(emailService.deleteMessage(mine, myMessage)).rejects.toThrow(
      /^Trash mailbox not found$/,
    );
  });

  /**
   * The source folder used to be read BEFORE the move's transaction, so a
   * concurrent move in between made the announcement name a folder the row
   * had already left. It is now read under the row lock the move takes.
   */
  it('announces the folder a row really left when another move commits first', async () => {
    const userId = await owner();
    const a = await emailService.createMailbox(userId, `A-${unique()}`);
    const b = await emailService.createMailbox(userId, `B-${unique()}`);
    const c = await emailService.createMailbox(userId, `C-${unique()}`);
    const messageId = await store(userId, a.id);

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const firstMove = getDb().transaction(async (tx) => {
      await tx.update(messages).set({ mailboxId: b.id }).where(eq(messages.id, messageId));
      locked();
      await held;
    });
    await isLocked;

    const emitted = captureEmits();
    const secondMove = emailService.bulkMoveMessages(userId, [messageId], c.id);
    // Let the second move reach the row lock before the first one commits.
    for (let i = 0; i < 100; i++) {
      const [waiting] = await getDb().execute<{ count: number }>(
        sql`select count(*)::int as count from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (waiting.count > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await firstMove;

    expect(await secondMove).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(emitted.find((e) => e.event === 'email:changed')?.payload).toEqual({
      id: messageId,
      mailboxIds: [b.id, c.id],
      reason: 'moved',
    });
  });
});
