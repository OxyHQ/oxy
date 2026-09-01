/**
 * POST /email/messages — attachment resolution coverage.
 *
 * Exercises the canonical `{ fileId, contentId?, isInline? }` attachment
 * contract introduced by the Oxy File Manager migration. The route handler
 * resolves each fileId via assetService, enforces ownerUserId ownership,
 * snapshots `{name, contentType, size}` from the File
 * record into a `MessageAttachment` (`db/schema/messageAttachments.ts`), and
 * links each file to the stored Message under `app: 'oxy-mail'`.
 *
 * Failure modes covered:
 *   1. Happy path — valid {fileId} array sends; resolved MessageAttachment[]
 *      reaches smtpOutbound.send AND linkFile is called for each file.
 *   2. Foreign file (ownerUserId !== sender) → 403 ForbiddenError.
 *   3. Missing file (assetService returns no record) → 400 BadRequestError.
 *   4. Trashed file (status !== 'active') → 400 BadRequestError.
 *   5. Legacy shape (bare `s3Key`/`filename`) → 400 from Zod validation
 *      (no silent compat path).
 *
 * smtpOutbound, emailService and assetService are stubbed at the module
 * boundary — they own the network. The SENDER lookup is not: it reads the
 * `users` row from a real Postgres, because "resolve the sending account" is
 * one of the queries this batch ported.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

/** Filled in `beforeAll` from a real `users` row. */
let mockTestUserId = '';

const mockAuthMiddleware = jest.fn();
const mockSmtpSend = jest.fn();
const mockEnforceSendLimit = jest.fn();
const mockAutoCollectContacts = jest.fn();
const mockGetFilesByIds = jest.fn();
const mockCanUserAccessFile = jest.fn();
const mockLinkFile = jest.fn();
const mockResolveEmailAddress = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    mockAuthMiddleware();
    req.user = { id: mockTestUserId };
    next();
  },
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../services/smtp.outbound', () => ({
  smtpOutbound: { send: (...args: unknown[]) => mockSmtpSend(...args) },
}));

jest.mock('../../services/email.service', () => ({
  emailService: {
    enforceSendLimit: (...args: unknown[]) => mockEnforceSendLimit(...args),
    autoCollectContacts: (...args: unknown[]) => mockAutoCollectContacts(...args),
    scheduleMessage: jest.fn(),
    updateMessageFlags: jest.fn(),
    saveDraft: jest.fn(),
    listMailboxes: jest.fn(),
    ensureMailboxes: jest.fn(),
  },
}));

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFilesByIds: (...args: unknown[]) => mockGetFilesByIds(...args),
    canUserAccessFile: (...args: unknown[]) => mockCanUserAccessFile(...args),
    linkFile: (...args: unknown[]) => mockLinkFile(...args),
  },
}));

jest.mock('../../config/email.config', () => ({
  resolveEmailAddress: (...args: unknown[]) => mockResolveEmailAddress(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import emailRouter from '../email';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

function postJson(server: http.Server, path: string, body: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': raw.length,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          try {
            const parsed = chunks.length > 0 ? JSON.parse(chunks) : {};
            resolve({ status: res.statusCode ?? 0, body: parsed });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const [sender] = await getDb()
    .insert(users)
    .values({
      username: `alice${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      nameFirst: 'Alice',
      nameLast: 'Smith',
      color: 'teal',
    })
    .returning({ id: users.id });
  mockTestUserId = sender.id;

  const app = express();
  app.use(express.json());
  app.use('/email', emailRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closePostgres();
});

const FILE_OWN = '64f0000000000000000000a1';
const FILE_FOREIGN = '64f0000000000000000000a2';
const FILE_TRASHED = '64f0000000000000000000a3';
const FILE_MISSING = '64f0000000000000000000a4';
const OTHER_USER_ID = '64b0000000000000000000bb';

function makeFile(id: string, status: 'active' | 'trash' | 'deleted', ownerUserId = mockTestUserId): {
  id: string;
  status: 'active' | 'trash' | 'deleted';
  originalName: string;
  mime: string;
  size: number;
  ownerUserId: string;
} {
  return {
    id,
    status,
    originalName: `${id}.pdf`,
    mime: 'application/pdf',
    size: 1234,
    ownerUserId,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnforceSendLimit.mockResolvedValue(undefined);
  mockAutoCollectContacts.mockResolvedValue(undefined);
  mockResolveEmailAddress.mockReturnValue('alice@oxy.so');
  mockSmtpSend.mockResolvedValue({ messageId: 'sent-1', queued: false });
});

describe('POST /email/messages — attachment resolution', () => {
  it('resolves {fileId} references and links each file to the sent message', async () => {
    const ownedFile = makeFile(FILE_OWN, 'active');
    mockGetFilesByIds.mockResolvedValueOnce([ownedFile]);
    mockLinkFile.mockResolvedValue(undefined);

    const res = await postJson(server, '/email/messages', {
      to: [{ name: 'Bob', address: 'bob@example.com' }],
      subject: 'Hi',
      text: 'Body',
      attachments: [{ fileId: FILE_OWN, isInline: false }],
    });

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual(
      expect.objectContaining({ messageId: 'sent-1', queued: false }),
    );

    expect(mockGetFilesByIds).toHaveBeenCalledWith([FILE_OWN]);
    expect(mockCanUserAccessFile).not.toHaveBeenCalled();

    expect(mockSmtpSend).toHaveBeenCalledTimes(1);
    const sendArg = mockSmtpSend.mock.calls[0][0] as {
      attachments: Array<{ fileId: string; name: string; contentType: string; size: number; isInline: boolean }>;
    };
    expect(sendArg.attachments).toEqual([
      {
        fileId: FILE_OWN,
        name: `${FILE_OWN}.pdf`,
        contentType: 'application/pdf',
        size: 1234,
        isInline: false,
      },
    ]);

    expect(mockLinkFile).toHaveBeenCalledWith(FILE_OWN, {
      app: 'oxy-mail',
      entityType: 'message',
      entityId: 'sent-1',
      createdBy: mockTestUserId,
    });
  });

  it('returns 403 when the requesting user does not own the referenced file', async () => {
    const foreignFile = makeFile(FILE_FOREIGN, 'active', OTHER_USER_ID);
    mockGetFilesByIds.mockResolvedValueOnce([foreignFile]);
    mockCanUserAccessFile.mockResolvedValueOnce(true);

    const res = await postJson(server, '/email/messages', {
      to: [{ address: 'bob@example.com' }],
      subject: 'Hi',
      attachments: [{ fileId: FILE_FOREIGN }],
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(
      expect.objectContaining({ error: expect.stringMatching(/forbidden/i) }),
    );
    expect(mockCanUserAccessFile).not.toHaveBeenCalled();
    expect(mockSmtpSend).not.toHaveBeenCalled();
    expect(mockLinkFile).not.toHaveBeenCalled();
  });

  it('returns 400 when a referenced fileId does not exist', async () => {
    mockGetFilesByIds.mockResolvedValueOnce([]);

    const res = await postJson(server, '/email/messages', {
      to: [{ address: 'bob@example.com' }],
      subject: 'Hi',
      attachments: [{ fileId: FILE_MISSING }],
    });

    expect(res.status).toBe(400);
    expect(mockSmtpSend).not.toHaveBeenCalled();
    expect(mockLinkFile).not.toHaveBeenCalled();
  });

  it('returns 400 when a referenced file is not in status=active (trashed/deleted)', async () => {
    const trashed = makeFile(FILE_TRASHED, 'trash');
    mockGetFilesByIds.mockResolvedValueOnce([trashed]);

    const res = await postJson(server, '/email/messages', {
      to: [{ address: 'bob@example.com' }],
      subject: 'Hi',
      attachments: [{ fileId: FILE_TRASHED }],
    });

    expect(res.status).toBe(400);
    expect(mockSmtpSend).not.toHaveBeenCalled();
    expect(mockCanUserAccessFile).not.toHaveBeenCalled();
    expect(mockLinkFile).not.toHaveBeenCalled();
  });

  it('rejects legacy attachment shapes (bare s3Key / filename) at the schema layer', async () => {
    const res = await postJson(server, '/email/messages', {
      to: [{ address: 'bob@example.com' }],
      subject: 'Hi',
      attachments: [{ s3Key: 'legacy/key.pdf', filename: 'old.pdf', contentType: 'application/pdf', size: 10 }],
    });

    expect(res.status).toBe(400);
    expect(mockGetFilesByIds).not.toHaveBeenCalled();
    expect(mockSmtpSend).not.toHaveBeenCalled();
  });

  it('rejects bare-string recipients (legacy shape) at the schema layer', async () => {
    const res = await postJson(server, '/email/messages', {
      to: ['bob@example.com'],
      subject: 'Hi',
    });

    expect(res.status).toBe(400);
    expect(mockEnforceSendLimit).not.toHaveBeenCalled();
    expect(mockSmtpSend).not.toHaveBeenCalled();
  });
});
