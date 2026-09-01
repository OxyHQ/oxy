/**
 * The Inbox inference BFF's actual Express boundary.
 *
 * The route, auth middleware, body validator, async error wrapper and SSE
 * writer are real. Only the session lookup and the service behind the route are
 * replaced: they own persistence and the outbound Oxy edge call respectively.
 */

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const mockValidateSession = jest.fn();
const mockRunInboxInference = jest.fn();
const mockStreamInboxInference = jest.fn();

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    validateSession: (...args: unknown[]) => mockValidateSession(...args),
  },
}));

jest.mock('../../services/inboxInference.service', () => ({
  runInboxInference: (...args: unknown[]) => mockRunInboxInference(...args),
  streamInboxInference: (...args: unknown[]) => mockStreamInboxInference(...args),
}));

jest.mock('../../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import { errorHandler } from '../../middleware/errorHandler';
import emailRouter from '../email';

const ACCESS_TOKEN_SECRET = 'inbox-route-test-access-secret-32-bytes';
const AUTHENTICATED_USER_ID = '01992d9f-fb8c-7000-8000-000000000001';
const originalAccessTokenSecret = process.env.ACCESS_TOKEN_SECRET;

function accessToken(): string {
  return jwt.sign(
    {
      userId: AUTHENTICATED_USER_ID,
      sessionId: '01992d9f-fb8c-7000-8000-000000000002',
      deviceId: 'inbox-route-test-device',
      type: 'access',
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '5m' },
  );
}

const app = express();
app.use(express.json());
app.use('/email', emailRouter);
app.use(errorHandler);

beforeAll(() => {
  process.env.ACCESS_TOKEN_SECRET = ACCESS_TOKEN_SECRET;
});

afterAll(() => {
  if (originalAccessTokenSecret === undefined) delete process.env.ACCESS_TOKEN_SECRET;
  else process.env.ACCESS_TOKEN_SECRET = originalAccessTokenSecret;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateSession.mockResolvedValue({
    user: {
      _id: AUTHENTICATED_USER_ID,
      id: AUTHENTICATED_USER_ID,
      username: 'inbox-route-user',
    },
    token: {
      subjectAccountId: AUTHENTICATED_USER_ID,
      principalUserId: AUTHENTICATED_USER_ID,
      sessionId: '01992d9f-fb8c-7000-8000-000000000002',
      deviceId: 'inbox-route-test-device',
      scopes: [],
    },
  });
});

describe('Inbox inference Express boundary', () => {
  it('requires a real authenticated session before validation or inference', async () => {
    const response = await request(app).post('/email/ai').send({
      feature: 'compose-polish',
      text: 'Hello',
    });

    expect(response.status).toBe(401);
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(mockRunInboxInference).not.toHaveBeenCalled();
  });

  it('rejects client-owned identity and routing fields before inference', async () => {
    const response = await request(app)
      .post('/email/ai')
      .set('Authorization', `Bearer ${accessToken()}`)
      .send({
        feature: 'compose-polish',
        text: 'Hello',
        userId: 'attacker-selected-user',
        model: 'attacker/model',
        routingProfile: 'attacker-profile',
      });

    expect(response.status).toBe(400);
    expect(mockValidateSession).toHaveBeenCalledTimes(1);
    expect(mockRunInboxInference).not.toHaveBeenCalled();
  });

  it('passes only validated product data and the authenticated user to the service', async () => {
    mockRunInboxInference.mockResolvedValue({ text: 'Polished', requestId: 'req_1' });

    const response = await request(app)
      .post('/email/ai')
      .set('Authorization', `Bearer ${accessToken()}`)
      .send({
        feature: 'compose-polish',
        text: '  Hello  ',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { text: 'Polished', requestId: 'req_1' } });
    expect(mockRunInboxInference).toHaveBeenCalledTimes(1);
    expect(mockRunInboxInference).toHaveBeenCalledWith(
      { feature: 'compose-polish', text: 'Hello' },
      AUTHENTICATED_USER_ID,
      expect.any(AbortSignal),
    );
  });

  it('turns a post-open failure into a safe terminal SSE error', async () => {
    const secret = 'credential-sensitive-stream-value';
    mockStreamInboxInference.mockImplementation(() =>
      (async function* () {
        yield {
          schemaVersion: 1,
          type: 'start',
          requestId: 'req_stream',
          sequence: 0,
          resolvedModelReference: 'openai/gpt-5@2026-06-01',
          servingProvider: 'openai',
          startedAt: '2026-09-02T12:00:00.000Z',
        };
        throw new Error(`upstream included ${secret}`);
      })(),
    );

    const response = await request(app)
      .post('/email/ai/stream')
      .set('Authorization', `Bearer ${accessToken()}`)
      .send({
        feature: 'compose-draft',
        prompt: 'Reply about the meeting',
        tone: 'professional',
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache, no-store, no-transform');
    expect(response.text).toContain('event: start');
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('"sequence":1');
    expect(response.text).toContain('"code":"service_unavailable"');
    expect(response.text).not.toContain(secret);
    expect(mockStreamInboxInference).toHaveBeenCalledWith(
      {
        feature: 'compose-draft',
        prompt: 'Reply about the meeting',
        tone: 'professional',
      },
      AUTHENTICATED_USER_ID,
      expect.any(AbortSignal),
    );
  });
});
