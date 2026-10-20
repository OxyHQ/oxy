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
import { users } from '../../db/schema/users';
import emailInboundRouter from '../emailInbound';
import { errorHandler } from '../../middleware/errorHandler';
import { BadRequestError, NotFoundError } from '../../utils/error';
import { insertMessageRows } from '../../../test-support/messageRows';

const unique = () => randomUUID().replace(/-/g, '');

interface RawResponse {
  status: number;
  body: {
    error?: string;
    accepted?: number;
    rejected?: number;
    results?: Array<{ recipient: string; status: string }>;
  };
}

function postRaw(
  server: http.Server,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<RawResponse> {
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
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = raw.length > 0 ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode ?? 0, body: parsed });
          } catch (err) {
            reject(err);
          }
        });
      },
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
    'utf8',
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
    await insertMessageRows([
      {
        userId,
        mailboxId,
        messageId: `<seed-${unique()}@example.com>`,
        fromAddress: 'alice@example.com',
        subject: '',
        size: 10,
        seen: false,
        date: new Date(),
      },
    ]);
  }
  await insertMessageRows([
    {
      userId,
      mailboxId,
      messageId: `<seen-${unique()}@example.com>`,
      fromAddress: 'alice@example.com',
      subject: '',
      size: 10,
      seen: true,
      date: new Date(),
    },
  ]);
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
      rawMessage(user.address),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accepted: 1,
      rejected: 0,
      results: [{ recipient: user.address, status: 'delivered' }],
    });
    expect(mockStoreIncomingMessage).toHaveBeenCalledTimes(1);

    // The parsed MIME reaches the service intact; the service is what decides
    // where it lands and what gets announced.
    const stored = mockStoreIncomingMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(stored).toEqual(
      expect.objectContaining({
        recipientUsername: user.username,
        subject: 'Hello there',
        from: { name: 'Alice Sender', address: 'alice@example.com' },
      }),
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
      rawMessage('ghost@oxy.so'),
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
      rawMessage(user.address),
    );

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
  });

  it('answers a missing envelope recipient with a 400 and its reason', async () => {
    const res = await postRaw(
      server,
      '/email/inbound',
      { authorization: `Bearer ${TEST_WEBHOOK_SECRET}` },
      rawMessage('nobody@oxy.so'),
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing X-Envelope-To header' });
    expect(mockStoreIncomingMessage).not.toHaveBeenCalled();
  });

  it('answers spam with a 400 and its reason, storing nothing', async () => {
    const user = await recipient();
    mockSpamCheck.mockResolvedValueOnce({ score: 20, action: 'reject' });
    mockSpamShouldReject.mockReturnValueOnce(true);

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': user.address,
      },
      rawMessage(user.address),
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Message rejected as spam' });
    expect(mockStoreIncomingMessage).not.toHaveBeenCalled();
  });

  it('answers a delivery that failed transiently with a 503, so Cloudflare retries', async () => {
    const user = await recipient();
    mockStoreIncomingMessage.mockRejectedValueOnce(new Error('connection terminated'));

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': user.address,
      },
      rawMessage(user.address),
    );

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      accepted: 0,
      rejected: 1,
      results: [{ recipient: user.address, status: 'failed' }],
    });
  });

  it('answers a recipient deleted since the lookup with a 422, not a retry', async () => {
    const user = await recipient();
    mockStoreIncomingMessage.mockRejectedValueOnce(new NotFoundError('Recipient user not found'));

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': user.address,
      },
      rawMessage(user.address),
    );

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      accepted: 0,
      rejected: 1,
      results: [{ recipient: user.address, status: 'failed' }],
    });
  });

  it('answers a recipient over quota with a 422, so the sender gets a bounce', async () => {
    const user = await recipient();
    mockStoreIncomingMessage.mockRejectedValueOnce(
      new BadRequestError('Email storage quota exceeded'),
    );

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': user.address,
      },
      rawMessage(user.address),
    );

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      accepted: 0,
      rejected: 1,
      results: [{ recipient: user.address, status: 'failed' }],
    });
  });

  it('retries the whole envelope when any recipient failed transiently', async () => {
    // A retry is safe for the recipient that already has the message: the
    // service answers a known Message-ID with the stored copy.
    const full = await recipient();
    const flaky = await recipient();
    mockStoreIncomingMessage
      .mockRejectedValueOnce(new BadRequestError('Email storage quota exceeded'))
      .mockRejectedValueOnce(new Error('connection terminated'));

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': `${full.address}, ${flaky.address}`,
      },
      rawMessage(full.address),
    );

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      accepted: 0,
      rejected: 2,
      results: [
        { recipient: full.address, status: 'failed' },
        { recipient: flaky.address, status: 'failed' },
      ],
    });
  });

  it('delivers once to an address the envelope repeats', async () => {
    const user = await recipient();
    mockStoreIncomingMessage.mockResolvedValueOnce({ id: unique() });

    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': `${user.address}, ${user.address.toUpperCase()}`,
      },
      rawMessage(user.address),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accepted: 1,
      rejected: 0,
      results: [{ recipient: user.address, status: 'delivered' }],
    });
    expect(mockStoreIncomingMessage).toHaveBeenCalledTimes(1);
  });

  it('delivers to several accounts at once, reporting them in envelope order', async () => {
    const users3 = [await recipient(), await recipient(), await recipient()];
    const pending = new Map<string, () => void>();
    mockStoreIncomingMessage.mockImplementation(
      ({ recipientUsername }: { recipientUsername: string }) =>
        new Promise((resolve) => {
          pending.set(recipientUsername, () => resolve({ id: unique() }));
        }),
    );

    const response = postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': users3.map((u) => u.address).join(', '),
      },
      rawMessage(users3[0].address),
    );
    // All three are in flight before any of them is stored.
    for (let i = 0; i < 200 && pending.size < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(pending.size).toBe(3);
    // Stored last-first; reported first-first.
    for (const user of [...users3].reverse()) pending.get(user.username)?.();

    const res = await response;
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual(
      users3.map((u) => ({ recipient: u.address, status: 'delivered' })),
    );
  });

  it('delivers to two addresses of ONE account one after the other', async () => {
    // `bob+a@` and `bob+b@` are one mailbox: the second delivery must find
    // the first's copy by its Message-ID, not race it to an insert.
    const user = await recipient();
    const other = await recipient();
    let inFlightForUser = 0;
    let peakForUser = 0;
    mockStoreIncomingMessage.mockImplementation(
      async ({ recipientUsername }: { recipientUsername: string }) => {
        if (recipientUsername === user.username) {
          inFlightForUser++;
          peakForUser = Math.max(peakForUser, inFlightForUser);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (recipientUsername === user.username) inFlightForUser--;
        return { id: unique() };
      },
    );

    const plusA = `${user.username}+a@oxy.so`;
    const plusB = `${user.username}+b@oxy.so`;
    const res = await postRaw(
      server,
      '/email/inbound',
      {
        authorization: `Bearer ${TEST_WEBHOOK_SECRET}`,
        'x-envelope-to': `${plusA}, ${other.address}, ${plusB}`,
      },
      rawMessage(plusA),
    );

    expect(res.status).toBe(200);
    expect(peakForUser).toBe(1);
    expect(res.body.results).toEqual([
      { recipient: plusA, status: 'delivered' },
      { recipient: other.address, status: 'delivered' },
      { recipient: plusB, status: 'delivered' },
    ]);
    expect(
      mockStoreIncomingMessage.mock.calls
        .map(([params]) => (params as { aliasTag?: string }).aliasTag)
        .filter(Boolean),
    ).toEqual(['a', 'b']);
  });

  // The shared-secret guard is NOT asserted here: `verifyEmailInboundWebhookSecret`
  // is exported separately and mounted by `server.ts` ahead of this router, so
  // a test that stands this router up alone can only ever observe it passing.
  // Asserting a 401 against this harness would be a check that cannot fail for
  // the reason it claims to.
});
