/**
 * Inbound email Socket.IO emit tests, against a REAL Postgres.
 *
 * The route's own three reads — resolving the recipient by username, resolving
 * the destination folder's name and special-use, and counting the mailbox's
 * unread messages — now go to the database, so they are exercised rather than
 * stubbed. The email SERVICE, the spam service and the Socket.IO singleton stay
 * stubbed at the module boundary: this file is about the route, and the service
 * has its own suite.
 *
 * The unread count is the one to watch. It replaced the denormalized
 * `mailboxes.unseen_messages` column, so it is now a filtered aggregate that
 * can return 0 for a reason that is not "no unread mail" — a wrong predicate
 * returns 0 just as quietly. It is asserted as an exact NON-ZERO number against
 * rows written in the same test.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const TEST_WEBHOOK_SECRET = 'test-inbound-secret';
process.env.EMAIL_INBOUND_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

const mockGetIO = jest.fn();
const mockStoreIncomingMessage = jest.fn();
const mockSpamCheck = jest.fn();
const mockSpamShouldReject = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../../utils/socket', () => ({
  getIO: (...args: unknown[]) => mockGetIO(...args),
}));

jest.mock('../../services/email.service', () => ({
  emailService: {
    storeIncomingMessage: (...args: unknown[]) => mockStoreIncomingMessage(...args),
  },
}));

jest.mock('../../services/spam.service', () => ({
  spamService: {
    check: (...args: unknown[]) => mockSpamCheck(...args),
    shouldReject: (...args: unknown[]) => mockSpamShouldReject(...args),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: jest.fn(),
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { mailboxes } from '../../db/schema/mailboxes';
import { messages } from '../../db/schema/messages';
import { users } from '../../db/schema/users';
import emailInboundRouter from '../emailInbound';
import { errorHandler } from '../../middleware/errorHandler';

const unique = () => randomUUID().replace(/-/g, '');

interface RawResponse {
  status: number;
  body: { error?: string; accepted?: number; rejected?: number };
}

function postRaw(server: http.Server, path: string, headers: Record<string, string>, body: Buffer): Promise<RawResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'message/rfc822',
          'content-length': body.length,
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw.length > 0 ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode ?? 0, body: parsed });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use('/email/inbound', express.raw({ type: '*/*', limit: '25mb' }));
  app.use('/email/inbound', emailInboundRouter);
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

function rawMessage(to: string): Buffer {
  return Buffer.from(
    [
      'From: "Alice Sender" <alice@example.com>',
      `To: ${to}`,
      'Subject: Hello there',
      'Date: Mon, 1 Jan 2024 00:00:00 +0000',
      `Message-ID: <test-${unique()}@example.com>`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'This is a   plain text body that should become the snippet.',
      '',
    ].join('\r\n'),
    'utf8'
  );
}

/** A real account whose `@oxy.so` address the route can resolve. */
async function recipient(): Promise<{ id: string; username: string; address: string }> {
  const username = `bob${unique().slice(0, 10)}`;
  const [row] = await getDb()
    .insert(users)
    .values({ username, color: 'teal' })
    .returning({ id: users.id });
  return { id: row.id, username, address: `${username}@oxy.so` };
}

async function folder(userId: string, specialUse: string, name: string): Promise<string> {
  const [row] = await getDb()
    .insert(mailboxes)
    .values({ userId, name, path: `${name}-${unique()}`, specialUse })
    .returning({ id: mailboxes.id });
  return row.id;
}

/** `unread` unseen messages plus one already-read one, so the filter matters. */
async function seedUnread(userId: string, mailboxId: string, unread: number): Promise<void> {
  for (let i = 0; i < unread; i++) {
    await getDb().insert(messages).values({
      userId,
      mailboxId,
      messageId: `<seed-${unique()}@example.com>`,
      fromAddress: 'alice@example.com',
      subject: '',
      size: 10,
      seen: false,
      date: new Date(),
    });
  }
  await getDb().insert(messages).values({
    userId,
    mailboxId,
    messageId: `<seen-${unique()}@example.com>`,
    fromAddress: 'alice@example.com',
    subject: '',
    size: 10,
    seen: true,
    date: new Date(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSpamCheck.mockResolvedValue({ score: 0, action: 'no action' });
  mockSpamShouldReject.mockReturnValue(false);
});

describe('POST /email/inbound socket emit', () => {
  it('emits email:new and email:unread_count to the recipient user room', async () => {
    const user = await recipient();
    const mailboxId = await folder(user.id, '\\Inbox', 'INBOX');
    await seedUnread(user.id, mailboxId, 7);

    const messageId = unique();
    mockStoreIncomingMessage.mockResolvedValueOnce({
      id: messageId,
      mailboxId,
      receivedAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    mockGetIO.mockReturnValue({ to });

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-from': 'alice@example.com',
        'x-envelope-to': user.address,
      },
      rawMessage(user.address)
    );

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(mockStoreIncomingMessage).toHaveBeenCalledTimes(1);

    expect(to).toHaveBeenCalledWith(`user:${user.id}`);

    const emailNewCall = emit.mock.calls.find(([event]) => event === 'email:new');
    expect(emailNewCall).toBeDefined();
    const emailNewPayload = emailNewCall?.[1] as Record<string, unknown>;
    expect(emailNewPayload).toEqual(
      expect.objectContaining({
        messageId,
        mailboxId,
        folder: 'inbox',
        from: { name: 'Alice Sender', address: 'alice@example.com' },
        subject: 'Hello there',
        receivedAt: '2024-01-01T00:00:00.000Z',
        unread: true,
      })
    );
    expect(typeof emailNewPayload.snippet).toBe('string');
    expect((emailNewPayload.snippet as string).length).toBeGreaterThan(0);
    expect((emailNewPayload.snippet as string).length).toBeLessThanOrEqual(140);
    expect(emailNewPayload.snippet).toBe('This is a plain text body that should become the snippet.');

    const unreadCall = emit.mock.calls.find(([event]) => event === 'email:unread_count');
    expect(unreadCall).toBeDefined();
    // Exact and non-zero: the seven unseen rows, not the eight total, and not
    // the zero a predicate that matched nothing would report.
    expect(unreadCall?.[1]).toEqual({ mailboxId, unread: 7 });
  });

  it('reports the spam folder as its own, not as the inbox', async () => {
    const user = await recipient();
    const junkId = await folder(user.id, '\\Junk', 'Spam');
    await seedUnread(user.id, junkId, 1);

    mockStoreIncomingMessage.mockResolvedValueOnce({
      id: unique(),
      mailboxId: junkId,
      receivedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const emit = jest.fn();
    mockGetIO.mockReturnValue({ to: jest.fn().mockReturnValue({ emit }) });

    await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': user.address,
      },
      rawMessage(user.address)
    );

    const payload = emit.mock.calls.find(([event]) => event === 'email:new')?.[1] as Record<string, unknown>;
    expect(payload.folder).toBe('spam');
  });

  it('rejects an envelope whose recipient has no account', async () => {
    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': `ghost${unique().slice(0, 10)}@oxy.so`,
      },
      rawMessage('ghost@oxy.so')
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No valid recipients/);
    expect(mockStoreIncomingMessage).not.toHaveBeenCalled();
  });

  it('resolves the recipient case-insensitively, as the username index does', async () => {
    const user = await recipient();
    const mailboxId = await folder(user.id, '\\Inbox', 'INBOX');
    mockStoreIncomingMessage.mockResolvedValueOnce({
      id: unique(),
      mailboxId,
      receivedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    mockGetIO.mockReturnValue(null);

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': user.address.toUpperCase(),
      },
      rawMessage(user.address)
    );

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
  });

  it('still returns 200 when Socket.IO is unavailable (failure isolation)', async () => {
    const user = await recipient();
    const mailboxId = await folder(user.id, '\\Inbox', 'INBOX');

    mockStoreIncomingMessage.mockResolvedValueOnce({
      id: unique(),
      mailboxId,
      receivedAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    mockGetIO.mockReturnValue(null);

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-from': 'alice@example.com',
        'x-envelope-to': user.address,
      },
      rawMessage(user.address)
    );

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Socket.IO not initialised')
    );
  });

  // The shared-secret guard is NOT asserted here: `verifyEmailInboundWebhookSecret`
  // is exported separately and mounted by `server.ts` ahead of this router, so
  // a test that stands this router up alone can only ever observe it passing.
  // Asserting a 401 against this harness would be a check that cannot fail for
  // the reason it claims to.
});
