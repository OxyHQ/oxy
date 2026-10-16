/**
 * `GET /platform-stats/stream` caps concurrent SSE viewers. The one past the cap
 * is refused like every other limit in oxy-api: 429, `Retry-After` and the typed
 * `RATE_LIMITED` error (`middleware/rateLimiter.ts`), not a bare message.
 *
 * The counters' own behaviour (and their Postgres) is `platformStats.test.ts`'s;
 * here the database read fails and the stream only logs it, which keeps every
 * viewer's connection open without one.
 */

import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock('../../config/postgres', () => ({
  getDb: () => {
    throw new Error('no database in this suite');
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import platformStatsRouter from '../platform-stats';

/** `MAX_ACTIVE_STATS_STREAMS` in `platform-stats.ts`. */
const MAX_STREAMS = 25;

let server: http.Server;
let baseUrl: string;
const open: http.ClientRequest[] = [];

beforeAll(async () => {
  const app = express();
  app.use('/platform-stats', platformStatsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const request of open) request.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function get(path: string): Promise<{ response: http.IncomingMessage; body: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${baseUrl}${path}`, (response) => {
      const body = new Promise<string>((done) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => done(text));
      });
      resolve({ response, body });
    });
    request.on('error', reject);
    open.push(request);
  });
}

it('refuses the viewer past the cap with the typed RATE_LIMITED error and Retry-After', async () => {
  for (let i = 0; i < MAX_STREAMS; i += 1) {
    const { response } = await get('/platform-stats/stream');
    expect(response.statusCode).toBe(200);
  }

  const { response, body } = await get('/platform-stats/stream');

  expect(response.statusCode).toBe(429);
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  expect(JSON.parse(await body)).toMatchObject({
    error: 'RATE_LIMITED',
    message: 'Too many active platform stats streams',
    details: { retryAfterSeconds: Number(response.headers['retry-after']) },
  });
});
