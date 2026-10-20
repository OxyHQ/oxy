/**
 * `sendMessageForUser`'s checks, on a REAL Postgres. The transport is stubbed.
 *
 * The threading, send-limit, sender, suppression and attachment checks used to
 * run one after another; they are independent reads, so they now run
 * together. What must not change is WHICH refusal a request failing several of
 * them gets: always the one whose check came first. Each case below fails two
 * checks at once and asserts the earlier one wins.
 *
 * The send limit and the Sent filing read the tier and the Sent folder ONCE
 * (`emailService.sendPreflight`), and the filing is handed that read.
 */

const mockAccept = jest.fn();
const mockGetFilesByIds = jest.fn();

jest.mock('../../services/smtp.outbound', () => ({ smtpOutbound: {} }));
jest.mock('../../services/emailDelivery.service', () => ({
  acceptOutboundMessage: (...args: unknown[]) => mockAccept(...args),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFilesByIds: (...args: unknown[]) => mockGetFilesByIds(...args),
    linkFile: jest.fn(),
  },
}));
jest.mock('../../services/senderAvatar.service', () => ({
  getAvatarPathsBatch: jest.fn().mockResolvedValue(new Map()),
}));

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { emailOutbox } from '../../db/schema/emailOutbox';
import { users } from '../../db/schema/users';
import { emailService } from '../../services/email.service';
import { recordSuppression } from '../../services/emailSuppression.service';
import { sendMessageForUser } from '../email.controller';

const unique = () => randomUUID().replace(/-/g, '');

/** The free tier's ceiling (`EMAIL_QUOTAS.free.dailySendLimit`). */
const FREE_DAILY_SEND_LIMIT = 100;

async function account(username: string | null = `pre${unique().slice(0, 10)}`): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  return row.id;
}

/** A provisioned account that has already sent its whole day's allowance. */
async function exhausted(): Promise<string> {
  const userId = await account();
  await getDb()
    .insert(emailOutbox)
    .values(
      Array.from({ length: FREE_DAILY_SEND_LIMIT }, () => ({
        userId,
        messageId: `<${unique()}@oxy.so>`,
        payload: {
          from: { address: 'me@oxy.so' },
          to: [{ address: 'friend@example.com' }],
          subject: '',
          text: '',
        },
      })),
    );
  return userId;
}

async function suppress(address: string): Promise<void> {
  await recordSuppression({ address, reason: 'bounce_permanent', source: 'manual' });
}

const base = { to: [{ address: 'friend@example.com' }], subject: 'Hi', text: 'Hello' };

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFilesByIds.mockResolvedValue([]);
  mockAccept.mockResolvedValue({
    messageId: `<sent-${unique()}@oxy.so>`,
    messageRowId: null,
    delivery: null,
  });
});

describe('which refusal wins when a send fails several checks', () => {
  it('a malformed In-Reply-To before the send limit', async () => {
    const userId = await exhausted();
    await expect(
      sendMessageForUser(userId, { ...base, inReplyTo: 'not-a-message-id' }),
    ).rejects.toThrow(/inReplyTo and references must be RFC 5322 Message-IDs/);
  });

  it('the send limit before a suppressed recipient', async () => {
    const userId = await exhausted();
    const address = `gone-${unique()}@example.com`;
    await suppress(address);
    await expect(sendMessageForUser(userId, { ...base, to: [{ address }] })).rejects.toThrow(
      /^Daily send limit reached$/,
    );
  });

  it('a sender without a username before a suppressed recipient', async () => {
    const userId = await account(null);
    const address = `gone-${unique()}@example.com`;
    await suppress(address);
    await expect(sendMessageForUser(userId, { ...base, to: [{ address }] })).rejects.toThrow(
      /^User must have a username to send email$/,
    );
  });

  it('a suppressed recipient before an attachment that does not exist', async () => {
    const userId = await account();
    const address = `gone-${unique()}@example.com`;
    await suppress(address);
    await expect(
      sendMessageForUser(userId, {
        ...base,
        to: [{ address }],
        attachments: [{ fileId: unique() }],
      }),
    ).rejects.toThrow(/^Cannot send to this address/);
  });

  it('an attachment that does not exist when it is the only problem', async () => {
    const userId = await account();
    const fileId = unique();
    await expect(
      sendMessageForUser(userId, { ...base, attachments: [{ fileId }] }),
    ).rejects.toThrow(`Attachment file not found or not active: ${fileId}`);
    expect(mockAccept).not.toHaveBeenCalled();
  });
});

describe('the preflight read', () => {
  it('is read once and handed to the filing with the Sent folder it found', async () => {
    const userId = await account();
    await emailService.ensureMailboxes(userId);
    const sent = await emailService.getMailboxBySpecialUse(userId, '\\Sent');
    const preflight = jest.spyOn(emailService, 'sendPreflight');
    try {
      await sendMessageForUser(userId, base);
      expect(preflight).toHaveBeenCalledTimes(1);
    } finally {
      preflight.mockRestore();
    }

    expect(mockAccept).toHaveBeenCalledWith(expect.objectContaining({ userId }), {
      preflight: { tier: 'free', sentMailboxId: sent?.id, storageLimit: 5 * 1024 ** 3 },
    });
  });

  it('carries no Sent folder for an account that has none yet, and provisions nothing', async () => {
    const userId = await account();
    await sendMessageForUser(userId, base);

    // The filing falls back to `sentFilingTarget`, which provisions where it
    // always has — inside the (here stubbed) acceptance, not in the checks.
    expect(mockAccept).toHaveBeenCalledWith(expect.objectContaining({ userId }), {
      preflight: expect.objectContaining({ sentMailboxId: null }),
    });
    expect(await emailService.getMailboxBySpecialUse(userId, '\\Sent')).toBeUndefined();
  });
});
