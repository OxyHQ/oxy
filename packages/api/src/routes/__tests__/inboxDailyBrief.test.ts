/**
 * POST /email/ai/daily-brief at the real router boundary.
 *
 * The SQL service has its own real-Postgres suite. This one pins the glue that
 * could otherwise quietly restore the old behaviour: validation must reject
 * the historical `{}` body, the validated UTC instants must reach the
 * aggregate unchanged, and only its four counts may reach inference.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const TEST_USER_ID = 'daily-brief-user-exact';
const START_AT = '2026-09-02T21:00:00.000Z';
const END_AT = '2026-09-03T21:00:00.000Z';
const COUNTS = {
  total: 137,
  unread: 29,
  starred: 11,
  withAttachments: 17,
} as const;

const mockGetCounts = jest.fn();
const mockExecute = jest.fn();
const mockListMessages = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    request: { user?: { id: string } },
    _response: unknown,
    next: () => void,
  ) => {
    request.user = { id: TEST_USER_ID };
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_request: unknown, _response: unknown, next: () => void) => next(),
}));

jest.mock('../../services/email.service', () => ({
  emailService: {
    listMessages: (...args: unknown[]) => mockListMessages(...args),
  },
}));

jest.mock('../../services/inboxDailyBrief.service', () => ({
  getInboxDailyBriefCounts: (...args: unknown[]) => mockGetCounts(...args),
}));

jest.mock('../../services/inboxInference.service', () => ({
  executeInboxPointInference: (...args: unknown[]) => mockExecute(...args),
  inboxCompletionText: (completion: { text: string }) => completion.text,
  streamInboxPointInference: async function* streamInboxPointInference() {
    return;
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import inboxInferenceRouter from '../inboxInference';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function postJson(server: http.Server, body: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const encoded = Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const request = http.request({
      method: 'POST',
      host: '127.0.0.1',
      port: address.port,
      path: '/daily-brief',
      headers: {
        'content-type': 'application/json',
        'content-length': encoded.length,
      },
    }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end(encoded);
  });
}

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(inboxInferenceRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCounts.mockResolvedValue(COUNTS);
  mockExecute.mockResolvedValue({
    requestId: 'request_daily_brief_exact',
    text: 'Your exact daily brief.',
  });
  mockListMessages.mockRejectedValue(new Error('the paginated read must remain unreachable'));
});

describe('POST /email/ai/daily-brief', () => {
  it('passes the validated UTC interval to PostgreSQL and only four counts to inference', async () => {
    const response = await postJson(server, { startAt: START_AT, endAt: END_AT });

    expect(response).toEqual({
      status: 200,
      body: {
        schemaVersion: 1,
        requestId: 'request_daily_brief_exact',
        text: 'Your exact daily brief.',
      },
    });
    expect(mockGetCounts).toHaveBeenCalledTimes(1);
    expect(mockGetCounts).toHaveBeenCalledWith(
      TEST_USER_ID,
      new Date(START_AT),
      new Date(END_AT),
    );
    expect(mockListMessages).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    const input = mockExecute.mock.calls[0]?.[0] as {
      userId: string;
      feature: string;
      messages: unknown[];
    };
    expect(input.userId).toBe(TEST_USER_ID);
    expect(input.feature).toBe('daily_brief');
    expect(input.messages).toEqual([
      {
        role: 'system',
        content: [{
          type: 'text',
          text: 'Write a warm, efficient daily inbox brief in 2-4 sentences and second person. Use only the supplied aggregate counts; never imply access to senders, subjects, bodies, deadlines or action items.',
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: 'Aggregate counts: {"total":137,"unread":29,"starred":11,"withAttachments":17}',
        }],
      },
    ]);
  });

  it('rejects the historical empty body before PostgreSQL or inference', async () => {
    const response = await postJson(server, {});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'BAD_REQUEST', message: 'Validation failed' });
    expect(mockGetCounts).not.toHaveBeenCalled();
    expect(mockListMessages).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
