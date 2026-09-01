/**
 * `POST /email/inbound` — the request body must be a real Buffer.
 *
 * The handler used to bind `req.body as Buffer` and gate on `.length === 0`.
 * The cast is not a check, and TWO different shapes reach it that are not
 * Buffers, on both of which `.length` is `undefined` and `undefined === 0` is
 * false — so the emptiness guard passed and a non-Buffer flowed on to the spam
 * check and `simpleParser`:
 *
 *   1. A request carrying NO body at all. body-parser's `raw` assigns `{}`
 *      rather than an empty Buffer when `typeis.hasBody(req)` is false, so this
 *      is reachable today against the production wiring — no drift required.
 *      Node's own `http.request` cannot produce it (it adds
 *      `Transfer-Encoding: chunked` on `end()`, which makes `hasBody` true), so
 *      the request is written onto a raw socket here.
 *   2. The parser ordering drifting so the global JSON parser wins. AGENTS.md
 *      calls that ordering out as fragile ("if any drifts, inbound mail
 *      silently disappears"); a JSON array body even carries a plausible
 *      `.length`.
 *
 * Every case seeds a REAL recipient. Without one the route short-circuits at
 * "No valid recipients found" — also a 400 — and a test asserting only the
 * status could not tell the guard working from the guard being absent.
 */

import express from 'express';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

const TEST_WEBHOOK_SECRET = 'test-inbound-secret';
process.env.EMAIL_INBOUND_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

const mockStoreIncomingMessage = jest.fn();
const mockSpamCheck = jest.fn();
const mockSpamShouldReject = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('../../utils/socket', () => ({
  getIO: () => null,
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
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import emailInboundRouter from '../emailInbound';
import { errorHandler } from '../../middleware/errorHandler';

const unique = () => randomUUID().replace(/-/g, '');

interface ParsedResponse {
  status: number;
  body: { error?: string; accepted?: number };
}

function port(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

/**
 * Write an HTTP request onto a raw socket, so the request line and headers are
 * exactly what this test says they are. `http.request` cannot express "POST
 * with no body framing at all" — it always adds `Content-Length` or
 * `Transfer-Encoding` — and that framing is the whole point of case 1.
 */
function rawSocketRequest(server: http.Server, requestText: string): Promise<ParsedResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port(server), '127.0.0.1', () => {
      socket.write(requestText);
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { raw += chunk; });
    socket.on('error', reject);
    socket.on('end', () => {
      const separator = raw.indexOf('\r\n\r\n');
      if (separator === -1) {
        reject(new Error(`malformed response: ${raw}`));
        return;
      }
      const statusLine = raw.slice(0, raw.indexOf('\r\n'));
      const status = Number(statusLine.split(' ')[1]);
      const body = raw.slice(separator + 4);
      try {
        // The body is chunked when express writes it without a length, so take
        // the JSON object out of whatever framing surrounds it.
        const start = body.indexOf('{');
        const finish = body.lastIndexOf('}');
        resolve({
          status,
          body: start === -1 ? {} : JSON.parse(body.slice(start, finish + 1)),
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

function postJson(server: http.Server, headers: Record<string, string>, payload: unknown): Promise<ParsedResponse> {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: port(server),
        path: '/email/inbound',
        headers: { 'content-type': 'application/json', 'content-length': body.length, ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function postRaw(server: http.Server, headers: Record<string, string>, body: Buffer): Promise<ParsedResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: port(server),
        path: '/email/inbound',
        headers: { 'content-type': 'message/rfc822', 'content-length': body.length, ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** The production wiring: `express.raw` ahead of the router. */
let rawServer: http.Server;
/** The drifted wiring: the global JSON parser wins for this path. */
let jsonServer: http.Server;

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

beforeAll(async () => {
  await connectPostgres();

  const withRaw = express();
  withRaw.use('/email/inbound', express.raw({ type: '*/*', limit: '25mb' }));
  withRaw.use('/email/inbound', emailInboundRouter);
  withRaw.use(errorHandler);
  rawServer = await listen(withRaw);

  const withJson = express();
  withJson.use('/email/inbound', express.json({ limit: '1mb' }));
  withJson.use('/email/inbound', emailInboundRouter);
  withJson.use(errorHandler);
  jsonServer = await listen(withJson);
});

afterAll(async () => {
  await Promise.all(
    [rawServer, jsonServer].map(
      (server) => new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
    )
  );
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSpamCheck.mockResolvedValue({ score: 0, action: 'no action' });
  mockSpamShouldReject.mockReturnValue(false);
});

/** A real account, so the route gets past its recipient lookup. */
async function recipient(): Promise<string> {
  const username = `bob${unique().slice(0, 10)}`;
  await getDb().insert(users).values({ username, color: 'teal' });
  return `${username}@oxy.so`;
}

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
      'Body text.',
      '',
    ].join('\r\n'),
    'utf8'
  );
}

describe('POST /email/inbound body type', () => {
  it('rejects a bodyless request, which body-parser hands over as {} and not as an empty Buffer', async () => {
    const address = await recipient();

    const response = await rawSocketRequest(
      rawServer,
      [
        'POST /email/inbound HTTP/1.1',
        'Host: 127.0.0.1',
        `Authorization: Bearer ${TEST_WEBHOOK_SECRET}`,
        `X-Envelope-To: ${address}`,
        'X-Envelope-From: alice@example.com',
        'Connection: close',
        '',
        '',
      ].join('\r\n')
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Empty message body');
    // The discriminating assertions. The recipient above resolves, so without
    // the type check the request runs ON: `{}` reaches the spam service and
    // then `simpleParser`. A 400 alone cannot tell that apart from the
    // "no valid recipients" 400.
    expect(mockSpamCheck).not.toHaveBeenCalled();
    expect(mockStoreIncomingMessage).not.toHaveBeenCalled();
  });

  it('rejects a parsed JSON array body when the parser ordering has drifted', async () => {
    const address = await recipient();

    const response = await postJson(
      jsonServer,
      { authorization: `Bearer ${TEST_WEBHOOK_SECRET}`, 'x-envelope-to': address },
      ['not a MIME message']
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Empty message body');
    expect(mockSpamCheck).not.toHaveBeenCalled();
    expect(mockStoreIncomingMessage).not.toHaveBeenCalled();
    // A parser that is not the one this route was mounted with is a
    // misconfiguration, not routine input — it says so on the way out.
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('raw body parser did not run'),
      undefined,
      expect.objectContaining({ bodyType: 'array' })
    );
  });

  it('rejects a parsed JSON object body when the parser ordering has drifted', async () => {
    const address = await recipient();

    const response = await postJson(
      jsonServer,
      { authorization: `Bearer ${TEST_WEBHOOK_SECRET}`, 'x-envelope-to': address },
      { subject: 'nope' }
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Empty message body');
    expect(mockSpamCheck).not.toHaveBeenCalled();
    expect(mockStoreIncomingMessage).not.toHaveBeenCalled();
  });

  it('still rejects a genuinely empty Buffer', async () => {
    const address = await recipient();

    const response = await postRaw(
      rawServer,
      { authorization: `Bearer ${TEST_WEBHOOK_SECRET}`, 'x-envelope-to': address },
      Buffer.alloc(0)
    );

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Empty message body');
    expect(mockSpamCheck).not.toHaveBeenCalled();
  });

  it('still accepts a real Buffer body', async () => {
    const address = await recipient();
    mockStoreIncomingMessage.mockResolvedValueOnce({ id: unique(), mailboxId: unique() });

    const response = await postRaw(
      rawServer,
      { authorization: `Bearer ${TEST_WEBHOOK_SECRET}`, 'x-envelope-to': address },
      rawMessage(address)
    );

    // The vacuity floor: a guard that rejected everything would pass every
    // assertion above.
    expect(response.status).toBe(200);
    expect(response.body.accepted).toBe(1);
    expect(mockSpamCheck).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(mockSpamCheck.mock.calls[0][0])).toBe(true);
  });
});
