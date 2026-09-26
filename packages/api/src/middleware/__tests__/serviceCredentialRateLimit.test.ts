/**
 * Service traffic is charged to the CREDENTIAL, never to the shared egress IP.
 *
 * A relying app's backend fans every one of its signed-in users' server-side
 * reads through ONE NAT egress IP, and every app in the cluster shares that IP.
 * Under the per-IP browser budget (`rl:general`, 1000/15min) that pool is spent
 * by normal multi-user traffic, and then EVERY app's calls fail at once — which
 * is one app's traffic becoming another app's outage. It happened: Mention's
 * sitemap and record-signing traffic exhausted the shared budget and the 429s
 * landed on its feed's privacy reads, which fail closed, so readers got 500s.
 *
 * This suite proves the three properties that fix rests on:
 *  (a) a VALID service token is recognised on any path, and nothing else is —
 *      not an anonymous request, not a user session, not a garbage token;
 *  (b) `rl:general` no longer charges such a request, and
 *      `serviceCredentialLimiter` does, under its own ceiling;
 *  (c) two applications have SEPARATE budgets, and browser traffic keeps the
 *      per-IP protection untouched.
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

import { rateLimiter, serviceCredentialLimiter, userRateLimiter, isFirstPartyServiceRequest } from '../security';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';

function serviceToken(overrides: Record<string, unknown> = {}): string {
  return signServiceTokenEd25519({
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
      iss: 'oxy-auth',
      aud: 'oxy-api',
      exp: Math.floor(Date.now() / 1_000) + 300,
    });
}

function userSessionToken(userId = 'u-1'): string {
  return jwt.sign({ userId, sessionId: `s-${userId}` }, ACCESS_TOKEN_SECRET, { expiresIn: '5m' });
}

/** A JWT with no `sessionId` — not what a real Oxy access token looks like. */
function sessionlessToken(): string {
  return jwt.sign({ userId: 'u-forged' }, ACCESS_TOKEN_SECRET, { expiresIn: '5m' });
}

function makeReq(path: string, authorization?: string, originalUrl?: string): Request {
  return {
    path,
    originalUrl: originalUrl ?? path,
    headers: authorization ? { authorization } : {},
  } as unknown as Request;
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

describe('isFirstPartyServiceRequest', () => {
  it('recognises a valid service credential on any path', () => {
    for (const path of [
      '/users/resolve',
      '/assets/service/by-ids',
      '/users/some-user-id',
      '/privacy/blocked',
      '/auth/mcp/oauth/introspect',
    ]) {
      expect(isFirstPartyServiceRequest(makeReq(path, `Bearer ${serviceToken()}`))).toBe(true);
    }
  });

  it('recognises nothing else — anonymous, user session, or garbage', () => {
    expect(isFirstPartyServiceRequest(makeReq('/users/resolve'))).toBe(false);
    expect(isFirstPartyServiceRequest(makeReq('/users/resolve', `Bearer ${userSessionToken()}`))).toBe(false);
    expect(isFirstPartyServiceRequest(makeReq('/users/resolve', 'Bearer not-a-jwt'))).toBe(false);
    expect(isFirstPartyServiceRequest(makeReq('/users/me', 'Basic anything'))).toBe(false);
  });

  it('verifies the token once per request, however many limiters ask', () => {
    const req = makeReq('/users/resolve', `Bearer ${serviceToken()}`);
    const verifySpy = jest.spyOn(jwt, 'verify');

    expect(isFirstPartyServiceRequest(req)).toBe(true);
    expect(isFirstPartyServiceRequest(req)).toBe(true);
    expect(isFirstPartyServiceRequest(req)).toBe(true);

    expect(verifySpy.mock.calls.length).toBeLessThanOrEqual(1);
    verifySpy.mockRestore();
  });
});

describe('the two global budgets, mounted as server.ts mounts them', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(rateLimiter);
    app.use(serviceCredentialLimiter);
    app.all('*', (_req, res) => res.json({ ok: true }));
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('charges a service credential to its own ceiling, not the browser one', async () => {
    const res = await request(server, {
      method: 'GET',
      // A user-facing path: what decides the budget is the credential, not the
      // path — the exact-path allow-list this replaced could not say that.
      path: '/users/some-user-id',
      authorization: `Bearer ${serviceToken()}`,
    });

    expect(res.status).toBe(200);
    // NODE_ENV is not "development" under jest → production ceilings.
    expect(res.headers['ratelimit-limit']).toBe('60000');
  });

  it('keeps the per-IP browser ceiling for an anonymous request', async () => {
    const res = await request(server, { method: 'GET', path: '/users/some-user-id' });

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('1000');
  });

  it('keeps the per-IP browser ceiling for a user session', async () => {
    const res = await request(server, {
      method: 'GET',
      path: '/users/me',
      authorization: `Bearer ${userSessionToken()}`,
    });

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBe('1000');
  });

  it('gives two applications separate budgets', async () => {
    const first = await request(server, {
      method: 'GET',
      path: '/users/some-user-id',
      authorization: `Bearer ${serviceToken({ appId: 'app-separate-a' })}`,
    });
    const second = await request(server, {
      method: 'GET',
      path: '/users/some-user-id',
      authorization: `Bearer ${serviceToken({ appId: 'app-separate-b' })}`,
    });

    // Each app's FIRST request draws its own budget down by one, so both see the
    // same remaining count. A shared bucket would show the second one lower.
    expect(second.headers['ratelimit-remaining']).toBe(first.headers['ratelimit-remaining']);
  });

  it('charges a rotated credential of the same app to the same budget', async () => {
    const appId = 'app-rotating';
    const first = await request(server, {
      method: 'GET',
      path: '/users/some-user-id',
      authorization: `Bearer ${serviceToken({ appId, credentialId: 'cred-old' })}`,
    });
    const second = await request(server, {
      method: 'GET',
      path: '/users/some-user-id',
      authorization: `Bearer ${serviceToken({ appId, credentialId: 'cred-new' })}`,
    });

    expect(Number(second.headers['ratelimit-remaining']))
      .toBe(Number(first.headers['ratelimit-remaining']) - 1);
  });
});

describe('an authenticated request is charged to its subject, not to its IP', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(rateLimiter);
    app.use(serviceCredentialLimiter);
    app.all('*', (_req, res) => res.json({ ok: true }));
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * The property the outage turned on: two readers arriving from the SAME IP
   * (a relying app's backend reading on their behalf) must not share a budget.
   */
  it('gives two signed-in users separate budgets from one IP', async () => {
    const first = await request(server, {
      method: 'GET',
      path: '/users/me',
      authorization: `Bearer ${userSessionToken('u-subject-a')}`,
    });
    const second = await request(server, {
      method: 'GET',
      path: '/users/me',
      authorization: `Bearer ${userSessionToken('u-subject-b')}`,
    });

    expect(second.headers['ratelimit-remaining']).toBe(first.headers['ratelimit-remaining']);
  });

  it('charges the same user twice to one budget', async () => {
    const token = `Bearer ${userSessionToken('u-subject-repeat')}`;
    const first = await request(server, { method: 'GET', path: '/users/me', authorization: token });
    const second = await request(server, { method: 'GET', path: '/users/me', authorization: token });

    expect(Number(second.headers['ratelimit-remaining']))
      .toBe(Number(first.headers['ratelimit-remaining']) - 1);
  });

  it('does not let a token without a session claim mint its own bucket', async () => {
    // Falls back to the per-IP key, so it shares the anonymous bucket rather
    // than buying a fresh 1000 by decorating a JWT.
    const anonymous = await request(server, { method: 'GET', path: '/users/me' });
    const forged = await request(server, {
      method: 'GET',
      path: '/users/me',
      authorization: `Bearer ${sessionlessToken()}`,
    });

    expect(Number(forged.headers['ratelimit-remaining']))
      .toBe(Number(anonymous.headers['ratelimit-remaining']) - 1);
  });

  it('keeps the per-user ceiling above what a reader plus the app reading for them needs', async () => {
    const app = express();
    // `authMiddleware` runs before this limiter in server.ts, so the subject is
    // already on the request by the time it is keyed.
    app.use((req, _res, next) => {
      (req as typeof req & { user: { id: string } }).user = { id: 'u-ceiling' };
      next();
    });
    app.use(userRateLimiter);
    app.all('*', (_req, res) => res.json({ ok: true }));
    const local = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });

    try {
      const res = await request(local, { method: 'GET', path: '/privacy/blocked' });
      expect(res.headers['ratelimit-limit']).toBe('2000');
    } finally {
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
  });
});
