/**
 * `POST /auth/email/verify/{start,confirm}` (ADR 0030) against a REAL
 * Postgres: the code goes only where it may, every other case is a decoy that
 * answers the same, codes are capped and expire, and a confirmed code is a
 * one-use ticket stored only as its hash.
 *
 * The mail module is mocked at its boundary so the test sees exactly what would
 * be sent, and to whom; the relay list is mocked so "not configured" can be
 * driven.
 */

process.env.DEVICE_ID_SALT = 'account-email-test-device-id-salt-0123456789';

import express from 'express';
import http from 'http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

const mockSendCode = jest.fn();
const mockSendNotice = jest.fn();
let mockRelays: { name: string }[] = [{ name: 'test-relay' }];

jest.mock('../../services/accountEmail.mail', () => ({
  sendVerificationCode: (...args: unknown[]) => mockSendCode(...args),
  sendAccountExistsNotice: (...args: unknown[]) => mockSendNotice(...args),
}));
jest.mock('../../config/email.config', () => ({
  get SMTP_RELAYS() {
    return mockRelays;
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { emailTicketSchema } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { resetOriginRegistryForTests, setOriginSnapshotForTests } from '../../config/dynamicOriginRegistry';
import { emailVerifications } from '../../db/schema/emailVerifications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { EMAIL_SENDS_PER_HOUR } from '../../services/accountEmail.service';
import { hashEmail } from '../../utils/contactHash';
import accountEmailRouter from '../accountEmail';

const AUTH_ORIGIN = 'https://auth.oxy.so';

let server: http.Server;

async function post(path: string, body: unknown, origin: string | null = AUTH_ORIGIN) {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/auth/email${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function freshEmail(): string {
  return `${randomUUID()}@example.com`;
}

function freshUsername(): string {
  return `em${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** The code the (mocked) mail was handed for `to`. */
function sentCode(to: string): string {
  const call = mockSendCode.mock.calls.find(([address]) => address === to);
  if (!call) throw new Error(`no code was sent to ${to}`);
  return call[1] as string;
}

async function storedVerification(id: string) {
  const [row] = await getDb().select().from(emailVerifications).where(eq(emailVerifications.id, id)).limit(1);
  return row;
}

async function start(body: unknown) {
  const res = await post('/verify/start', body);
  expect(res.status).toBe(200);
  return res.body as { verificationId: string; expiresAt: number };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/auth/email', accountEmailRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closePostgres();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRelays = [{ name: 'test-relay' }];
  mockSendCode.mockResolvedValue(undefined);
  mockSendNotice.mockResolvedValue(undefined);
});

describe('sign-up', () => {
  it('sends a 6-digit code to the new email and stores neither the address nor the code', async () => {
    const email = freshEmail();
    const { verificationId, expiresAt } = await start({ purpose: 'signup', email: email.toUpperCase() });

    expect(mockSendCode).toHaveBeenCalledWith(email, expect.stringMatching(/^\d{6}$/));
    expect(expiresAt).toBeGreaterThan(Date.now());
    const row = await storedVerification(verificationId);
    expect(row).toMatchObject({ purpose: 'signup', emailHash: hashEmail(email), userId: null, attempts: 0, confirmedAt: null });
    expect(JSON.stringify(row)).not.toContain(email);
    expect(row.codeHash).not.toContain(sentCode(email));
  });

  it('confirms the right code into a one-use ticket stored as its hash', async () => {
    const email = freshEmail();
    const { verificationId } = await start({ purpose: 'signup', email });

    const res = await post('/verify/confirm', { verificationId, code: sentCode(email) });

    expect(res.status).toBe(200);
    expect(emailTicketSchema.safeParse(res.body.ticket).success).toBe(true);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'ticket']);
    const row = await storedVerification(verificationId);
    expect(row.confirmedAt).toBeInstanceOf(Date);
    expect(row.ticketHash).toBe(createHash('sha256').update(res.body.ticket as string).digest('hex'));

    // A confirmed code cannot be confirmed again.
    const again = await post('/verify/confirm', { verificationId, code: sentCode(email) });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe('EMAIL_CODE_INVALID');
  });

  it('counts wrong codes and stops at the cap, even for the right code afterwards', async () => {
    const email = freshEmail();
    const { verificationId } = await start({ purpose: 'signup', email });
    const right = sentCode(email);
    const wrong = right === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const res = await post('/verify/confirm', { verificationId, code: wrong });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('EMAIL_CODE_INVALID');
    }
    const fifth = await post('/verify/confirm', { verificationId, code: wrong });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error).toBe('EMAIL_CODE_TOO_MANY_ATTEMPTS');

    const late = await post('/verify/confirm', { verificationId, code: right });
    expect(late.status).toBe(429);
    expect((await storedVerification(verificationId)).confirmedAt).toBeNull();
  });

  it('refuses an expired code', async () => {
    const email = freshEmail();
    const { verificationId } = await start({ purpose: 'signup', email });
    await getDb()
      .update(emailVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerifications.id, verificationId));

    const res = await post('/verify/confirm', { verificationId, code: sentCode(email) });
    expect(res.status).toBe(401);
  });

  it('answers the same for an email that already has an account — and sends a notice, not a code', async () => {
    const email = freshEmail();
    await getDb().insert(users).values({ email });

    const res = await post('/verify/start', { purpose: 'signup', email });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'verificationId']);
    expect(mockSendCode).not.toHaveBeenCalled();
    expect(mockSendNotice).toHaveBeenCalledWith(email);
    // The decoy's code was never sent, so nothing confirms it.
    const guess = await post('/verify/confirm', { verificationId: res.body.verificationId, code: '123456' });
    expect(guess.status).toBe(401);
  });

  it('limits the codes one address is sent per hour — without ever saying so', async () => {
    const email = freshEmail();
    for (let send = 0; send < EMAIL_SENDS_PER_HOUR; send += 1) {
      await start({ purpose: 'signup', email });
    }
    // Over budget: the same 200 and the same shape, a decoy, and no mail.
    const res = await post('/verify/start', { purpose: 'signup', email });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'verificationId']);
    expect(mockSendCode).toHaveBeenCalledTimes(EMAIL_SENDS_PER_HOUR);
    expect((await storedVerification(res.body.verificationId as string)).userId).toBeNull();
  });
});

describe('no recovery purpose', () => {
  it('refuses a recovery request: recovering an account is signing in by email (ADR 0030)', async () => {
    const res = await post('/verify/start', { purpose: 'recovery', identifier: freshUsername() });
    expect(res.status).toBe(400);
    expect(mockSendCode).not.toHaveBeenCalled();
  });
});

describe('the gate', () => {
  afterEach(() => resetOriginRegistryForTests());

  it('refuses a site that is not an official Oxy app', async () => {
    setOriginSnapshotForTests(['https://mention.earth'], ['https://third-party.example']);
    for (const origin of ['https://third-party.example', 'https://evil.example']) {
      const res = await post('/verify/start', { purpose: 'signup', email: freshEmail() }, origin);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('SIGNIN_ORIGIN_NOT_ALLOWED');
    }
    expect(mockSendCode).not.toHaveBeenCalled();
  });

  it('accepts an official app, auth.oxy.so, and a native app (no browser origin)', async () => {
    setOriginSnapshotForTests(['https://mention.earth'], []);
    for (const origin of ['https://mention.earth', AUTH_ORIGIN, null]) {
      const res = await post('/verify/start', { purpose: 'signup', email: freshEmail() }, origin);
      expect(res.status).toBe(200);
    }
  });

  it('answers 503 when this server cannot send mail, before anything is recorded', async () => {
    mockRelays = [];
    const res = await post('/verify/start', { purpose: 'signup', email: freshEmail() });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('EMAIL_UNAVAILABLE');
  });

  it('refuses a malformed request', async () => {
    expect((await post('/verify/start', { purpose: 'signup', email: 'nope' })).status).toBe(400);
    expect((await post('/verify/confirm', { verificationId: 'x', code: '12' })).status).toBe(400);
  });
});
