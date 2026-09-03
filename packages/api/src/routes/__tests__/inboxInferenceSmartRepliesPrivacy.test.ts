import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { MessageDto } from '../../services/email.service';

const USER_ID = 'account_privacy_guard_01';
const MESSAGE_ID = 'message_privacy_guard_01';

const mockGetMessage = jest.fn();
const mockExecuteInboxPointInference = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    request: { user?: { _id: string; id: string; isStaff: boolean } },
    _response: unknown,
    next: () => void,
  ) => {
    request.user = { _id: USER_ID, id: USER_ID, isStaff: false };
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_request: unknown, _response: unknown, next: () => void) => next(),
}));

jest.mock('../../services/email.service', () => ({
  emailService: {
    getMessage: (...args: unknown[]) => mockGetMessage(...args),
  },
}));

jest.mock('../../services/inboxInference.service', () => ({
  executeInboxPointInference: (...args: unknown[]) => mockExecuteInboxPointInference(...args),
  inboxCompletionText: () => JSON.stringify({
    replies: ['Sounds good!', 'See you then.', 'Thanks for confirming.'],
  }),
  streamInboxPointInference: async function* streamInboxPointInference() {
    return undefined;
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import inboxInferenceRouter from '../inboxInference';
import { errorHandler } from '../../middleware/errorHandler';

interface RawResponse {
  status: number;
  body: string;
}

function message(overrides: Partial<MessageDto> = {}): MessageDto {
  const now = new Date('2026-09-03T10:00:00.000Z');
  return {
    _id: MESSAGE_ID,
    id: MESSAGE_ID,
    userId: USER_ID,
    mailboxId: 'mailbox_privacy_guard_01',
    messageId: '<privacy-guard-01@example.com>',
    from: { name: 'Teammate', address: 'teammate@example.com' },
    to: [{ name: 'Test User', address: 'user@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Lunch tomorrow?',
    attachments: [],
    flags: {
      seen: false,
      starred: false,
      answered: false,
      forwarded: false,
      draft: false,
      pinned: false,
    },
    labels: [],
    highlights: [],
    encrypted: false,
    spamScore: null,
    spamAction: null,
    size: 32,
    inReplyTo: null,
    references: [],
    aliasTag: null,
    snoozedUntil: null,
    snoozedFromMailbox: null,
    scheduledAt: null,
    readReceiptRequested: false,
    readReceiptSent: false,
    date: now,
    receivedAt: now,
    createdAt: now,
    updatedAt: now,
    draftRevision: 0,
    text: 'Noon works for me.',
    threadId: 'thread_privacy_guard_01',
    ...overrides,
  };
}

async function postSmartReplies(server: http.Server): Promise<RawResponse> {
  const address = server.address() as AddressInfo;
  const payload = '{}';
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: `/email/ai/messages/${MESSAGE_ID}/smart-replies`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
}

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/email/ai', inboxInferenceRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuteInboxPointInference.mockResolvedValue({ requestId: 'request_privacy_guard_01' });
});

describe('POST /email/ai/messages/:messageId/smart-replies privacy guard', () => {
  it.each([
    ['reset keyword', { subject: 'Reset access', text: 'Use the link below.' }],
    ['verify-your phrase', { subject: 'Action needed', text: 'Please verify your identity.' }],
    ['confirm-account phrase', { subject: 'Action needed', text: 'Confirm your account today.' }],
    ['SSN keyword', { subject: 'Document update', text: 'Your SSN is on file.' }],
    ['formatted SSN without a keyword', { subject: 'Document update', text: 'Identifier: 123-45-6789.' }],
    ['six digits before the security keyword', { subject: 'Sign-in notice', text: '482901 is required to verify.' }],
  ] satisfies ReadonlyArray<readonly [string, Partial<MessageDto>]>)('does not send %s content to inference', async (_name, overrides) => {
    mockGetMessage.mockResolvedValue(message(overrides));

    const response = await postSmartReplies(server);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ replies: [] });
    expect(mockGetMessage).toHaveBeenCalledWith(USER_ID, MESSAGE_ID);
    expect(mockExecuteInboxPointInference).not.toHaveBeenCalled();
  });

  it('still invokes inference for a benign message and returns its replies', async () => {
    mockGetMessage.mockResolvedValue(message());

    const response = await postSmartReplies(server);

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      replies: ['Sounds good!', 'See you then.', 'Thanks for confirming.'],
    });
    expect(mockExecuteInboxPointInference).toHaveBeenCalledTimes(1);
    expect(mockExecuteInboxPointInference).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      feature: 'smart_replies',
      maxOutputTokens: 150,
    }));
  });
});
