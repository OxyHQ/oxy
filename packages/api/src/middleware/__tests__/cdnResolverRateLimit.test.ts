/**
 * The public by-id resolver (`GET /cdn/:id`, behind cloud.oxy.so) is budgeted
 * per visitor by its own limiter and never draws on the general application
 * budget (`rl:general`) — see `isCdnResolverPath`. On 2026-11-04 every
 * resolve the Worker made was one anonymous client in `rl:general`, and every
 * avatar answered 429 once that one bucket ran dry.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { oxyTrustProxy } from '@oxy.so/core/server';

import { cdnResolverLimiter, rateLimiter } from '../security';

/** A Cloudflare edge address (`CLOUDFLARE_IPV4_RANGES`), as the ALB appends it. */
const CLOUDFLARE_EDGE = '104.16.0.1';

function get(server: http.Server, path: string, visitor: string): Promise<http.IncomingMessage> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port,
        path,
        // What Cloudflare and the ALB deliver for the Worker's same-zone
        // subrequest that names the visitor (`workers/cloud/src/visitor.ts`).
        headers: { 'x-forwarded-for': `${visitor}, ${CLOUDFLARE_EDGE}` },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('cdnResolverLimiter (rl:cdn:)', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', oxyTrustProxy);
    app.use(rateLimiter);
    app.use('/cdn', cdnResolverLimiter, (_req, res) => {
      res.status(302).location('https://cloud.oxy.so/content/a.png').end();
    });
    app.all('/{*path}', (_req, res) => res.json({ ok: true }));
    server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('charges each visitor its own resolver budget and none of the general one', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await get(server, '/cdn/abc?variant=w96', '203.0.113.7');
      expect(res.statusCode).toBe(302);
      expect(res.headers['ratelimit-limit']).toBe('20000');
      expect(res.headers['ratelimit-remaining']).toBe(String(19999 - i));
    }
    // Another visitor through the same Worker is a separate bucket.
    const other = await get(server, '/cdn/abc?variant=w96', '198.51.100.9');
    expect(other.headers['ratelimit-remaining']).toBe('19999');
    // The first visitor's general budget is untouched by its resolves.
    const api = await get(server, '/users/me', '203.0.113.7');
    expect(api.headers['ratelimit-limit']).toBe('1000');
    expect(api.headers['ratelimit-remaining']).toBe('999');
  });
});
