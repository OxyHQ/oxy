/**
 * Cloudflare Email Routing webhook tests, against a REAL Postgres.
 *
 * What this route still owns after the realtime emit moved out of it: parsing
 * the envelope, resolving each recipient to an Oxy account by username, the
 * spam gate, and answering Cloudflare. The email SERVICE and the spam service
 * are stubbed at the module boundary.
 *
 * The socket emit is deliberately NOT tested here any more. It used to live in
 * this route, which is exactly why mail arriving any other way was silent; it
 * now lives in `EmailService.storeIncomingMessage` via
 * `services/inboxRealtime.ts`, and `services/__tests__/inboxRealtime.test.ts`
 * covers it for EVERY ingest path rather than only this one.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const TEST_WEBHOOK_SECRET = 'test-inbound-secret';
process.env.EMAIL_INBOUND_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

const mockStoreIncomingMessage = jest.fn();
const mockSpamCheck = jest.fn();
const mockSpamShouldReject = jest.fn();
const mockLoggerWarn = jest.fn();

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

describe('POST /email/inbound', () => {
  it('stores one message per valid recipient and reports it to Cloudflare', async () => {
    const user = await recipient();
    const mailboxId = await folder(user.id, '\\Inbox', 'INBOX');
    await seedUnread(user.id, mailboxId, 7);

    const messageId = unique();
    mockStoreIncomingMessage.mockResolvedValueOnce({
      id: messageId,
      mailboxId,
      receivedAt: new Date('2024-01-01T00:00:00.000Z'),
    });

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
    expect(res.body.rejected).toBe(0);
    expect(mockStoreIncomingMessage).toHaveBeenCalledTimes(1);

    // The parsed MIME reaches the service intact; the service is what decides
    // where it lands and what gets announced.
    const stored = mockStoreIncomingMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(stored).toEqual(
      expect.objectContaining({
        recipientUsername: user.username,
        subject: 'Hello there',
        from: { name: 'Alice Sender', address: 'alice@example.com' },
      })
    );
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

  // The shared-secret guard is NOT asserted here: `verifyEmailInboundWebhookSecret`
  // is exported separately and mounted by `server.ts` ahead of this router, so
  // a test that stands this router up alone can only ever observe it passing.
  // Asserting a 401 against this harness would be a check that cannot fail for
  // the reason it claims to.
});
