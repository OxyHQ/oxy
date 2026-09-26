/**
 * The device-token mint's lockout, with the REAL lockout service and a REAL
 * Postgres device (security review of #1421): attempts are reserved per
 * (device, requester) — a stranger who knows a browser's deviceId locks only
 * their own bucket, never the browser's mint. There is no per-device ceiling.
 */

process.env.DEVICE_ID_SALT = 'mint-lockout-test-device-id-salt-0123456789ab';

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
    res.status(401).json({ error: 'Authentication required' });
  },
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastSessionAccountsChanged: jest.fn(),
  broadcastDeviceState: jest.fn(),
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));

import { closePostgres, connectPostgres } from '../../config/postgres';
import { errorHandler } from '../../middleware/errorHandler';
import deviceSessionService from '../../services/deviceSession.service';
import { _resetInMemoryStateForTests } from '../../services/loginLockout.service';
import sessionDeviceRouter from '../sessionDevice';

let server: http.Server;

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/session/device', sessionDeviceRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closePostgres();
});

beforeEach(() => _resetInMemoryStateForTests());

async function mint(body: { deviceId: string; deviceSecret: string }, clientIp: string) {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/session/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': clientIp },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

describe('the device-token mint lockout', () => {
  it("a stranger's wrong secrets lock only the stranger, never the browser's own mint", async () => {
    const device = await deviceSessionService.registerDevice();
    const stranger = '203.0.113.50';
    const browser = '198.51.100.20';

    const guesses = await Promise.all(
      Array.from({ length: 40 }, () => mint({ deviceId: device.deviceId, deviceSecret: 'guessed-secret' }, stranger)),
    );
    // Reserved atomically: at most 20 guesses are ever checked from one requester.
    expect(guesses.filter((guess) => guess.status === 401).length).toBeLessThanOrEqual(20);
    expect(guesses.filter((guess) => guess.status === 429).length).toBeGreaterThanOrEqual(20);
    expect((await mint(device, stranger)).status).toBe(429);

    // The browser, from its own address, still proves its secret.
    const own = await mint(device, browser);
    expect(own.status).not.toBe(429);
    expect(own.body.error).not.toBe('invalid_device_secret');
  });

  it('ten IPs failing twenty times each still do not lock the real browser', async () => {
    const device = await deviceSessionService.registerDevice();
    for (let ip = 0; ip < 10; ip += 1) {
      await Promise.all(
        Array.from({ length: 20 }, () => mint({ deviceId: device.deviceId, deviceSecret: 'guessed-secret' }, `203.0.113.${ip + 1}`)),
      );
    }
    const own = await mint(device, '198.51.100.20');
    expect(own.status).not.toBe(429);
    expect(own.body.error).not.toBe('invalid_device_secret');
  });
});
