/**
 * The service-token mint is charged to the credential it names, and the shared
 * per-address budgets leave it alone.
 *
 * Every Oxy service mints from the cluster's one NAT address with no bearer yet,
 * so every per-address budget on the way — `rl:general`, `rl:auth` and the
 * mint's own ten per five minutes — was the whole estate's. One service's deploy
 * spent another's next hourly token; Alia's chat turns and deploy readiness gate
 * then failed with `HTTP 429: Too Many Requests`, which Oxy never logs.
 */
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { authRateLimiter, isServiceTokenMintPath, rateLimiter } from '../../middleware/security';
import { serviceTokenMintRateLimitKey } from '../../utils/serviceRateLimitKey';

function post(server: http.Server, path: string): Promise<http.IncomingHttpHeaders> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'POST', host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A request that drew on a limiter carries its RateLimit headers; a skipped one carries none. */
function charged(headers: http.IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase().startsWith('ratelimit'));
}

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('isServiceTokenMintPath', () => {
  it('matches the key-pair mint and the workload pair', () => {
    expect(isServiceTokenMintPath('/auth/service-token')).toBe(true);
    expect(isServiceTokenMintPath('/auth/service-token/workload')).toBe(true);
    expect(isServiceTokenMintPath('/auth/service-token/workload/challenge')).toBe(true);
  });

  it('does not match a sibling that merely shares the prefix', () => {
    expect(isServiceTokenMintPath('/auth/service-tokens')).toBe(false);
    expect(isServiceTokenMintPath('/auth/login')).toBe(false);
    expect(isServiceTokenMintPath('/service-token')).toBe(false);
  });
});

describe('the shared per-address limiters skip the mint', () => {
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use(rateLimiter);
    // Mounted the way server.ts mounts it, so the skip has to read `baseUrl`.
    app.use('/auth', authRateLimiter, express.Router().post('*', (_req, res) => res.json({ ok: true })));
    app.all('*', (_req, res) => res.json({ ok: true }));
    server = await listen(app);
  });

  afterAll(async () => {
    await close(server);
  });

  it('charges neither rl:general nor rl:auth for a mint', async () => {
    for (const path of [
      '/auth/service-token',
      '/auth/service-token/workload/challenge',
      '/auth/service-token/workload',
    ]) {
      expect(charged(await post(server, path))).toBe(false);
    }
  });

  it('still charges every other auth route to its address', async () => {
    const headers = await post(server, '/auth/login');
    expect(charged(headers)).toBe(true);
    // rl:auth answers last and is the tighter of the two, so its limit is the one reported.
    expect(headers['ratelimit-limit']).toBe('300');
  });
});

describe('serviceTokenMintRateLimitKey', () => {
  const requestFor = (apiKey: unknown, ip: string) =>
    ({ body: { apiKey }, ip }) as unknown as Parameters<typeof serviceTokenMintRateLimitKey>[0];

  it('gives two credentials behind one address two buckets', () => {
    expect(serviceTokenMintRateLimitKey(requestFor('oxy_dk_alia', '10.0.0.1'))).not.toBe(
      serviceTokenMintRateLimitKey(requestFor('oxy_dk_mention', '10.0.0.1'))
    );
  });

  it('gives one credential one bucket from any address', () => {
    expect(serviceTokenMintRateLimitKey(requestFor('oxy_dk_alia', '10.0.0.1'))).toBe(
      serviceTokenMintRateLimitKey(requestFor('oxy_dk_alia', '198.51.100.7'))
    );
  });

  it('bounds the key length whatever a caller sends', () => {
    expect(serviceTokenMintRateLimitKey(requestFor('x'.repeat(10_000), '10.0.0.1'))).toHaveLength(
      'key:'.length + 32
    );
  });

  it('falls back to the address when no key is presented', () => {
    const missing = serviceTokenMintRateLimitKey(requestFor(undefined, '10.0.0.1'));
    expect(missing.startsWith('addr:')).toBe(true);
    expect(serviceTokenMintRateLimitKey(requestFor(42, '10.0.0.1'))).toBe(missing);
    expect(serviceTokenMintRateLimitKey(requestFor(undefined, '10.0.0.2'))).not.toBe(missing);
  });
});
