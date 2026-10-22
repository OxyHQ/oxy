/**
 * `GET /v1/realtime` pings its customer, so an idle session outlives the
 * proxies in front of the API (a 60 s load-balancer idle timeout, a 100 s CDN
 * one) while its own idle allowance is two minutes — and it drops a customer
 * that stops answering.
 *
 * The connection is held in authentication (a promise that never settles) so
 * the heartbeat is observed on its own; it is attached at the upgrade, before
 * authentication, so it covers every later phase the same way. The interval is
 * shortened through the edge's option; the production value is held to the
 * shorter proxy timeout.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { type WebSocketServer } from 'ws';

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../services/inferenceEdge.service', () => ({
  ...jest.requireActual('../../services/inferenceEdge.service'),
  allocateRequestId: () => 'req_heartbeat',
  authenticateEdgeCaller: () => new Promise(() => undefined),
}));

import { attachRealtimeEdge, REALTIME_HEARTBEAT_INTERVAL_MS } from '../inferenceRealtime';

const INTERVAL_MS = 40;

let server: http.Server;
let edge: WebSocketServer;
let url: string;

beforeEach(async () => {
  server = http.createServer();
  edge = attachRealtimeEdge(server, { heartbeatIntervalMs: INTERVAL_MS });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`;
});

afterEach(async () => {
  // An upgraded socket is no longer the HTTP server's to close.
  for (const client of edge.clients) client.terminate();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function open(options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The deadline for an event that must happen, not the time it takes. These tests
 * used to sleep a fixed multiple of the interval and then count (`wait(INTERVAL_MS
 * * 6)`, then `pings >= 3`), which assumes a 40 ms timer fires on time. On a
 * loaded CI runner it does not: it counted 2 pings where the same code counts 6 on
 * a quiet machine, and failed API Tests shards in CI. Waiting for the condition
 * with a deadline far above any plausible delay keeps the assertion and removes the
 * race; a genuine regression (no pings, no close) still fails, at the deadline.
 */
const DEADLINE_MS = 8_000;
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!condition() && Date.now() < deadline) await wait(INTERVAL_MS / 2);
}

it('pings a connected customer and keeps it while it answers', async () => {
  const ws = await open();
  let pings = 0;
  ws.on('ping', () => {
    pings += 1;
  });
  let closed = false;
  ws.on('close', () => {
    closed = true;
  });

  // Three pings is two full intervals after the first: the connection has been
  // kept across more than one heartbeat, answering each.
  await until(() => pings >= 3 || closed);

  expect(pings).toBeGreaterThanOrEqual(3);
  expect(closed).toBe(false);
  expect(ws.readyState).toBe(WebSocket.OPEN);
  ws.terminate();
});

it('terminates a customer that stops answering pings', async () => {
  const ws = await open({ autoPong: false });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  let pings = 0;
  ws.on('ping', () => {
    pings += 1;
  });

  // One interval to send the ping, the next to find it unanswered.
  const code = await Promise.race([closed, wait(DEADLINE_MS).then(() => 'still open')]);

  expect(code).toBe(1006);
  expect(pings).toBe(1);
});

it('pings well inside the shortest proxy idle timeout (60 s)', () => {
  expect(REALTIME_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(30_000);
});
