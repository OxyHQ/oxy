/**
 * IdP worker server-to-server rate-limit exemption.
 *
 * The auth.oxy.so Cloudflare worker calls a small set of oxy-api endpoints
 * server-to-server for session validation, from a shared pool of egress IPs:
 *
 *   - GET  /session/validate/:id     (fetchUserFromAPI / validateSession)
 *
 * These MUST NOT share the per-IP browser budget (`rl:general`, 1000/15min):
 * one worker IP fans many users through them, so browser-scale traffic would
 * exhaust the budget → 429 → the IdP fails closed → RP guards re-bounce and
 * amplify. This suite proves the exported general limiter SKIPS these paths and
 * that they instead carry the dedicated high-ceiling `idpServiceLimiter`.
 *
 * MOUNT-ORDER INVARIANT (documented, enforced by these tests): every path
 * matched by `isIdpServiceToServicePath` is excluded from `rl:general`, so it
 * MUST carry its own route-level limiter (reads → `idpServiceLimiter`).
 * `isIdpServiceToServicePath` and the route wiring must be kept in sync.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { rateLimiter, idpServiceLimiter, isIdpServiceToServicePath } from '../security';

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

describe('isIdpServiceToServicePath', () => {
  it('matches the exact worker READ path', () => {
    expect(isIdpServiceToServicePath('/session/validate/sess-abc')).toBe(true);
  });

  it('does NOT match browser-reachable neighbours that must stay under the general budget', () => {
    // Bearer-cross-checked, browser-reachable — MUST NOT be exempted.
    expect(isIdpServiceToServicePath('/session/validate-header/sess-abc')).toBe(false);
    // Ordinary user/session traffic.
    expect(isIdpServiceToServicePath('/session/user/64f7c2a1b8e9d3f4a1c2b3d4')).toBe(false);
    expect(isIdpServiceToServicePath('/users/me')).toBe(false);
    expect(isIdpServiceToServicePath('/')).toBe(false);
  });
});

describe('general limiter (rl:general) exempts IdP service paths', () => {
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
    for (const path of ['/session/validate/sess-abc']) {
      const res = await get(server, path);
      expect(res.status).toBe(200);
      // A skipped request never touches the store and emits NO RateLimit
      // headers — proof it does not draw down the per-IP browser budget.
      expect(hasRateLimitHeaders(res.headers)).toBe(false);
    }
  });

  it('still enforces the general budget on browser-facing paths', async () => {
    const res = await get(server, '/session/validate-header/sess-abc');
    expect(res.status).toBe(200);
    expect(hasRateLimitHeaders(res.headers)).toBe(true);
    // NODE_ENV is not "development" under jest → production ceiling of 1000.
    expect(res.headers['ratelimit-limit']).toBe('1000');
  });
});

describe('idpServiceLimiter (rl:idp:service) is the dedicated high-cap limiter', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(idpServiceLimiter);
    app.all('*', (_req, res) => res.json({ ok: true }));
    server = await listen(app);
  });

  afterAll(async () => {
    await close(server);
  });

  it('enforces a ceiling far above the general per-IP budget', async () => {
    const res = await get(server, '/session/validate/sess-abc');
    expect(res.status).toBe(200);
    expect(hasRateLimitHeaders(res.headers)).toBe(true);
    // 20x the general 1000 ceiling — sized for shared-egress worker fan-out, a
    // distinct instance from rl:general (different limit proves distinctness).
    expect(res.headers['ratelimit-limit']).toBe('20000');
    expect(res.headers['ratelimit-limit']).not.toBe('1000');
  });
});
