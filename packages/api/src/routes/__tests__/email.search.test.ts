/**
 * GET /email/search — read-state operator contract.
 *
 * This exercises the mounted route rather than only calling the controller so
 * query-string parsing and the authenticated email router stay covered.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const TEST_USER_ID = '64b0000000000000000000aa';
const mockSearchMessages = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: TEST_USER_ID };
    next();
  },
}));

jest.mock('../../services/email.service', () => ({
  emailService: {
    searchMessages: (...args: unknown[]) => mockSearchMessages(...args),
  },
}));

jest.mock('../../services/smtp.outbound', () => ({ smtpOutbound: {} }));
jest.mock('../../services/assetServiceSingleton', () => ({ assetService: {} }));
jest.mock('../../config/email.config', () => ({ resolveEmailAddress: jest.fn() }));
jest.mock('../../models/User', () => ({ __esModule: true, default: {} }));
jest.mock('../../models/Message', () => ({ Message: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import emailRouter from '../email';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

function getJson(server: http.Server, path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path,
      },
      (res) => {
        let chunks = '';
        res.on('data', (chunk) => { chunks += chunk; });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: chunks.length > 0 ? JSON.parse(chunks) as Record<string, unknown> : {},
            });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use('/email', emailRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchMessages.mockResolvedValue({ data: [], total: 0, limit: 50, offset: 0 });
});

describe('GET /email/search read-state operators', () => {
  it('accepts is:unread and passes seen=false to the service', async () => {
    const response = await getJson(server, '/email/search?q=is%3Aunread');

    expect(response.status).toBe(200);
    expect(mockSearchMessages).toHaveBeenCalledWith(
      TEST_USER_ID,
      '',
      expect.objectContaining({ seen: false }),
    );
  });

  it('accepts is:read and preserves adjacent text search', async () => {
    const response = await getJson(server, '/email/search?q=invoice%20is%3Aread');

    expect(response.status).toBe(200);
    expect(mockSearchMessages).toHaveBeenCalledWith(
      TEST_USER_ID,
      'invoice',
      expect.objectContaining({ seen: true }),
    );
  });

  it('rejects conflicting or repeated q values', async () => {
    const conflict = await getJson(server, '/email/search?q=is%3Aunread%20is%3Aread');
    const repeated = await getJson(server, '/email/search?q=is%3Aunread&q=is%3Aread');

    expect(conflict.status).toBe(400);
    expect(repeated.status).toBe(400);
    expect(mockSearchMessages).not.toHaveBeenCalled();
  });
});
