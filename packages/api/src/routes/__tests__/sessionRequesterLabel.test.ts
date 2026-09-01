/**
 * The COARSE requester label persisted by `POST /auth/session/create`, against a
 * REAL Postgres.
 *
 * The approval screen shows the approver WHERE a sign-in request came from
 * ("Chrome on Windows"). The label is the ENTIRE descriptor: it is derived
 * server-side from the request's own User-Agent — never from the QR / deep-link
 * payload, which is requester-controlled — and no raw User-Agent, IP, country or
 * geolocation is persisted anywhere on this path (the platform-wide
 * no-IP-at-rest invariant).
 *
 * The previous version asserted against the object handed to a mocked
 * `AuthSession.create`. Reading the STORED row is what actually proves nothing
 * else was written: the mock could only ever show what the call site intended.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: jest.fn(), getAccessToken: jest.fn() },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({ broadcastSessionAccountsChanged: jest.fn() }));
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter from '../auth';

const CHROME_WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36';
const FIREFOX_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0';
/** No browser token at all — what a native Expo client sends. */
const NATIVE_UA = 'OxyApp/1.4.0 CFNetwork/1494.0.7 Darwin/23.4.0';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;
let clientId: string;

function post(path: string, body: unknown, headers: Record<string, string>): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function createSession(
  headers: Record<string, string>,
): Promise<{ res: JsonResponse; sessionToken: string }> {
  const sessionToken = `at_${randomUUID().replace(/-/g, '')}`;
  const res = await post('/auth/session/create', { sessionToken, clientId }, headers);
  return { res, sessionToken };
}

/** The STORED row, with every column — this is what "persists nothing else" means. */
async function stored(sessionToken: string): Promise<Record<string, unknown>> {
  const [row] = await getDb()
    .select()
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);
  return row as unknown as Record<string, unknown>;
}

beforeAll(async () => {
  await connectPostgres();
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      ownerAccountId: owner.id,
      type: 'third_party',
      redirectUris: ['https://acme.example/cb'],
    })
    .returning({ id: applications.id });
  clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: app.id,
    name: 'client',
    publicKey: clientId,
    type: 'public',
    environment: 'production',
  });

  const server_ = express();
  server_.use(express.json());
  server_.use('/auth', authRouter);
  server_.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = server_.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

describe('POST /auth/session/create — the coarse requester label', () => {
  it('persists a coarse browser/OS label for a browser caller', async () => {
    const { res, sessionToken } = await createSession({
      'user-agent': CHROME_WINDOWS_UA,
      origin: 'https://acme.example',
    });

    expect(res.status).toBe(200);
    expect((await stored(sessionToken)).requesterLabel).toBe('Chrome on Windows');
  });

  it('derives the label from the OS too (Firefox on macOS)', async () => {
    const { res, sessionToken } = await createSession({
      'user-agent': FIREFOX_MAC_UA,
      origin: 'https://acme.example',
    });

    expect(res.status).toBe(200);
    expect((await stored(sessionToken)).requesterLabel).toBe('Firefox on macOS');
  });

  it('NEVER persists the raw User-Agent — only the coarse label', async () => {
    const { sessionToken } = await createSession({
      'user-agent': CHROME_WINDOWS_UA,
      origin: 'https://acme.example',
    });

    const row = await stored(sessionToken);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(CHROME_WINDOWS_UA);
    // No version, engine, or architecture detail survives the derivation.
    expect(serialized).not.toContain('126.0.6478.127');
    expect(serialized).not.toContain('AppleWebKit');
    expect(serialized).not.toContain('Win64');
    expect(Object.keys(row)).not.toContain('userAgent');
  });

  it('persists NO ip address, location, or country anywhere on the path', async () => {
    const { sessionToken } = await createSession({
      'user-agent': CHROME_WINDOWS_UA,
      origin: 'https://acme.example',
      'cf-ipcountry': 'ES',
      'x-forwarded-for': '203.0.113.7',
    });

    const row = await stored(sessionToken);
    // The COLUMN SET itself carries no such field — this is the invariant, and
    // it is now a schema property rather than a call-site discipline.
    expect(Object.keys(row).filter((key) => /ip|location|country|geo/i.test(key))).toEqual([]);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('203.0.113.7');
  });

  it('persists NULL for a NATIVE caller (no browser context)', async () => {
    const { res, sessionToken } = await createSession({ 'user-agent': NATIVE_UA });

    expect(res.status).toBe(200);
    expect((await stored(sessionToken)).requesterLabel).toBeNull();
  });

  it('persists NULL when there is no browser context, even for a browser-shaped UA', async () => {
    // No Origin and no Referer: nothing here proves a browser, so no label is
    // invented from a header the caller fully controls.
    const { res, sessionToken } = await createSession({ 'user-agent': CHROME_WINDOWS_UA });

    expect(res.status).toBe(200);
    expect((await stored(sessionToken)).requesterLabel).toBeNull();
  });

  it('persists NULL for an unrecognisable User-Agent in a browser context', async () => {
    const { sessionToken } = await createSession({
      'user-agent': 'x',
      origin: 'https://acme.example',
    });

    expect((await stored(sessionToken)).requesterLabel).toBeNull();
  });

  it('never echoes the label back to the REQUESTER — it is for the approver only', async () => {
    const { res } = await createSession({
      'user-agent': CHROME_WINDOWS_UA,
      origin: 'https://acme.example',
    });

    expect(JSON.stringify(res.body)).not.toContain('Chrome on Windows');
  });
});
