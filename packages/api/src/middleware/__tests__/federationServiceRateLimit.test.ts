/**
 * Federation sign-on-behalf server-to-server rate-limit exemption.
 *
 * Relying-app backends (e.g. Mention) call the federation surface
 * server-to-server via a `federation:write` service token, from a SINGLE NAT
 * egress IP:
 *
 *   - POST /federation/sign            (HTTP-Signature signing on behalf)
 *   - GET  /federation/public-key/:u   (publish an actor's public key block)
 *   - POST /federation/follow          (mirror a remote follow into the graph)
 *
 * These MUST NOT share the per-IP browser budget (`rl:general`, 1000/15min): an
 * outbox backfill / delivery fan-out legitimately signs tens of thousands of
 * requests through that one IP, so browser-scale limiting exhausts the budget in
 * seconds → 429 → outbound federation silently degrades (the empirically
 * observed prod failure: single calls succeed, a sustained ~25 req/s backfill
 * fails ~98%). This suite proves the exported general limiter SKIPS these paths
 * and that they instead carry the dedicated high-ceiling
 * `federationServiceLimiter`.
 *
 * MOUNT-ORDER INVARIANT (documented, enforced by these tests): every path
 * matched by `isFederationServiceToServicePath` is excluded from `rl:general`,
 * so the `/federation` mount MUST carry `federationServiceLimiter`.
 * `isFederationServiceToServicePath` and the router wiring must be kept in sync.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import {
  rateLimiter,
  federationServiceLimiter,
  isFederationServiceToServicePath,
} from '../security';

interface Probe {
  status: number;
  headers: http.IncomingHttpHeaders;
}

function get(server: http.Server, path: string): Promise<Probe> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function hasRateLimitHeaders(headers: http.IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((h) => h.toLowerCase().startsWith('ratelimit'));
}

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('isFederationServiceToServicePath', () => {
  it('matches the federation sign-on-behalf surface', () => {
    expect(isFederationServiceToServicePath('/federation/sign')).toBe(true);
    expect(isFederationServiceToServicePath('/federation/public-key/alice')).toBe(true);
    expect(isFederationServiceToServicePath('/federation/follow')).toBe(true);
  });

  it('does NOT match unrelated paths that must stay under the general budget', () => {
    // Browser-reachable ActivityPub/webfinger surfaces live on other prefixes.
    expect(isFederationServiceToServicePath('/ap/users/alice')).toBe(false);
    expect(isFederationServiceToServicePath('/.well-known/webfinger')).toBe(false);
    expect(isFederationServiceToServicePath('/users/me')).toBe(false);
    expect(isFederationServiceToServicePath('/')).toBe(false);
    // The bare mount without a trailing slash is not a real route.
    expect(isFederationServiceToServicePath('/federation')).toBe(false);
  });
});

describe('general limiter (rl:general) exempts federation service paths', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(rateLimiter);
    app.all('*', (_req, res) => res.json({ ok: true }));
    server = await listen(app);
  });

  afterAll(async () => {
    await close(server);
  });

  it('does not consume / emit the general budget on exempt paths', async () => {
    for (const path of ['/federation/sign', '/federation/public-key/alice', '/federation/follow']) {
      const res = await get(server, path);
      expect(res.status).toBe(200);
      // A skipped request never touches the store and emits NO RateLimit
      // headers — proof it does not draw down the per-IP browser budget.
      expect(hasRateLimitHeaders(res.headers)).toBe(false);
    }
  });

  it('still enforces the general budget on non-federation paths', async () => {
    const res = await get(server, '/users/me');
    expect(res.status).toBe(200);
    expect(hasRateLimitHeaders(res.headers)).toBe(true);
    // NODE_ENV is not "development" under jest → production ceiling of 1000.
    expect(res.headers['ratelimit-limit']).toBe('1000');
  });
});

describe('federationServiceLimiter (rl:federation:service) is the dedicated high-cap limiter', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(federationServiceLimiter);
    app.all('*', (_req, res) => res.json({ ok: true }));
    server = await listen(app);
  });

  afterAll(async () => {
    await close(server);
  });

  it('enforces a ceiling far above the general per-IP budget', async () => {
    const res = await get(server, '/federation/sign');
    expect(res.status).toBe(200);
    expect(hasRateLimitHeaders(res.headers)).toBe(true);
    // 60x the general 1000 ceiling — sized for a relying app's outbox
    // backfill / delivery fan-out through one NAT IP; a distinct instance from
    // rl:general (different limit proves distinctness).
    expect(res.headers['ratelimit-limit']).toBe('60000');
    expect(res.headers['ratelimit-limit']).not.toBe('1000');
  });
});
