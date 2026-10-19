/**
 * `emailService.storeIncomingMessage` — the same message arriving twice, against
 * a REAL Postgres.
 *
 * The user's own Sent original is not a received copy: a message they sent to
 * themselves comes back with the Message-ID the Sent row already carries, and
 * must still be stored as the inbound copy `findOwnSentOriginal` links.
 *
 * The asset service is stubbed (it owns S3); the database is not.
 */

const mockUploadFileDirect = jest.fn();
const mockLinkFile = jest.fn();

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
  sendInboxEmailPush: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockLinkFile.mockResolvedValue(undefined);
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
