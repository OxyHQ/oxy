/**
 * `sendMessageForUser` threading, on a REAL Postgres. The transport is stubbed.
 *
 * A reply's `In-Reply-To` / `References` must be RFC 5322 Message-IDs. The
 * Inbox client once sent the parent's ROW id; nodemailer wrapped it as
 * `<uuid>` and the reply left its conversation for everyone. That is refused
 * here — in the domain function, because Alia tickets and MCP call it without
 * the REST schema — and a known parent's chain is completed server-side.
 */

const mockSend = jest.fn();

jest.mock('../../services/smtp.outbound', () => ({
  smtpOutbound: { send: (...args: unknown[]) => mockSend(...args) },
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { uploadFileDirect: jest.fn(), linkFile: jest.fn(), getFilesByIds: jest.fn() },
}));
jest.mock('../../services/senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));
jest.mock('../../services/aiLabeling.service', () => ({
  aiLabelingService: { enqueueClassification: jest.fn().mockReturnValue(true) },
}));
jest.mock('../../services/cardExtraction.service', () => ({
  cardExtractionService: { extractAndUpdate: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../services/emailPushDelivery.service', () => ({
  sendInboxEmailPush: jest.fn().mockResolvedValue(undefined),
}));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import { sendMessageSchema } from '../../schemas/email.schemas';
import { emailService } from '../../services/email.service';
import { BadRequestError } from '../../utils/error';
import { sendMessageForUser } from '../email.controller';

const unique = () => randomUUID().replace(/-/g, '');

let user: { id: string; username: string };

beforeAll(async () => {
  await connectPostgres();
  const username = `replier${unique().slice(0, 10)}`;
  const [row] = await getDb().insert(users).values({ username, color: 'teal' }).returning({ id: users.id });
  user = { id: row.id, username };
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ messageId: `<sent-${unique()}@oxy.so>`, queued: false });
});

async function received(overrides: { references?: string[]; inReplyTo?: string } = {}) {
  return emailService.storeIncomingMessage({
    recipientUsername: user.username,
    from: { address: 'support@example.com' },
    to: [{ address: `${user.username}@oxy.so` }],
    subject: 'Case',
    text: 'Hello',
    messageId: `<parent-${unique()}@example.com>`,
    date: new Date(),
    headers: {},
    rawSize: 10,
    ...overrides,
  });
}

const base = { to: [{ address: 'support@example.com' }], subject: 'Re: Case', text: 'Thanks' };

describe('reply threading', () => {
  it('derives References from the parent and marks the parent answered', async () => {
    const parent = await received({ references: ['<root@example.com>', '<mid@example.com>'], inReplyTo: '<mid@example.com>' });

    await sendMessageForUser(user.id, { ...base, inReplyTo: parent.messageId });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: parent.messageId,
        references: ['<root@example.com>', '<mid@example.com>', parent.messageId],
      }),
    );
    const [row] = await getDb().select({ answered: messages.answered }).from(messages).where(eq(messages.id, parent.id));
    expect(row.answered).toBe(true);
  });

  it('falls back to the parent In-Reply-To when it has no References', async () => {
    const parent = await received({ inReplyTo: '<only@example.com>' });
    await sendMessageForUser(user.id, { ...base, inReplyTo: parent.messageId });
    expect(mockSend.mock.calls[0][0].references).toEqual(['<only@example.com>', parent.messageId]);
  });

  it('passes an unknown parent through as given', async () => {
    await sendMessageForUser(user.id, { ...base, inReplyTo: '<elsewhere@example.com>', references: ['<elsewhere@example.com>'] });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: '<elsewhere@example.com>', references: ['<elsewhere@example.com>'] }),
    );
  });

  it.each([
    ['a bare row id', { inReplyTo: '01a0821a-7395-7e43-bdb4-fa5166ea32d1' }],
    ['a bracketed row id', { inReplyTo: '<01a0821a-7395-7e43-bdb4-fa5166ea32d1>' }],
    ['a row id in References', { references: ['01a0821a-7395-7e43-bdb4-fa5166ea32d1'] }],
  ])('refuses %s before anything is sent', async (_label, threading) => {
    await expect(sendMessageForUser(user.id, { ...base, ...threading })).rejects.toBeInstanceOf(BadRequestError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is refused at the REST edge too', () => {
    expect(sendMessageSchema.safeParse({ ...base, inReplyTo: '01a0821a-7395-7e43-bdb4-fa5166ea32d1' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ ...base, inReplyTo: '<a@example.com>' }).success).toBe(true);
  });
});
