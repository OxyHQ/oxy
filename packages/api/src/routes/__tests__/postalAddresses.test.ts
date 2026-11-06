import express from 'express';
import jwt from 'jsonwebtoken';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { applications, users } from '../../db/schema';
import request from 'supertest';
const mockList = jest.fn();
const mockSave = jest.fn();
jest.mock('../../db/postalAddresses', () => ({
  listPostalAddresses: (...args: unknown[]) => mockList(...args),
  savePostalAddress: (...args: unknown[]) => mockSave(...args),
  deletePostalAddress: jest.fn(),
}));
jest.mock('../../services/externalMcpMediaRequester.service', () => ({
  hasExternalMcpMediaProof: jest.fn(),
  resolveExternalMcpMediaRequest: jest.fn(),
}));
const mockValidateSession = jest.fn();
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { validateSession: (...args: unknown[]) => mockValidateSession(...args) },
}));
const originalSecret = process.env.ACCESS_TOKEN_SECRET;
const tokenSecret = 'postal-addresses-session-test-secret';
const ownerToken = jwt.sign({ sessionId: 'session', userId: 'actor-person' }, tokenSecret);
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = tokenSecret;
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
  if (originalSecret === undefined) delete process.env.ACCESS_TOKEN_SECRET;
  else process.env.ACCESS_TOKEN_SECRET = originalSecret;
});
import router from '../postalAddresses';
const app = express();
app.use(express.json());
app.use('/addresses', router);
beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockValidateSession.mockResolvedValue({
    user: { _id: 'active-account', id: 'public-key' },
    token: { actorAccountId: 'actor-person', subjectAccountId: 'active-account' },
  });
});
it('refuses anonymous and service calls before reading private data', async () => {
  expect((await request(app).get('/addresses')).status).toBe(401);
  expect((await request(app).get('/addresses').set('Authorization', 'Bearer service')).status).toBe(
    401,
  );
  expect(mockList).not.toHaveBeenCalled();
});
it('reads the active account only and sends no-store', async () => {
  const res = await request(app)
    .get('/addresses?userId=other')
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('private, no-store');
  expect(mockList).toHaveBeenCalledWith('active-account');
});
it('refuses ownership injection before mutation', async () => {
  const res = await request(app)
    .post('/addresses')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      recipientName: 'Recipient',
      line1: 'Road',
      city: 'City',
      postalCode: '',
      country: 'IE',
      userId: 'other',
    });
  expect(res.status).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});
it('does not expose a database exception containing private postal values', async () => {
  mockList.mockRejectedValueOnce(new Error('query failed: secret-home-address'));
  const res = await request(app).get('/addresses').set('Authorization', `Bearer ${ownerToken}`);
  expect(res.status).toBe(503);
  expect(JSON.stringify(res.body)).not.toContain('secret-home-address');
});

it('refuses a live third-party application and never reads private addresses', async () => {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  if (!owner) throw new Error('Missing owner');
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: 'Address external test',
      ownerAccountId: owner.id,
      type: 'third_party',
      status: 'active',
      isOfficial: false,
    })
    .returning({ id: applications.id });
  if (!application) throw new Error('Missing application');
  mockValidateSession.mockResolvedValue({
    user: { _id: owner.id },
    token: { applicationId: application.id },
  });
  const res = await request(app).get('/addresses').set('Authorization', `Bearer ${ownerToken}`);
  expect(res.status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});
