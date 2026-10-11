/**
 * POST /email/ai/daily-brief at the real router boundary.
 *
 * The SQL service has its own real-Postgres suite. This one pins the glue that
 * could otherwise quietly restore the old behaviour: validation must reject
 * the historical `{}` body, the validated UTC instants must reach the digest
 * unchanged, the brief is written from that digest in the asked language, and
 * what reaches the client is the model's answer resolved against the digest —
 * never an id, sender or subject the model made up.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const TEST_USER_ID = 'daily-brief-user-exact';
const START_AT = '2026-09-02T21:00:00.000Z';
const END_AT = '2026-09-03T21:00:00.000Z';
function digestMessage(overrides: Record<string, unknown>) {
  return {
    id: 'msg_ana',
    fromName: 'Ana García',
    fromAddress: 'ana@example.test',
    subject: 'Quarterly numbers',
    receivedAt: new Date('2026-09-03T08:00:00.000Z'),
    unread: true,
    starred: false,
    answered: false,
    hasAttachments: false,
    card: null,
    excerpt: 'Can you send me the quarterly numbers by Friday?',
    excerptWithheld: false,
    ...overrides,
  };
}

const DIGEST = {
  today: { received: 2, unread: 1, starred: 0 },
  messages: [
    digestMessage({}),
    digestMessage({
      id: 'msg_code',
      fromName: 'Scaleway',
      fromAddress: 'noreply@scaleway.test',
      subject: 'Use the code 118512 to complete your account setup',
      unread: false,
      excerpt: '',
      excerptWithheld: true,
    }),
  ],
  earlierUnread: {
    total: 1,
    messages: [
      digestMessage({
        id: 'msg_old',
        subject: 'Contract to sign',
        receivedAt: new Date('2026-09-01T09:00:00.000Z'),
      }),
    ],
  },
} as const;

const MODEL_ANSWER = JSON.stringify({
  summary: 'Ana needs the quarterly numbers by Friday; the rest can wait.',
  items: [
    { ref: 'm1', section: 'needs_you', note: 'Wants the quarterly numbers by Friday.' },
    { ref: 'm1', section: 'today', note: 'Named twice: dropped.' },
    { ref: 'm9', section: 'needs_you', note: 'No such message: dropped.' },
    { ref: 'e1', section: 'needs_you', note: 'Still waiting for your signature.' },
  ],
});

const mockGetDigest = jest.fn();
const mockExecute = jest.fn();
const mockListMessages = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (request: { user?: { id: string } }, _response: unknown, next: () => void) => {
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
  ...jest.requireActual('../../services/inboxDailyBrief.service'),
  getInboxDailyBriefDigest: (...args: unknown[]) => mockGetDigest(...args),
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

import { inboxDailyBriefResponseSchema } from '@oxy.so/contracts';
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
    const request = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: '/daily-brief',
        headers: {
          'content-type': 'application/json',
          'content-length': encoded.length,
        },
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
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
  mockGetDigest.mockResolvedValue(DIGEST);
  mockExecute.mockResolvedValue({
    requestId: 'request_daily_brief_exact',
    text: MODEL_ANSWER,
  });
  mockListMessages.mockRejectedValue(new Error('the paginated read must remain unreachable'));
});

describe('POST /email/ai/daily-brief', () => {
  it('passes the validated UTC interval to the digest and answers with the brief as data', async () => {
    const response = await postJson(server, { startAt: START_AT, endAt: END_AT, locale: 'es-ES' });

    expect(response).toEqual({
      status: 200,
      body: {
        schemaVersion: 1,
        requestId: 'request_daily_brief_exact',
        summary: 'Ana needs the quarterly numbers by Friday; the rest can wait.',
        counts: { received: 2, unread: 1, starred: 0, earlierUnread: 1 },
        items: [
          {
            messageId: 'msg_ana',
            section: 'needs_you',
            note: 'Wants the quarterly numbers by Friday.',
            from: { name: 'Ana García', address: 'ana@example.test' },
            subject: 'Quarterly numbers',
            receivedAt: '2026-09-03T08:00:00.000Z',
            unread: true,
            hasAttachments: false,
          },
          {
            // An "e" reference is always earlier mail, whatever section the model chose.
            messageId: 'msg_old',
            section: 'earlier',
            note: 'Still waiting for your signature.',
            from: { name: 'Ana García', address: 'ana@example.test' },
            subject: 'Contract to sign',
            receivedAt: '2026-09-01T09:00:00.000Z',
            unread: true,
            hasAttachments: false,
          },
        ],
      },
    });
    expect(inboxDailyBriefResponseSchema.safeParse(response.body).success).toBe(true);
    expect(mockGetDigest).toHaveBeenCalledWith(TEST_USER_ID, new Date(START_AT), new Date(END_AT));
    expect(mockListMessages).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    const input = mockExecute.mock.calls[0]?.[0] as {
      userId: string;
      feature: string;
      responseFormat: unknown;
      messages: Array<{ role: string; content: Array<{ text: string }> }>;
    };
    expect(input.userId).toBe(TEST_USER_ID);
    expect(input.feature).toBe('daily_brief');
    expect(input.responseFormat).toEqual({ type: 'json_object' });
    const [system, user] = input.messages;
    expect(system?.content[0]?.text).toContain('in Spanish');
    const prompt = user?.content[0]?.text ?? '';
    expect(prompt).toContain('Today in the inbox: 2 received, 1 still unread, 0 starred.');
    expect(prompt).toContain('<message ref="m1">\nFrom: Ana García <ana@example.test>');
    expect(prompt).toContain('Excerpt: Can you send me the quarterly numbers by Friday?');
    expect(prompt).toContain('<message ref="e1">');
    // A code in the subject of a withheld message never reaches the model.
    expect(prompt).toContain('Subject: Use the code •••• to complete your account setup');
    expect(prompt).not.toContain('118512');
  });

  it('writes in English when no locale is sent, and refuses a malformed one', async () => {
    await postJson(server, { startAt: START_AT, endAt: END_AT });
    const input = mockExecute.mock.calls[0]?.[0] as {
      messages: Array<{ content: Array<{ text: string }> }>;
    };
    expect(input.messages[0]?.content[0]?.text).toContain('in English');

    const refused = await postJson(server, {
      startAt: START_AT,
      endAt: END_AT,
      locale: 'es; drop',
    });
    expect(refused.status).toBe(400);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('asks no model on a day with nothing in it', async () => {
    mockGetDigest.mockResolvedValue({
      today: { received: 0, unread: 0, starred: 0 },
      messages: [],
      earlierUnread: { total: 0, messages: [] },
    });

    const response = await postJson(server, { startAt: START_AT, endAt: END_AT });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      schemaVersion: 1,
      summary: '',
      counts: { received: 0, unread: 0, starred: 0, earlierUnread: 0 },
      items: [],
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('fails retryably when the model does not answer with a brief', async () => {
    mockExecute.mockResolvedValue({
      requestId: 'request_prose',
      text: 'Here is your brief: lots of mail.',
    });

    const response = await postJson(server, { startAt: START_AT, endAt: END_AT });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ error: 'INBOX_BRIEF_INVALID' });
  });

  it('refuses the old streamed request', async () => {
    const response = await postJson(server, { startAt: START_AT, endAt: END_AT, stream: true });
    expect(response.status).toBe(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects the historical empty body before PostgreSQL or inference', async () => {
    const response = await postJson(server, {});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'BAD_REQUEST', message: 'Validation failed' });
    expect(mockGetDigest).not.toHaveBeenCalled();
    expect(mockListMessages).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
