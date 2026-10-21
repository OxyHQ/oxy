/**
 * The service-event feed over a REAL Socket.IO connection, under Bun.
 *
 * Every Oxy backend runs on Bun, and Jest runs core's suite on Node, which is
 * how core 6.9.0 shipped a feed that crashed every Bun backend the moment it
 * connected (`autoUnref` → engine.io-client → `ws._socket.unref()`, absent on
 * Bun's WebSocket). This opens the real feed against a real Socket.IO server in
 * this process: on 6.9.0 the process throws as soon as the socket opens.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  OXY_SERVICE_EVENTS_HEARTBEAT_EVENT,
  OXY_SERVICE_EVENTS_NAMESPACE,
  OXY_SESSION_REVOKED_EVENT,
} from '@oxy.so/contracts';
import { Server } from 'socket.io';
import { AUTO_UNREF_SUPPORTED, OxyServiceEventFeed } from '../src/server/serviceEvents';

let http: HttpServer;
let io: Server;
let baseURL: string;
const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => uncaught.push(error);

beforeAll(async () => {
  process.on('uncaughtException', onUncaught);
  http = createServer();
  io = new Server(http, { transports: ['websocket'] });
  io.of(OXY_SERVICE_EVENTS_NAMESPACE).use((socket, next) => {
    if ((socket.handshake.auth as { token?: string }).token === 'service-token') next();
    else next(new Error('forbidden'));
  });
  io.of(OXY_SERVICE_EVENTS_NAMESPACE).on('connection', (socket) => {
    const beat = setInterval(() => socket.emit(OXY_SERVICE_EVENTS_HEARTBEAT_EVENT), 50);
    socket.on('disconnect', () => clearInterval(beat));
    setTimeout(
      () =>
        socket.emit(OXY_SESSION_REVOKED_EVENT, { sessionId: 's-1', userId: 'u-1', at: Date.now() }),
      300,
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  io.close();
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

test('runs under Bun, where autoUnref cannot work', () => {
  expect(typeof process.versions.bun).toBe('string');
  expect(AUTO_UNREF_SUPPORTED).toBe(false);
});

test('the real feed connects, goes live, relays a revocation and the process survives', async () => {
  const revocations: unknown[] = [];
  const feed = new OxyServiceEventFeed({
    baseURL,
    serviceToken: async () => 'service-token',
    onRevocation: (event) => revocations.push(event),
    onDown: () => {},
  });
  feed.start();
  const deadline = Date.now() + 5000;
  while (revocations.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Keep the socket open across several heartbeats and engine.io pings.
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(uncaught).toEqual([]);
  expect(feed.liveEpoch()).not.toBeNull();
  expect(revocations).toEqual([expect.objectContaining({ sessionId: 's-1', userId: 'u-1' })]);
  feed.stop();
  expect(feed.liveEpoch()).toBeNull();
});
