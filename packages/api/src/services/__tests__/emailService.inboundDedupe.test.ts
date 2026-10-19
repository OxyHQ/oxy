/**
 * `emailService.storeIncomingMessage` — the same message arriving twice, against
 * a REAL Postgres.
 *
 * A sender retries after a timeout, and the inbound webhook now answers a
 * transient failure with a 503 that makes Cloudflare redeliver to every
 * recipient. A message the user already has, by Message-ID, is answered with
 * the stored copy: one row, one upload, one push.
 *
 * The user's own Sent original is not a received copy: a message they sent to
 * themselves comes back with the Message-ID the Sent row already carries, and
 * must still be stored as the inbound copy `findOwnSentOriginal` links.
 *
 * The asset service is stubbed (it owns S3); the database is not.
 */

const mockUploadFileDirect = jest.fn();
const mockLinkFile = jest.fn();
const mockSendInboxEmailPush = jest.fn();

jest.mock('../assetServiceSingleton', () => ({
  assetService: {
    uploadFileDirect: (...args: unknown[]) => mockUploadFileDirect(...args),
    linkFile: (...args: unknown[]) => mockLinkFile(...args),
  },
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
jest.mock('../emailPushDelivery.service', () => ({
  sendInboxEmailPush: (...args: unknown[]) => mockSendInboxEmailPush(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import { fallbackMessageId } from '../inboundMime';

const unique = () => randomUUID().replace(/-/g, '');

async function recipient(): Promise<{ id: string; username: string; address: string }> {
  const username = `dup${unique().slice(0, 10)}`;
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  return { id: row.id, username, address: `${username}@oxy.so` };
}

function incoming(username: string, messageId: string, overrides: Record<string, unknown> = {}) {
  return {
    recipientUsername: username,
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: `${username}@oxy.so` }],
    subject: 'Hello',
    text: 'Body',
    messageId,
    date: new Date('2024-01-01T00:00:00.000Z'),
    headers: {},
    rawSize: 1000,
    ...overrides,
  };
}

async function rowsWith(userId: string, messageId: string) {
  return getDb()
    .select({ id: messages.id, mailboxId: messages.mailboxId, sentCopyOf: messages.sentCopyOf })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.messageId, messageId)));
}

/** A real `files` row, so the attachment foreign key has something to point at. */
async function storedFile(ownerUserId: string) {
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: unique(),
      size: 2048,
      mime: 'application/pdf',
      ext: 'pdf',
      storageKey: `assets/${unique()}`,
      originalName: 'report.pdf',
      ownerUserId,
    })
    .returning({ id: files.id });
  return { id: row.id, originalName: 'report.pdf', mime: 'application/pdf', size: 2048 };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLinkFile.mockResolvedValue(undefined);
  mockSendInboxEmailPush.mockResolvedValue(undefined);
});

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('storeIncomingMessage — a message the user sent themselves', () => {
  it('stores the inbound copy beside the Sent original, linked to it', async () => {
    const user = await recipient();
    await emailService.ensureMailboxes(user.id);
    const sent = await emailService.getMailboxBySpecialUse(user.id, '\\Sent');
    if (!sent) throw new Error('no Sent mailbox');
    const messageId = `<self-${unique()}@oxy.so>`;
    const [original] = await getDb()
      .insert(messages)
      .values({
        userId: user.id,
        mailboxId: sent.id,
        messageId,
        fromAddress: user.address,
        subject: 'Note to self',
        size: 10,
        seen: true,
        date: new Date(),
      })
      .returning({ id: messages.id });

    const copy = await emailService.storeIncomingMessage(
      incoming(user.username, messageId, {
        from: { name: '', address: user.address },
        headers: { 'x-oxy-sent-id': messageId },
      }),
    );

    expect(copy.id).not.toBe(original.id);
    const rows = await rowsWith(user.id, messageId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === copy.id)?.sentCopyOf).toBe(original.id);
  });
});

describe('storeIncomingMessage — a message delivered twice', () => {
  it('keeps one row, uploads once and announces once, answering the retry with the stored copy', async () => {
    const user = await recipient();
    mockUploadFileDirect.mockResolvedValue(await storedFile(user.id));
    const messageId = `<retry-${unique()}@example.com>`;
    const params = incoming(user.username, messageId, {
      attachments: [
        { filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') },
      ],
    });

    const first = await emailService.storeIncomingMessage(params);
    const second = await emailService.storeIncomingMessage(params);

    expect(second).toEqual(first);
    expect(await rowsWith(user.id, messageId)).toHaveLength(1);
    expect(mockUploadFileDirect).toHaveBeenCalledTimes(1);
    expect(mockLinkFile).toHaveBeenCalledTimes(1);
    expect(mockSendInboxEmailPush).toHaveBeenCalledTimes(1);
  });

  it('recognises a copy a filter filed in a folder of the user`s own', async () => {
    // A custom folder has no special_use: a `NOT IN` on its NULL alone would
    // not match, and the retry would be stored again.
    const user = await recipient();
    const messageId = `<filed-${unique()}@example.com>`;
    const first = await emailService.storeIncomingMessage(incoming(user.username, messageId));
    const folder = await emailService.createMailbox(user.id, `Receipts-${unique()}`);
    await emailService.moveMessage(user.id, first.id, folder.id);

    const second = await emailService.storeIncomingMessage(incoming(user.username, messageId));

    expect(second.id).toBe(first.id);
    expect(second.mailboxId).toBe(folder.id);
    expect(await rowsWith(user.id, messageId)).toHaveLength(1);
  });

  it('stores the same Message-ID for another recipient', async () => {
    const alice = await recipient();
    const bob = await recipient();
    const messageId = `<both-${unique()}@example.com>`;

    const forAlice = await emailService.storeIncomingMessage(incoming(alice.username, messageId));
    const forBob = await emailService.storeIncomingMessage(incoming(bob.username, messageId));

    expect(forBob.id).not.toBe(forAlice.id);
    expect(await rowsWith(alice.id, messageId)).toHaveLength(1);
    expect(await rowsWith(bob.id, messageId)).toHaveLength(1);
  });

  it('recognises a message that arrived without a Message-ID by its bytes', async () => {
    const user = await recipient();
    const raw = Buffer.from(`From: a@example.com\r\nSubject: no id ${unique()}\r\n\r\nHi\r\n`);

    const first = await emailService.storeIncomingMessage(
      incoming(user.username, fallbackMessageId(raw)),
    );
    const second = await emailService.storeIncomingMessage(
      incoming(user.username, fallbackMessageId(Buffer.from(raw))),
    );

    expect(second.id).toBe(first.id);
    expect(await rowsWith(user.id, fallbackMessageId(raw))).toHaveLength(1);
  });

  it('stores a retried self-send copy once, still beside its Sent original', async () => {
    const user = await recipient();
    await emailService.ensureMailboxes(user.id);
    const sent = await emailService.getMailboxBySpecialUse(user.id, '\\Sent');
    if (!sent) throw new Error('no Sent mailbox');
    const messageId = `<self-retry-${unique()}@oxy.so>`;
    await getDb().insert(messages).values({
      userId: user.id,
      mailboxId: sent.id,
      messageId,
      fromAddress: user.address,
      subject: 'Note to self',
      size: 10,
      seen: true,
      date: new Date(),
    });
    const copy = incoming(user.username, messageId, {
      from: { name: '', address: user.address },
      headers: { 'x-oxy-sent-id': messageId },
    });

    const first = await emailService.storeIncomingMessage(copy);
    const second = await emailService.storeIncomingMessage(copy);

    expect(second.id).toBe(first.id);
    expect(await rowsWith(user.id, messageId)).toHaveLength(2);
  });
});
