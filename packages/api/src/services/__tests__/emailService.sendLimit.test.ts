/**
 * The daily send limit, against a REAL Postgres.
 *
 * It used to count the messages still IN Sent since server-local midnight.
 * So moving sent mail out of Sent, or deleting it, gave the allowance back,
 * and the window jumped at midnight. It now counts the outbox — one row per
 * send, whatever becomes of the Sent copy — over a rolling 24 hours, plus the
 * scheduled sends not yet due. Every case states what the count was before
 * and after the thing that used to reset it.
 */

jest.mock('../senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../assetServiceSingleton', () => ({ assetService: { unlinkFile: jest.fn() } }));

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { emailOutbox } from '../../db/schema/emailOutbox';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import { claimSend } from '../emailOutbox.service';

const unique = () => randomUUID().replace(/-/g, '');
const HOUR = 3_600_000;
/** The free tier's ceiling (`EMAIL_QUOTAS.free.dailySendLimit`). */
const FREE_DAILY_SEND_LIMIT = 100;

const payload = {
  from: { address: 'me@oxy.so' },
  to: [{ address: 'friend@example.com' }],
  subject: 'Hi',
};

async function owner(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `lim${unique().slice(0, 10)}`, color: 'teal' })
    .returning({ id: users.id });
  await emailService.ensureMailboxes(row.id);
  return row.id;
}

async function mailboxIdFor(userId: string, specialUse: string): Promise<string> {
  const mailbox = await emailService.getMailboxBySpecialUse(userId, specialUse);
  if (!mailbox) throw new Error(`no ${specialUse} mailbox`);
  return mailbox.id;
}

/** A send as `acceptOutboundMessage` leaves it: a Sent copy and the claim delivering it. */
async function sent(userId: string): Promise<string> {
  const messageId = `<${unique()}@oxy.so>`;
  const [row] = await getDb()
    .insert(messages)
    .values({
      userId,
      mailboxId: await mailboxIdFor(userId, '\\Sent'),
      messageId,
      fromAddress: 'me@oxy.so',
      subject: 'Hi',
      size: 10,
      seen: true,
      date: new Date(),
    })
    .returning({ id: messages.id });
  await claimSend({ userId, messageId, messageRowId: row.id, payload, owner: 'test' });
  return row.id;
}

/** Deliveries started `hoursAgo`, as the outbox records them. */
async function deliveredAgo(userId: string, hoursAgo: number, count = 1): Promise<void> {
  await getDb()
    .insert(emailOutbox)
    .values(
      Array.from({ length: count }, () => ({
        userId,
        messageId: `<${unique()}@oxy.so>`,
        payload,
        status: 'sent' as const,
        attempts: 1,
        createdAt: new Date(Date.now() - hoursAgo * HOUR),
      })),
    );
}

function schedule(userId: string, idempotencyKey?: string) {
  return emailService.scheduleMessage(userId, {
    from: { address: 'me@oxy.so' },
    to: [{ address: 'friend@example.com' }],
    subject: 'Later',
    text: 'Body',
    idempotencyKey,
    scheduledAt: new Date(Date.now() + 48 * HOUR),
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('getDailySendCount', () => {
  it('counts the sends of the last 24 hours, rolling, not since midnight', async () => {
    const userId = await owner();
    expect(await emailService.getDailySendCount(userId)).toBe(0);

    await deliveredAgo(userId, 1);
    await deliveredAgo(userId, 23.5);
    await deliveredAgo(userId, 25);

    expect(await emailService.getDailySendCount(userId)).toBe(2);
  });

  it('does not give a send back when its Sent copy is moved out of Sent', async () => {
    const userId = await owner();
    const rowId = await sent(userId);
    expect(await emailService.getDailySendCount(userId)).toBe(1);

    await emailService.moveMessage(userId, rowId, await mailboxIdFor(userId, '\\Archive'));
    expect(await emailService.getDailySendCount(userId)).toBe(1);
  });

  it('does not give a send back when its Sent copy is deleted', async () => {
    const userId = await owner();
    const rowId = await sent(userId);

    await emailService.deleteMessage(userId, rowId);
    expect(await emailService.getDailySendCount(userId)).toBe(1);
    await emailService.deleteMessage(userId, rowId, true);
    expect(await emailService.getDailySendCount(userId)).toBe(1);
  });

  it('counts a scheduled send once from when it is scheduled, keyed or not', async () => {
    const userId = await owner();
    // Under a key the send also holds a waiting claim; it is the same send.
    await schedule(userId, `key-${unique()}`);
    await schedule(userId);
    expect(await emailService.getDailySendCount(userId)).toBe(2);
  });

  it('gives a scheduled send back when it is taken off the schedule', async () => {
    const userId = await owner();
    const keyed = await schedule(userId, `key-${unique()}`);
    const unkeyed = await schedule(userId);
    expect(await emailService.getDailySendCount(userId)).toBe(2);

    // Out of Sent, a scheduled message is no longer going out: its claim is
    // cancelled (keyed) or a cancelled one is recorded (unkeyed).
    const drafts = await mailboxIdFor(userId, '\\Drafts');
    await emailService.moveMessage(userId, keyed.id, drafts);
    await emailService.moveMessage(userId, unkeyed.id, drafts);
    expect(await emailService.getDailySendCount(userId)).toBe(0);
  });

  it('counts only the caller`s sends', async () => {
    const userId = await owner();
    const stranger = await owner();
    await deliveredAgo(stranger, 1, 3);
    await schedule(stranger);

    expect(await emailService.getDailySendCount(userId)).toBe(0);
  });
});

describe('enforceSendLimit', () => {
  it('refuses once the tier`s ceiling is reached, with the same message', async () => {
    const userId = await owner();
    await deliveredAgo(userId, 2, FREE_DAILY_SEND_LIMIT - 1);
    await expect(emailService.enforceSendLimit(userId)).resolves.toBeUndefined();

    await sent(userId);
    await expect(emailService.enforceSendLimit(userId)).rejects.toThrow(
      /^Daily send limit reached$/,
    );
  });

  it('lets sends older than the window go', async () => {
    const userId = await owner();
    await deliveredAgo(userId, 30, FREE_DAILY_SEND_LIMIT);
    await expect(emailService.enforceSendLimit(userId)).resolves.toBeUndefined();
  });
});
