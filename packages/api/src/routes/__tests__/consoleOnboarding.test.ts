/**
 * `/console/onboarding`, over real HTTP against a real Postgres. Only the
 * session middleware (it sets the acting user), the rate limiter and the
 * logger are faked.
 */

let actingUserId = '';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: actingUserId, id: actingUserId };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { randomUUID } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { eq } from 'drizzle-orm';
import { CONSOLE_TERMS_VERSION } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { consoleOnboarding } from '../../db/schema/consoleOnboarding';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import consoleOnboardingRouter from '../consoleOnboarding';

let server: http.Server;

async function person(): Promise<string> {
  const username = `u${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const [row] = await insertAccountFixtures(
    { username, kind: 'personal', accountStatus: 'active' },
    { id: users.id },
  );
  return row.id;
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/console/onboarding${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const terms = {
  version: CONSOLE_TERMS_VERSION,
  adultAcknowledged: true,
  aupAcknowledged: true,
  marketingOptIn: false,
};

beforeAll(async () => {
  await connectPostgres();
  const api = express();
  api.use(express.json());
  api.use('/console/onboarding', consoleOnboardingRouter);
  api.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = api.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

beforeEach(async () => {
  actingUserId = await person();
});

describe('GET /console/onboarding', () => {
  it('gives a person with no row the empty state, without creating one', async () => {
    const { status, body } = await call('GET', '');
    expect(status).toBe(200);
    expect(body).toEqual({
      termsVersion: null,
      termsAcceptedAt: null,
      termsCurrent: false,
      marketingOptIn: false,
      useCases: [],
      useCaseDescription: null,
      useCasesAnswered: false,
    });
    const rows = await getDb()
      .select()
      .from(consoleOnboarding)
      .where(eq(consoleOnboarding.userId, actingUserId));
    expect(rows).toHaveLength(0);
  });
});

describe('POST /console/onboarding/terms', () => {
  it('requires both acknowledgements to be true', async () => {
    const { aupAcknowledged: _aup, ...noAup } = terms;
    expect((await call('POST', '/terms', noAup)).status).toBe(400);
    expect((await call('POST', '/terms', { ...terms, aupAcknowledged: false })).status).toBe(400);
    expect((await call('POST', '/terms', { ...terms, adultAcknowledged: false })).status).toBe(400);
    const { adultAcknowledged: _adult, ...noAdult } = terms;
    expect((await call('POST', '/terms', noAdult)).status).toBe(400);
    expect((await call('GET', '')).body.termsCurrent).toBe(false);
  });

  it('refuses a version that is not the current one with 409', async () => {
    const { status } = await call('POST', '/terms', { ...terms, version: '1999-01-01' });
    expect(status).toBe(409);
    expect((await call('GET', '')).body.termsVersion).toBeNull();
  });

  it('records the acceptance and is idempotent on repeat', async () => {
    const first = await call('POST', '/terms', { ...terms, marketingOptIn: true });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      termsVersion: CONSOLE_TERMS_VERSION,
      termsCurrent: true,
      marketingOptIn: true,
    });
    const second = await call('POST', '/terms', terms);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ termsCurrent: true, marketingOptIn: false });
    const rows = await getDb()
      .select()
      .from(consoleOnboarding)
      .where(eq(consoleOnboarding.userId, actingUserId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ adultAcknowledged: true, aupAcknowledged: true });
  });

  it('ignores a userId in the body', async () => {
    const other = await person();
    await call('POST', '/terms', { ...terms, userId: other });
    const rows = await getDb()
      .select()
      .from(consoleOnboarding)
      .where(eq(consoleOnboarding.userId, other));
    expect(rows).toHaveLength(0);
  });
});

describe('POST /console/onboarding/use-cases', () => {
  it('requires the current terms to be accepted first', async () => {
    const { status } = await call('POST', '/use-cases', { useCases: ['ai-models'] });
    expect(status).toBe(409);
    expect((await call('GET', '')).body.useCasesAnswered).toBe(false);
  });

  it('rejects an unknown use-case id and an over-long description with 400', async () => {
    await call('POST', '/terms', terms);
    expect((await call('POST', '/use-cases', { useCases: ['nope'] })).status).toBe(400);
    expect(
      (await call('POST', '/use-cases', { useCases: [], description: 'a'.repeat(2001) })).status,
    ).toBe(400);
  });

  it('stores the choices and a trimmed description, and a skip counts as answered', async () => {
    await call('POST', '/terms', terms);
    const saved = await call('POST', '/use-cases', {
      useCases: ['ai-models', 'publish-apps', 'ai-models'],
      description: '  Building a bot  ',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      useCases: ['ai-models', 'publish-apps'],
      useCaseDescription: 'Building a bot',
      useCasesAnswered: true,
    });
    const skipped = await call('POST', '/use-cases', { useCases: [], description: '   ' });
    expect(skipped.body).toMatchObject({
      useCases: [],
      useCaseDescription: null,
      useCasesAnswered: true,
    });
  });
});

describe('isolation', () => {
  it('keeps one person state away from another', async () => {
    const a = actingUserId;
    await call('POST', '/terms', terms);
    await call('POST', '/use-cases', { useCases: ['billing-credits'], description: 'mine' });
    actingUserId = await person();
    expect((await call('GET', '')).body).toMatchObject({
      termsVersion: null,
      useCases: [],
      useCaseDescription: null,
    });
    actingUserId = a;
    expect((await call('GET', '')).body).toMatchObject({ useCases: ['billing-credits'] });
  });
});
