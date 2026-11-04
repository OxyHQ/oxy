/**
 * A command on the shared client is rejected promptly when Valkey does not
 * answer, so every caller falls back instead of hanging with the outage.
 *
 * The server below accepts the TCP connection and never says a word: the
 * client never becomes ready, nothing ever closes, and without a command
 * timeout a command would wait in the offline queue forever.
 */

import net from 'node:net';
import type { AddressInfo } from 'node:net';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { REDIS_COMMAND_TIMEOUT_MS, closeRedis, getRedisClient } from '../redis';

const sockets = new Set<net.Socket>();
const silent = net.createServer((socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
const previousUrl = process.env.REDIS_URL;

beforeAll(async () => {
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  process.env.REDIS_URL = `redis://127.0.0.1:${(silent.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await closeRedis();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
  if (previousUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousUrl;
});

it('rejects a command within the command timeout when Valkey does not answer', async () => {
  const redis = getRedisClient();
  const started = Date.now();

  await expect(redis?.get('any-key')).rejects.toThrow('Command timed out');

  expect(Date.now() - started).toBeLessThan(REDIS_COMMAND_TIMEOUT_MS + 1_000);
}, 10_000);
