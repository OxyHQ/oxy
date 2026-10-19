/**
 * `emailService.storeIncomingMessage` — inbound deposit, against a REAL Postgres.
 *
 * Every MIME attachment is deposited as a private File owned by the RECIPIENT
 * via `assetService.uploadFileDirect(..., 'private', {source: 'email-inbound'})`
 * and then linked under the Oxy Inbox application. The message keeps only the canonical
 * reference — `{fileId, name, contentType, size, contentId?, isInline}` — never
 * an s3Key or a raw buffer. The asset service is stubbed (it owns S3); the
 * database is not, because what the message ends up carrying is the guarantee.
 *
 * The port moved `to`/`cc`/`bcc` and `attachments` into child tables, so this
 * also pins the things that only a real database can answer:
 *   - the parent and its children are ONE transaction, so a message can never
 *     be stored claiming addressees it does not have;
 *   - `ord` preserves header order;
 *   - addresses are lower-cased and trimmed at the call site, an obligation
 *     Postgres has no setter to discharge.
 */

const mockUploadFileDirect = jest.fn();
const mockLinkFile = jest.fn();
const mockDeleteFile = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../assetServiceSingleton', () => ({
  assetService: {
    uploadFileDirect: (...args: unknown[]) => mockUploadFileDirect(...args),
    linkFile: (...args: unknown[]) => mockLinkFile(...args),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...args),
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
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}));

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema/files';
import { messageAttachments } from '../../db/schema/messageAttachments';
import { messageRecipients } from '../../db/schema/messageRecipients';
import { messages } from '../../db/schema/messages';
import { normalizedAppEventOutbox } from '../../db/schema/normalizedAppEventOutbox';
import { users } from '../../db/schema/users';
import { emailService } from '../email.service';
import { INBOX_APPLICATION_ID } from '../../config/inboxInference';

const unique = () => randomUUID().replace(/-/g, '');

/** A recipient account with a username the inbound path can resolve. */
async function recipient(): Promise<{ id: string; username: string }> {
  const username = `bob${unique().slice(0, 10)}`;
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  return { id: row.id, username };
}

/** A real `files` row, so the attachment foreign key has something to point at. */
async function storedFile(
  ownerUserId: string,
  name: string,
  mime: string,
  size: number,
  sha256 = unique(),
) {
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size,
      mime,
      ext: name.split('.').pop() ?? 'bin',
      storageKey: `assets/${unique()}`,
      originalName: name,
      ownerUserId,
    })
    .returning({ id: files.id });
  return { id: row.id, originalName: name, mime, size };
}

interface StoreParams {
  recipientUsername: string;
  from: { name?: string; address: string };
  to: Array<{ name?: string; address: string }>;
  cc?: Array<{ name?: string; address: string }>;
  subject: string;
  text?: string;
  messageId: string;
  date: Date;
  headers: Record<string, string>;
  attachments?: Array<{
    filename: string;
    contentType: string;
    content: Buffer;
    contentId?: string;
    isInline?: boolean;
  }>;
  rawSize: number;
}

function baseParams(username: string, overrides: Partial<StoreParams> = {}): StoreParams {
  return {
    recipientUsername: username,
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: `${username}@oxy.so` }],
    subject: 'Hello',
    text: 'Body',
    messageId: `<mime-${unique()}@example.com>`,
    date: new Date('2024-01-01T00:00:00.000Z'),
    headers: {},
    rawSize: 1000,
    ...overrides,
  };
}

async function attachmentsOf(messageId: string) {
  return getDb()
    .select({
      fileId: messageAttachments.fileId,
      name: messageAttachments.name,
      contentType: messageAttachments.contentType,
      size: messageAttachments.size,
      contentId: messageAttachments.contentId,
      isInline: messageAttachments.isInline,
      ord: messageAttachments.ord,
    })
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, messageId))
    .orderBy(asc(messageAttachments.ord));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLinkFile.mockResolvedValue(undefined);
  mockDeleteFile.mockResolvedValue(undefined);
});

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('storeIncomingMessage — attachment deposit', () => {
  it('uploads each attachment as a private recipient-owned File and persists canonical references', async () => {
    const user = await recipient();
    const pdf = await storedFile(user.id, 'report.pdf', 'application/pdf', 2048);
    const png = await storedFile(user.id, 'logo.png', 'image/png', 512);
    mockUploadFileDirect.mockResolvedValueOnce(pdf).mockResolvedValueOnce(png);

    const pdfContent = Buffer.from('pdf-bytes');
    const pngContent = Buffer.from('png-bytes');

    const stored = await emailService.storeIncomingMessage(
      baseParams(user.username, {
        attachments: [
          { filename: 'report.pdf', contentType: 'application/pdf', content: pdfContent },
          {
            filename: 'logo.png',
            contentType: 'image/png',
            content: pngContent,
            contentId: 'cid-logo',
            isInline: true,
          },
        ],
      }),
    );

    expect(mockUploadFileDirect).toHaveBeenCalledTimes(2);
    expect(mockUploadFileDirect).toHaveBeenNthCalledWith(
      1,
      user.id,
      pdfContent,
      'application/pdf',
      'report.pdf',
      'private',
      { source: 'email-inbound' },
    );
    expect(mockUploadFileDirect).toHaveBeenNthCalledWith(
      2,
      user.id,
      pngContent,
      'image/png',
      'logo.png',
      'private',
      { source: 'email-inbound' },
    );

    // The wire shape: the child rows are reassembled into the `attachments`
    // array the API returns.
    expect(stored.attachments).toEqual([
      {
        fileId: pdf.id,
        name: 'report.pdf',
        contentType: 'application/pdf',
        size: 2048,
        contentId: null,
        isInline: false,
      },
      {
        fileId: png.id,
        name: 'logo.png',
        contentType: 'image/png',
        size: 512,
        contentId: 'cid-logo',
        isInline: true,
      },
    ]);
    expect(stored.size).toBe(1000 + 2048 + 512);

    // …and the rows behind it carry the MIME part order explicitly.
    expect((await attachmentsOf(stored.id)).map((a) => [a.ord, a.name])).toEqual([
      [0, 'report.pdf'],
      [1, 'logo.png'],
    ]);

    expect(mockLinkFile).toHaveBeenCalledTimes(2);
    for (const fileId of [pdf.id, png.id]) {
      expect(mockLinkFile).toHaveBeenCalledWith(fileId, {
        applicationId: INBOX_APPLICATION_ID,
        entityType: 'message',
        entityId: stored.id,
        createdByUserId: user.id,
      });
    }
  });

  it('isolates linkFile failures — the message is stored and the call resolves', async () => {
    const user = await recipient();
    const pdf = await storedFile(user.id, 'report.pdf', 'application/pdf', 2048);
    mockUploadFileDirect.mockResolvedValueOnce(pdf);
    mockLinkFile.mockRejectedValueOnce(new Error('link service down'));

    const stored = await emailService.storeIncomingMessage(
      baseParams(user.username, {
        attachments: [
          { filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('x') },
        ],
      }),
    );

    expect(stored.id).toBeDefined();
    expect(await attachmentsOf(stored.id)).toHaveLength(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Failed to link inbound attachment to message',
      expect.objectContaining({ fileId: pdf.id, messageId: stored.id }),
    );
  });

  it('performs no asset operations for messages without attachments', async () => {
    const user = await recipient();

    const stored = await emailService.storeIncomingMessage(baseParams(user.username));

    expect(mockUploadFileDirect).not.toHaveBeenCalled();
    expect(mockLinkFile).not.toHaveBeenCalled();
    expect(stored.attachments).toEqual([]);
  });
});

describe('storeIncomingMessage — a message that could not be stored', () => {
  /** A file id the attachment foreign key refuses, so the message insert fails. */
  const missingFile = () => ({
    id: `missing-${unique()}`,
    originalName: 'gone.bin',
    mime: 'application/octet-stream',
    size: 1,
  });
  const attachment = (content: string) => ({
    filename: `${content}.bin`,
    contentType: 'application/octet-stream',
    content: Buffer.from(`${content}-${unique()}`),
  });

  async function storedCount(userId: string, messageId: string): Promise<number> {
    const rows = await getDb()
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.messageId, messageId)));
    return rows.length;
  }

  it('removes every file it uploaded and rethrows the insert`s error', async () => {
    const user = await recipient();
    const pdf = await storedFile(user.id, 'report.pdf', 'application/pdf', 2048);
    const gone = missingFile();
    mockUploadFileDirect.mockResolvedValueOnce(pdf).mockResolvedValueOnce(gone);
    const params = baseParams(user.username, {
      attachments: [attachment('a'), attachment('b')],
    });

    await expect(emailService.storeIncomingMessage(params)).rejects.toThrow();

    expect(await storedCount(user.id, params.messageId)).toBe(0);
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
    expect(mockDeleteFile).toHaveBeenCalledWith(pdf.id, false, user.id);
    expect(mockDeleteFile).toHaveBeenCalledWith(gone.id, false, user.id);
    expect(mockLinkFile).not.toHaveBeenCalled();
  });

  it('removes the files already uploaded when a later upload fails', async () => {
    const user = await recipient();
    const pdf = await storedFile(user.id, 'report.pdf', 'application/pdf', 2048);
    mockUploadFileDirect
      .mockResolvedValueOnce(pdf)
      .mockRejectedValueOnce(new Error('S3 unavailable'));

    await expect(
      emailService.storeIncomingMessage(
        baseParams(user.username, { attachments: [attachment('a'), attachment('b')] }),
      ),
    ).rejects.toThrow('S3 unavailable');

    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).toHaveBeenCalledWith(pdf.id, false, user.id);
  });

  it('keeps a file the user already held, which the upload handed back', async () => {
    // `uploadFileDirect` returns the owner's existing row for bytes they
    // already hold — another message's attachment. Deleting it would break
    // that message.
    const user = await recipient();
    const held = attachment('held');
    const existing = await storedFile(
      user.id,
      'held.bin',
      'application/octet-stream',
      held.content.length,
      createHash('sha256').update(held.content).digest('hex'),
    );
    mockUploadFileDirect.mockResolvedValueOnce(existing).mockResolvedValueOnce(missingFile());

    await expect(
      emailService.storeIncomingMessage(
        baseParams(user.username, { attachments: [held, attachment('new')] }),
      ),
    ).rejects.toThrow();

    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeleteFile).not.toHaveBeenCalledWith(existing.id, expect.anything(), user.id);
  });

  it('logs a cleanup that failed and still rethrows the original error', async () => {
    const user = await recipient();
    const gone = missingFile();
    mockUploadFileDirect.mockResolvedValueOnce(gone);
    mockDeleteFile.mockRejectedValueOnce(new Error('File not found'));

    await expect(
      emailService.storeIncomingMessage(
        baseParams(user.username, { attachments: [attachment('a')] }),
      ),
    ).rejects.toThrow(/insert into "message_attachments"/);

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Failed to remove an inbound attachment after the message was not stored',
      expect.objectContaining({ fileId: gone.id, error: 'File not found' }),
    );
  });
});

describe('storeIncomingMessage — the message itself', () => {
  it('lands in the Inbox, unread, with the headers it arrived with', async () => {
    const user = await recipient();

    const stored = await emailService.storeIncomingMessage(
      baseParams(user.username, {
        headers: { received: 'from mx.example.com (203.0.113.9)' },
      }),
    );

    expect(stored.flags.seen).toBe(false);
    expect(stored.subject).toBe('Hello');
    expect(stored.from).toEqual({ name: 'Alice', address: 'alice@example.com' });
    // `headers` is protected, so it is absent from the returned DTO…
    expect(stored.headers).toBeUndefined();
    // …but it IS stored: the one sanctioned place third-party SMTP
    // `Received:` IPs are retained.
    const [row] = await getDb()
      .select({ headers: messages.headers })
      .from(messages)
      .where(eq(messages.id, stored.id));
    expect(row.headers.received).toContain('203.0.113.9');

    const eventIds = [`${stored.id}:new_email`, `${stored.id}:email_needs_reply`];
    const events = await getDb()
      .select({ event: normalizedAppEventOutbox.event })
      .from(normalizedAppEventOutbox)
      .where(inArray(normalizedAppEventOutbox.eventId, eventIds));
    expect(events).toHaveLength(2);
    expect(
      events.every(
        ({ event }) =>
          event.accountId === user.id &&
          event.resource.effectiveAccountId === user.id &&
          event.resource.resourceId === stored.mailboxId,
      ),
    ).toBe(true);
    const newEmail = events.find(({ event }) => event.type === 'new_email')?.event;
    expect(newEmail?.data).toMatchObject({ snippet: 'Body', folder: 'inbox' });
  });

  it('tells subscribers a spam-scored message is spam, and never that it needs a reply', async () => {
    const user = await recipient();
    const spam = await emailService.storeIncomingMessage(
      baseParams(user.username, { spamScore: 9, spamAction: 'reject', text: 'x'.repeat(500) }),
    );
    const events = await getDb()
      .select({ event: normalizedAppEventOutbox.event })
      .from(normalizedAppEventOutbox)
      .where(
        inArray(normalizedAppEventOutbox.eventId, [
          `${spam.id}:new_email`,
          `${spam.id}:email_needs_reply`,
        ]),
      );
    expect(events.map(({ event }) => event.type)).toEqual(['new_email']);
    expect(events[0]?.event.data).toMatchObject({ folder: 'spam' });
    expect(String(events[0]?.event.data.snippet).length).toBeLessThanOrEqual(140);
  });

  it('routes a spam-scored message to Junk instead of the Inbox', async () => {
    const user = await recipient();

    const clean = await emailService.storeIncomingMessage(baseParams(user.username));
    const spam = await emailService.storeIncomingMessage(
      baseParams(user.username, { spamScore: 9, spamAction: 'reject' }),
    );

    expect(spam.mailboxId).not.toBe(clean.mailboxId);
    expect(spam.spamScore).toBe(9);
    const inbox = await emailService.getMailboxBySpecialUse(user.id, '\\Inbox');
    const junk = await emailService.getMailboxBySpecialUse(user.id, '\\Junk');
    expect(clean.mailboxId).toBe(inbox?.id);
    expect(spam.mailboxId).toBe(junk?.id);
  });

  it('stores the recipients in header order, lower-cased and trimmed', async () => {
    // Postgres has no setter to lower-case and trim, so the call site owns
    // it — and if it forgets, address matching
    // quietly becomes case-sensitive with nothing to notice.
    const user = await recipient();

    const stored = await emailService.storeIncomingMessage(
      baseParams(user.username, {
        from: { name: '  Alice  ', address: '  Alice@Example.COM ' },
        to: [{ name: 'Bob', address: ' BOB@Oxy.SO ' }, { address: 'Carol@Example.com' }],
        cc: [{ address: 'Dave@Example.com' }],
      }),
    );

    expect(stored.from).toEqual({ name: 'Alice', address: 'alice@example.com' });
    expect(stored.to).toEqual([
      { name: 'Bob', address: 'bob@oxy.so' },
      { name: '', address: 'carol@example.com' },
    ]);
    expect(stored.cc).toEqual([{ name: '', address: 'dave@example.com' }]);
    expect(stored.bcc).toEqual([]);

    const rows = await getDb()
      .select({
        kind: messageRecipients.kind,
        ord: messageRecipients.ord,
        address: messageRecipients.address,
      })
      .from(messageRecipients)
      .where(eq(messageRecipients.messageId, stored.id))
      .orderBy(asc(messageRecipients.kind), asc(messageRecipients.ord));
    expect(rows).toEqual([
      { kind: 'cc', ord: 0, address: 'dave@example.com' },
      { kind: 'to', ord: 0, address: 'bob@oxy.so' },
      { kind: 'to', ord: 1, address: 'carol@example.com' },
    ]);
  });

  it('flags a read-receipt request from the Disposition-Notification-To header', async () => {
    const user = await recipient();

    const stored = await emailService.storeIncomingMessage(
      baseParams(user.username, {
        headers: { 'disposition-notification-to': 'alice@example.com' },
      }),
    );

    expect(stored.readReceiptRequested).toBe(true);
    expect(stored.readReceiptSent).toBe(false);
  });

  it('rejects mail for an account that does not exist', async () => {
    await expect(
      emailService.storeIncomingMessage(baseParams(`ghost${unique().slice(0, 10)}`)),
    ).rejects.toThrow(/Recipient user not found/);
  });
});
