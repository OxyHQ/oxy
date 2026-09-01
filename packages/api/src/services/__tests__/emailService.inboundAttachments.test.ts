/**
 * emailService.storeIncomingMessage — inbound attachment deposit coverage.
 *
 * The Oxy File Manager migration changed the inbound path so every MIME
 * attachment is deposited as a private File owned by the RECIPIENT via
 * `assetService.uploadFileDirect(..., 'private', { source: 'email-inbound' })`,
 * then linked to the stored Message under `app: 'oxy-mail'`. The Message
 * subdocument persists only the canonical reference shape
 * `{ fileId, name, contentType, size, contentId?, isInline }` — never an
 * s3Key or raw buffer.
 *
 * Covered:
 *   1. Each attachment is uploaded via uploadFileDirect with the recipient's
 *      userId, private visibility, and email-inbound source metadata.
 *   2. Message.create receives the canonical IAttachment[] built from the
 *      returned File records (fileId/name/contentType/size/contentId/isInline).
 *   3. Each uploaded file is linked (app oxy-mail, entityType message,
 *      entityId = stored message _id, createdBy = recipient).
 *   4. linkFile failure is isolated — storeIncomingMessage still resolves.
 *   5. Messages without attachments perform no asset calls.
 *
 * All mongoose models and the asset service are stubbed at the module
 * boundary; no DB or S3 access occurs.
 */

const mockUploadFileDirect = jest.fn();
const mockLinkFile = jest.fn();
const mockUserFindOne = jest.fn();
const mockMailboxFind = jest.fn();
const mockMailboxFindOne = jest.fn();
const mockMailboxFindByIdAndUpdate = jest.fn();
const mockMessageCreate = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../assetServiceSingleton', () => ({
  assetService: {
    uploadFileDirect: (...args: unknown[]) => mockUploadFileDirect(...args),
    linkFile: (...args: unknown[]) => mockLinkFile(...args),
  },
}));

jest.mock('../../models/User', () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => mockUserFindOne(...args) },
}));

jest.mock('../../models/Mailbox', () => ({
  Mailbox: {
    find: (...args: unknown[]) => mockMailboxFind(...args),
    findOne: (...args: unknown[]) => mockMailboxFindOne(...args),
    findByIdAndUpdate: (...args: unknown[]) => mockMailboxFindByIdAndUpdate(...args),
  },
}));

jest.mock('../../models/Message', () => ({
  Message: {
    create: (...args: unknown[]) => mockMessageCreate(...args),
  },
}));

jest.mock('../../models/Label', () => ({ Label: { countDocuments: jest.fn().mockResolvedValue(1) } }));
jest.mock('../../models/Bundle', () => ({ Bundle: { countDocuments: jest.fn().mockResolvedValue(1) } }));
jest.mock('../../models/Reminder', () => ({ Reminder: {} }));
jest.mock('../../models/Contact', () => ({ Contact: {} }));
jest.mock('../../models/EmailTemplate', () => ({ EmailTemplate: {} }));
jest.mock('../../models/EmailFilter', () => ({ EmailFilter: { find: jest.fn().mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([]) }) }) } }));

jest.mock('../senderAvatar.service', () => ({ getAvatarPathsBatch: jest.fn() }));
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
jest.mock('../push.service', () => ({
  pushService: { sendPushNotification: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}));

import { emailService } from '../email.service';

const svc = emailService as unknown as {
  ensureMailboxes: (userId: string) => Promise<void>;
  ensureDefaultLabels: (userId: string) => Promise<void>;
  enforceQuota: (userId: string, bytes: number) => Promise<void>;
  getMailboxBySpecialUse: (userId: string, specialUse: string) => Promise<unknown>;
  applyFilters: (userId: string, messageId: string) => Promise<void>;
  applyGlobalAutoForward: (userId: string, messageId: string) => Promise<void>;
};

const RECIPIENT_ID = '64b0000000000000000000aa';
const MAILBOX_ID = '64b0000000000000000000bb';
const MESSAGE_DOC_ID = '64b0000000000000000000cc';
const FILE_ID_1 = '64f0000000000000000000a1';
const FILE_ID_2 = '64f0000000000000000000a2';

interface StoreParams {
  recipientUsername: string;
  from: { name?: string; address: string };
  to: Array<{ name?: string; address: string }>;
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

function baseParams(overrides: Partial<StoreParams> = {}): StoreParams {
  return {
    recipientUsername: 'bob',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: 'bob@oxy.so' }],
    subject: 'Hello',
    text: 'Body',
    messageId: '<mime-1@example.com>',
    date: new Date('2024-01-01T00:00:00.000Z'),
    headers: {},
    rawSize: 1000,
    ...overrides,
  };
}

function stageHappyPath(): void {
  mockUserFindOne.mockResolvedValue({ _id: { toString: () => RECIPIENT_ID } });
  mockMailboxFindByIdAndUpdate.mockResolvedValue(undefined);
  mockMessageCreate.mockImplementation((doc: Record<string, unknown>) =>
    Promise.resolve({
      ...doc,
      _id: { toString: () => MESSAGE_DOC_ID },
      toJSON: () => ({ id: MESSAGE_DOC_ID, ...doc }),
    })
  );

  jest.spyOn(svc, 'ensureMailboxes').mockResolvedValue(undefined);
  jest.spyOn(svc, 'enforceQuota').mockResolvedValue(undefined);
  jest.spyOn(svc, 'getMailboxBySpecialUse').mockResolvedValue({
    _id: { toString: () => MAILBOX_ID },
    name: 'INBOX',
    specialUse: '\\Inbox',
  });
  jest.spyOn(svc, 'applyFilters').mockResolvedValue(undefined);
  jest.spyOn(svc, 'applyGlobalAutoForward').mockResolvedValue(undefined);
}

function makeUploadedFile(id: string, name: string, mime: string, size: number): {
  _id: { toString: () => string };
  originalName: string;
  mime: string;
  size: number;
} {
  return { _id: { toString: () => id }, originalName: name, mime, size };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('emailService.storeIncomingMessage — attachment deposit', () => {
  it('uploads each attachment as a private recipient-owned File and persists canonical references', async () => {
    stageHappyPath();
    mockUploadFileDirect
      .mockResolvedValueOnce(makeUploadedFile(FILE_ID_1, 'report.pdf', 'application/pdf', 2048))
      .mockResolvedValueOnce(makeUploadedFile(FILE_ID_2, 'logo.png', 'image/png', 512));
    mockLinkFile.mockResolvedValue(undefined);

    const pdfContent = Buffer.from('pdf-bytes');
    const pngContent = Buffer.from('png-bytes');

    await emailService.storeIncomingMessage(
      baseParams({
        attachments: [
          { filename: 'report.pdf', contentType: 'application/pdf', content: pdfContent },
          { filename: 'logo.png', contentType: 'image/png', content: pngContent, contentId: 'cid-logo', isInline: true },
        ],
      })
    );

    expect(mockUploadFileDirect).toHaveBeenCalledTimes(2);
    expect(mockUploadFileDirect).toHaveBeenNthCalledWith(
      1,
      RECIPIENT_ID,
      pdfContent,
      'application/pdf',
      'report.pdf',
      'private',
      { source: 'email-inbound' }
    );
    expect(mockUploadFileDirect).toHaveBeenNthCalledWith(
      2,
      RECIPIENT_ID,
      pngContent,
      'image/png',
      'logo.png',
      'private',
      { source: 'email-inbound' }
    );

    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    const createdDoc = mockMessageCreate.mock.calls[0][0] as {
      attachments: Array<Record<string, unknown>>;
      size: number;
    };
    expect(createdDoc.attachments).toEqual([
      {
        fileId: FILE_ID_1,
        name: 'report.pdf',
        contentType: 'application/pdf',
        size: 2048,
        isInline: false,
      },
      {
        fileId: FILE_ID_2,
        name: 'logo.png',
        contentType: 'image/png',
        size: 512,
        contentId: 'cid-logo',
        isInline: true,
      },
    ]);
    expect(createdDoc.size).toBe(1000 + 2048 + 512);

    expect(mockLinkFile).toHaveBeenCalledTimes(2);
    for (const fileId of [FILE_ID_1, FILE_ID_2]) {
      expect(mockLinkFile).toHaveBeenCalledWith(fileId, {
        app: 'oxy-mail',
        entityType: 'message',
        entityId: MESSAGE_DOC_ID,
        createdBy: RECIPIENT_ID,
      });
    }
  });

  it('isolates linkFile failures — the message is stored and the call resolves', async () => {
    stageHappyPath();
    mockUploadFileDirect.mockResolvedValueOnce(
      makeUploadedFile(FILE_ID_1, 'report.pdf', 'application/pdf', 2048)
    );
    mockLinkFile.mockRejectedValueOnce(new Error('link service down'));

    await expect(
      emailService.storeIncomingMessage(
        baseParams({
          attachments: [
            { filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('x') },
          ],
        })
      )
    ).resolves.toBeDefined();

    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Failed to link inbound attachment to message',
      expect.objectContaining({ fileId: FILE_ID_1, messageId: MESSAGE_DOC_ID })
    );
  });

  it('performs no asset operations for messages without attachments', async () => {
    stageHappyPath();

    await emailService.storeIncomingMessage(baseParams());

    expect(mockUploadFileDirect).not.toHaveBeenCalled();
    expect(mockLinkFile).not.toHaveBeenCalled();
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
    const createdDoc = mockMessageCreate.mock.calls[0][0] as { attachments: unknown[] };
    expect(createdDoc.attachments).toEqual([]);
  });
});
