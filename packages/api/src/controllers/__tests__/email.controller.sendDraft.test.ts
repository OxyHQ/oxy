/**
 * Sending a draft, on a REAL Postgres. The transport is stubbed.
 *
 * The client sends the draft's row id with the message. The draft must be gone
 * once the message has been sent or scheduled, stay put when the send fails, and
 * a retry of a send that already removed it must still succeed.
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
import { sendMessageForUser } from '../email.controller';

const unique = () => randomUUID().replace(/-/g, '');

async function account(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `drafter${unique().slice(0, 10)}`, color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

async function exists(id: string): Promise<boolean> {
  const rows = await getDb().select({ id: messages.id }).from(messages).where(eq(messages.id, id));
  return rows.length > 0;
}

const base = { to: [{ address: 'friend@example.com' }], subject: 'Hello', text: 'Body' };

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({ messageId: `<sent-${unique()}@oxy.so>`, queued: false });
});

describe('sending a draft', () => {
  it('removes the draft once the message is sent', async () => {
    const userId = await account();
    const draft = await emailService.saveDraft(userId, { ...base });

    await sendMessageForUser(userId, { ...base, draftId: draft.id });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(await exists(draft.id)).toBe(false);
  });

  it('removes the draft when the message is queued for a retry', async () => {
    mockSend.mockResolvedValue({ messageId: `<queued-${unique()}@oxy.so>`, queued: true });
    const userId = await account();
    const draft = await emailService.saveDraft(userId, { ...base });

    await sendMessageForUser(userId, { ...base, draftId: draft.id });

    expect(await exists(draft.id)).toBe(false);
  });

  it('removes the draft once the message is scheduled', async () => {
    const userId = await account();
    const draft = await emailService.saveDraft(userId, { ...base });

    await sendMessageForUser(userId, {
      ...base,
      draftId: draft.id,
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    expect(mockSend).not.toHaveBeenCalled();
    expect(await exists(draft.id)).toBe(false);
  });

  it('keeps the draft when the send fails', async () => {
    mockSend.mockRejectedValue(new Error('relay down'));
    const userId = await account();
    const draft = await emailService.saveDraft(userId, { ...base });

    await expect(sendMessageForUser(userId, { ...base, draftId: draft.id })).rejects.toThrow(
      'relay down',
    );

    expect(await exists(draft.id)).toBe(true);
  });

  it('still sends when the draft is already gone (a retried send)', async () => {
    const userId = await account();
    const draft = await emailService.saveDraft(userId, { ...base });
    await sendMessageForUser(userId, { ...base, draftId: draft.id });

    await expect(sendMessageForUser(userId, { ...base, draftId: draft.id })).resolves.toMatchObject(
      { status: 202 },
    );
  });

  it('never removes another user`s draft', async () => {
    const sender = await account();
    const owner = await account();
    const foreign = await emailService.saveDraft(owner, { ...base });

    await sendMessageForUser(sender, { ...base, draftId: foreign.id });

    expect(await exists(foreign.id)).toBe(true);
  });

  it('carries draftId through the REST schema', () => {
    const parsed = sendMessageSchema.parse({
      ...base,
      draftId: ' 01a0821a-7395-7e43-bdb4-fa5166ea32d1 ',
    });
    expect(parsed.draftId).toBe('01a0821a-7395-7e43-bdb4-fa5166ea32d1');
  });
});
