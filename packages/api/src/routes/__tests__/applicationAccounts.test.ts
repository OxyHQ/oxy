/** The workload boundary of `/application-accounts/self`, against a real Postgres. */
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';

let principal: Record<string, unknown> | undefined;
jest.mock('../../middleware/auth', () => ({
  serviceAuthMiddleware: (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
    req.serviceApp = principal;
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import router from '../applicationAccounts';

const app = express();
app.use(express.json());
app.use('/application-accounts', router);
app.use(errorHandler);
beforeAll(connectPostgres);
afterAll(closePostgres);

it('serves the calling first-party deployment only, and refuses everyone else', async () => {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  const [mine, other] = await getDb()
    .insert(applications)
    .values([
      { name: `synthetic-${randomUUID()}`, ownerAccountId: owner?.id ?? '' },
      { name: `synthetic-${randomUUID()}`, ownerAccountId: owner?.id ?? '' },
    ])
    .returning();
  const [person] = await getDb().insert(users).values({ color: 'teal' }).returning();
  if (!mine || !other || !person) throw new Error('fixture');

  principal = { authority: 'first_party', appId: mine.id };
  const registered = await request(app)
    .post('/application-accounts/self/registrations')
    // A client-supplied application is a schema violation, not a way to cross deployments.
    .send({ accountIds: [person.id], applicationId: other.id });
  expect(registered.status).toBe(400);
  const ok = await request(app)
    .post('/application-accounts/self/registrations')
    .send({ accountIds: [person.id] });
  expect(ok.body).toEqual({ registered: 1 });
  const total = await request(app).get('/application-accounts/self/total');
  expect(total.status).toBe(200);
  expect(total.body).toMatchObject({ applicationId: mine.id, total: 1, exact: true, stale: false });
  expect(total.headers['cache-control']).toBe('no-store');

  principal = { authority: 'first_party', appId: other.id };
  expect((await request(app).get('/application-accounts/self/total')).body.total).toBe(0);

  for (const rejected of [{ authority: 'external', appId: mine.id }, undefined]) {
    principal = rejected;
    expect((await request(app).get('/application-accounts/self/total')).status).toBe(403);
    expect(
      (
        await request(app)
          .post('/application-accounts/self/registrations')
          .send({ accountIds: [person.id] })
      ).status,
    ).toBe(403);
  }
});
