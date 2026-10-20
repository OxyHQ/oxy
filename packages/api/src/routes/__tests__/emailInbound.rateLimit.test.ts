/**
 * The inbound webhook's rate limit, through the real limiter (memory store).
 *
 * It used to be ONE bucket of 60 a minute for the whole platform, so one busy
 * mailing list delayed every other user's mail. It is now 120 a minute per
 * envelope recipient, behind a platform-wide backstop of 6000. A refusal is a
 * 429, which the worker retries instead of bouncing.
 */

import express, { type Request, type RequestHandler } from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

type Limiter = RequestHandler[];
type InboundRoute = typeof import('../emailInbound');

/** A fresh copy of the route module, so each case starts with empty buckets. */
function freshRoute(): InboundRoute {
  let loaded: InboundRoute | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual<InboundRoute>('../emailInbound');
  });
  if (!loaded) throw new Error('emailInbound did not load');
  return loaded;
}

async function serve(
  limiter: Limiter,
): Promise<{ post: (to: string) => Promise<number>; close: () => Promise<void> }> {
  const app = express();
  app.post('/email/inbound', limiter, (_req, res) => res.json({ ok: true }));
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    post: async (to) => {
      const res = await fetch(`http://127.0.0.1:${port}/email/inbound`, {
        method: 'POST',
        headers: { 'x-envelope-to': to },
      });
      await res.arrayBuffer();
      return res.status;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** `count` requests, `parallel` at a time; answers every status in order. */
async function many(
  post: (to: string) => Promise<number>,
  count: number,
  to: (i: number) => string,
  parallel = 1,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let start = 0; start < count; start += parallel) {
    const batch = Array.from({ length: Math.min(parallel, count - start) }, (_, k) =>
      post(to(start + k)),
    );
    statuses.push(...(await Promise.all(batch)));
  }
  return statuses;
}

describe('the inbound rate limit', () => {
  it('gives each recipient its own 120 a minute', async () => {
    const { inboundRateLimit } = freshRoute();
    const server = await serve(inboundRateLimit);
    try {
      const busy = await many(server.post, 121, () => 'list@oxy.so');
      expect(busy.slice(0, 120).every((status) => status === 200)).toBe(true);
      expect(busy[120]).toBe(429);

      // Another recipient is untouched by the first one's flood.
      expect(await server.post('quiet@oxy.so')).toBe(200);
      // The same recipient spelt differently is the same bucket.
      expect(await server.post('  LIST@oxy.so ')).toBe(429);
    } finally {
      await server.close();
    }
  });

  it('refuses everyone once the platform has taken 6000 in a minute', async () => {
    const { inboundRateLimit } = freshRoute();
    const server = await serve(inboundRateLimit);
    try {
      const statuses = await many(server.post, 6000, (i) => `user${i}@oxy.so`, 50);
      expect(statuses.every((status) => status === 200)).toBe(true);
      expect(await server.post('fresh@oxy.so')).toBe(429);
    } finally {
      await server.close();
    }
  }, 60_000);

  it('keys the bucket by the normalized envelope recipients', () => {
    const { envelopeRecipientsKey } = freshRoute();
    const key = (header: string | undefined) =>
      envelopeRecipientsKey({ headers: { 'x-envelope-to': header } } as unknown as Request);
    expect(key('B@oxy.so, a@oxy.so')).toBe('a@oxy.so,b@oxy.so');
    expect(key('a@oxy.so,a@OXY.so')).toBe('a@oxy.so');
    expect(key(undefined)).toBe('no-envelope-recipient');
  });
});
