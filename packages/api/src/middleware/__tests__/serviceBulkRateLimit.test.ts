/**
 * Token-gated service-to-service BULK-path rate-limit exemption.
 *
 * Some oxy-api endpoints are EXCLUSIVELY service-to-service (serviceAuth-gated)
 * yet live under a user-facing prefix, and a relying app's federation backfill
 * calls them in BULK through ONE NAT egress IP:
 *   - PUT  /users/resolve             (find-or-create a federated/agent user)
 *   - POST /assets/service/cache      (mirror remote media into the cache ns)
 *   - POST /assets/service/federation (persist durable federated media)
 *   - POST /assets/service/user-media (persist media for a local user; MCP)
 *   - POST /assets/service/by-ids     (resolve asset metadata for a batch of ids)
 *   - POST /assets/service/by-sha256  (reverse-resolve assets by content hash)
 *
 * Like `/federation/*` (#604), these must NOT share the per-IP browser budget
 * (`rl:general`, 1000/15min) — a backfill exhausts it and 429s legitimate bulk
 * resolves/uploads. But UNLIKE `/federation/*` (whose whole prefix is
 * service-only), these share a prefix with browser routes, so the exemption is
 * gated on the request carrying a VALID service token: `isServiceToServiceBulkRequest`.
 * This suite proves (a) the predicate only exempts an exempt path WITH a valid
 * service token, (b) the general limiter honours that, and — critically —
 * (c) sibling user-facing routes and unauthenticated/user-token traffic KEEP the
 * per-IP protection.
 */

// This file needs the REAL jsonwebtoken (the global jest.setup.cjs mocks it) so
// `verifyServiceToken` actually validates a minted service token.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Request } from 'express';

const ACCESS_TOKEN_SECRET = 'test_access_token_secret_minimum_32_characters';
process.env.ACCESS_TOKEN_SECRET = ACCESS_TOKEN_SECRET;

import { rateLimiter, isServiceToServiceBulkRequest } from '../security';

function serviceToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      type: 'service',
      appId: 'app-1',
      appName: 'Mention',
      credentialId: 'cred-1',
      // The full attribution tuple the real mint emits (ADR 0007). A fixture
      // short of it is not a service token as far as `verifyServiceToken` is
      // concerned, so leaving these out would silently test the reject path.
      ownerAccountId: 'owner-account-1',
      environment: 'production',
      scopes: ['federation:write'],
      ...overrides,
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: '5m' }
  );
}

function userSessionToken(): string {
  return jwt.sign({ userId: 'u-1', sessionId: 's-1' }, ACCESS_TOKEN_SECRET, { expiresIn: '5m' });
}

function makeReq(path: string, authorization?: string): Request {
  return { path, headers: authorization ? { authorization } : {} } as unknown as Request;
}

interface Probe {
  status: number;
  headers: http.IncomingHttpHeaders;
}

function request(
  server: http.Server,
  opts: { method: string; path: string; authorization?: string }
): Promise<Probe> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.authorization) headers.authorization = opts.authorization;
    const req = http.request(
      { method: opts.method, host: '127.0.0.1', port: address.port, path: opts.path, headers },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function hasRateLimitHeaders(headers: http.IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((h) => h.toLowerCase().startsWith('ratelimit'));
}

describe('isServiceToServiceBulkRequest', () => {
  it('exempts an exempt path WITH a valid service token', () => {
    for (const path of [
      '/users/resolve',
      '/assets/service/cache',
      '/assets/service/federation',
      '/assets/service/user-media',
      // The bulk READ lookups. Absent from the set until a relying app's
      // metadata backfill drew 24,423 429s off the browser budget.
      '/assets/service/by-ids',
      '/assets/service/by-sha256',
    ]) {
      expect(isServiceToServiceBulkRequest(makeReq(path, `Bearer ${serviceToken()}`))).toBe(true);
    }
  });

  it('does NOT exempt an exempt path WITHOUT a token (unauthenticated flood stays capped)', () => {
    expect(isServiceToServiceBulkRequest(makeReq('/users/resolve'))).toBe(false);
  });

  it('does NOT exempt an exempt path carrying a USER session token', () => {
    expect(isServiceToServiceBulkRequest(makeReq('/users/resolve', `Bearer ${userSessionToken()}`))).toBe(false);
  });

  it('does NOT exempt an exempt path carrying a garbage/invalid token', () => {
    expect(isServiceToServiceBulkRequest(makeReq('/users/resolve', 'Bearer not-a-jwt'))).toBe(false);
  });

  it('does NOT exempt a sibling USER-FACING route even WITH a valid service token', () => {
    // The exemption is an exact-path allow-list: /users/me keeps browser protection.
    expect(isServiceToServiceBulkRequest(makeReq('/users/me', `Bearer ${serviceToken()}`))).toBe(false);
    expect(isServiceToServiceBulkRequest(makeReq('/users/app-1', `Bearer ${serviceToken()}`))).toBe(false);
    expect(isServiceToServiceBulkRequest(makeReq('/assets/upload', `Bearer ${serviceToken()}`))).toBe(false);
  });
});

describe('general limiter (rl:general) honours the token-gated exemption', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(rateLimiter);
    app.all('*', (_req, res) => res.json({ ok: true }));
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('SKIPS /users/resolve when a valid service token is present (no budget drawdown)', async () => {
    const res = await request(server, {
      method: 'PUT',
      path: '/users/resolve',
      authorization: `Bearer ${serviceToken()}`,
    });
    expect(res.status).toBe(200);
    expect(hasRateLimitHeaders(res.headers)).toBe(false);
  });

  it('STILL enforces /users/resolve for an unauthenticated request', async () => {
    const res = await request(server, { method: 'PUT', path: '/users/resolve' });
    expect(res.status).toBe(200);
    expect(hasRateLimitHeaders(res.headers)).toBe(true);
    // NODE_ENV is not "development" under jest → production ceiling of 1000.
    expect(res.headers['ratelimit-limit']).toBe('1000');
  });

  it('STILL enforces a sibling user-facing route (/users/me) even with a service token', async () => {
    const res = await request(server, {
      method: 'GET',
      path: '/users/me',
      authorization: `Bearer ${serviceToken()}`,
    });
    expect(res.status).toBe(200);
    expect(hasRateLimitHeaders(res.headers)).toBe(true);
    expect(res.headers['ratelimit-limit']).toBe('1000');
  });

  it('SKIPS the /assets/service/* LOOKUP paths with a valid service token', async () => {
    for (const path of ['/assets/service/by-ids', '/assets/service/by-sha256']) {
      const res = await request(server, { method: 'POST', path, authorization: `Bearer ${serviceToken()}` });
      expect(res.status).toBe(200);
      expect(hasRateLimitHeaders(res.headers)).toBe(false);
    }
  });

  it('STILL enforces the LOOKUP paths for an unauthenticated request', async () => {
    // The exemption is token-gated, so an unauthenticated flood of these paths
    // keeps the per-IP browser ceiling. This is why allowlisting them does not
    // widen the unauthenticated attack surface.
    const res = await request(server, { method: 'POST', path: '/assets/service/by-ids' });
    expect(res.status).toBe(200);
    expect(hasRateLimitHeaders(res.headers)).toBe(true);
    expect(res.headers['ratelimit-limit']).toBe('1000');
  });

  it('SKIPS the /assets/service/* upload paths with a valid service token', async () => {
    for (const path of [
      '/assets/service/cache',
      '/assets/service/federation',
      '/assets/service/user-media',
    ]) {
      const res = await request(server, { method: 'POST', path, authorization: `Bearer ${serviceToken()}` });
      expect(res.status).toBe(200);
      expect(hasRateLimitHeaders(res.headers)).toBe(false);
    }
  });
});
