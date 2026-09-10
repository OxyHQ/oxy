/**
 * Origin guard tests (MED-1 CSRF hardening, Phase A)
 *
 * `isAllowedOrigin`: strict allowlist — exact first-party app origins,
 * loopback localhost / 127.0.0.1 / [::1] (unconditional, all envs), and
 * validated `OXY_EXTRA_ALLOWED_ORIGINS` entries. Suffix-spoofing, case tricks,
 * and homograph hosts must all fail.
 *
 * `requireSameSiteOrigin`: blocks non-safe methods from non-allowlisted
 * browser contexts (Origin header, with Sec-Fetch-Site as fallback) and
 * emits `csrf.origin.reject`; `ORIGIN_GUARD_MODE=log-only` logs without
 * blocking.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockWarn = jest.fn();

jest.mock('../../utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { requireSameSiteOrigin, isAllowedOrigin } from '../originGuard';
import { setOriginSnapshotForTests } from '../../config/dynamicOriginRegistry';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_GUARD_MODE = process.env.ORIGIN_GUARD_MODE;
const ORIGINAL_EXTRA = process.env.OXY_EXTRA_ALLOWED_ORIGINS;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv('NODE_ENV', ORIGINAL_NODE_ENV);
  restoreEnv('ORIGIN_GUARD_MODE', ORIGINAL_GUARD_MODE);
  restoreEnv('OXY_EXTRA_ALLOWED_ORIGINS', ORIGINAL_EXTRA);
});

beforeEach(() => {
  mockWarn.mockClear();
  delete process.env.ORIGIN_GUARD_MODE;
  delete process.env.OXY_EXTRA_ALLOWED_ORIGINS;
});

describe('isAllowedOrigin', () => {
  const EXACT_ALLOWED = [
    'https://oxy.so',
    'https://mention.earth',
    'https://homiio.com',
    'https://alia.onl',
    'https://moovo.now',
    'https://mercaria.co',
  ];

  const APP_ORIGIN_ALLOWED = [
    'https://api.oxy.so',
    'https://accounts.oxy.so',
    'https://auth.oxy.so',
    'https://api.mention.earth',
    'https://app.homiio.com',
    'https://api.alia.onl',
    'https://go.moovo.now',
    'https://hub.moovo.now',
    'https://dashboard.mercaria.co',
    'https://pos.mercaria.co',
  ];

  beforeEach(() => {
    setOriginSnapshotForTests([...EXACT_ALLOWED, ...APP_ORIGIN_ALLOWED], []);
  });

  const REJECTED = [
    'https://evil.com',
    'http://oxy.so',
    'http://api.oxy.so',
    'https://oxy.so.evil.com',
    'https://oxy-so.example.com',
    'https://EVIL.oxy.so',
    'https://оxy.so',
    'https://attacker.oxy.so',
    'https://a.b.oxy.so',
    'https://oxy.so:8443',
    'https://oxy.so/path',
    'https://moovo.now.evil.com',
    'http://moovo.now',
    'https://mercaria.co.evil.com',
    'http://mercaria.co',
    'null',
    '',
  ];

  it.each(EXACT_ALLOWED)('allows exact origin %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  it.each(APP_ORIGIN_ALLOWED)('allows registered app origin %s', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(true);
  });

  it.each(REJECTED)('rejects %j', (origin) => {
    expect(isAllowedOrigin(origin)).toBe(false);
  });

  it('allows localhost / 127.0.0.1 / [::1] outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedOrigin('http://localhost')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8081')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:19006')).toBe(true);
  });

  it('allows localhost / 127.0.0.1 / [::1] in production too (owner-approved)', () => {
    process.env.NODE_ENV = 'production';
    expect(isAllowedOrigin('http://localhost:8081')).toBe(true);
    expect(isAllowedOrigin('http://localhost')).toBe(true);
    expect(isAllowedOrigin('http://localhost:54321')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedOrigin('http://[::1]:19006')).toBe(true);
  });

  it('rejects https loopback (loopback is http-only)', () => {
    process.env.NODE_ENV = 'production';
    expect(isAllowedOrigin('https://localhost:8081')).toBe(false);
  });

  it('rejects localhost lookalikes even in development', () => {
    process.env.NODE_ENV = 'development';
    expect(isAllowedOrigin('http://localhost.evil.com')).toBe(false);
    expect(isAllowedOrigin('http://localhost.evil.com:3000')).toBe(false);
  });

  it('accepts validated OXY_EXTRA_ALLOWED_ORIGINS entries', () => {
    process.env.OXY_EXTRA_ALLOWED_ORIGINS = 'https://partner.example.com, https://emergency.oxy.dev';
    expect(isAllowedOrigin('https://partner.example.com')).toBe(true);
    expect(isAllowedOrigin('https://emergency.oxy.dev')).toBe(true);
  });

  it('drops invalid OXY_EXTRA_ALLOWED_ORIGINS entries (scheme, port, path, injection)', () => {
    process.env.NODE_ENV = 'production';
    process.env.OXY_EXTRA_ALLOWED_ORIGINS =
      'http://insecure.example.com,https://bad.example.com:8443,https://bad.example.com/path,https://bad.example.com;evil,https://good.example.com';
    expect(isAllowedOrigin('http://insecure.example.com')).toBe(false);
    expect(isAllowedOrigin('https://bad.example.com:8443')).toBe(false);
    expect(isAllowedOrigin('https://bad.example.com/path')).toBe(false);
    expect(isAllowedOrigin('https://bad.example.com;evil')).toBe(false);
    expect(isAllowedOrigin('https://good.example.com')).toBe(true);
  });
});

describe('requireSameSiteOrigin', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = express();
    app.post('/test', requireSameSiteOrigin, (_req, res) => {
      res.json({ ok: true });
    });
    app.put('/test', requireSameSiteOrigin, (_req, res) => {
      res.json({ ok: true });
    });
    app.delete('/test', requireSameSiteOrigin, (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/test', requireSameSiteOrigin, (_req, res) => {
      res.json({ ok: true });
    });
    app.head('/test', requireSameSiteOrigin, (_req, res) => {
      res.status(200).end();
    });
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  interface GuardResponse {
    status: number;
    body: Record<string, unknown>;
  }

  async function request(
    method: string,
    headers: Record<string, string> = {}
  ): Promise<GuardResponse> {
    const address = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = http.request(
        { method, host: '127.0.0.1', port: address.port, path: '/test', headers },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            let parsed: Record<string, unknown> = {};
            if (raw.length > 0) {
              try {
                parsed = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                parsed = { _raw: raw };
              }
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  const BAD_ORIGIN_BODY = {
    error: {
      code: 'BAD_ORIGIN',
      message: 'Request origin is not allowed for this endpoint',
    },
  };

  it('passes allowlisted exact origins', async () => {
    const res = await request('POST', { origin: 'https://oxy.so' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('passes registered app origins', async () => {
    const res = await request('POST', { origin: 'https://accounts.oxy.so' });
    expect(res.status).toBe(200);
  });

  it('rejects a non-allowlisted origin with 403 BAD_ORIGIN and emits csrf.origin.reject', async () => {
    const res = await request('POST', { origin: 'https://evil.com' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(BAD_ORIGIN_BODY);
    expect(mockWarn).toHaveBeenCalledWith(
      'csrf.origin.reject',
      expect.objectContaining({
        origin: 'https://evil.com',
        path: '/test',
        method: 'POST',
      })
    );
  });

  it('rejects an http (non-https) origin in production, even for first-party hosts', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request('POST', { origin: 'http://oxy.so' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(BAD_ORIGIN_BODY);
  });

  it('passes http localhost origins outside production', async () => {
    process.env.NODE_ENV = 'development';
    const res = await request('POST', { origin: 'http://localhost:3000' });
    expect(res.status).toBe(200);
  });

  it('passes http localhost origins in production too (owner-approved)', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request('POST', { origin: 'http://localhost:3000' });
    expect(res.status).toBe(200);
  });

  it.each(['PUT', 'DELETE'])('applies to %s requests', async (method) => {
    const res = await request(method, { origin: 'https://evil.com' });
    expect(res.status).toBe(403);
  });

  it('passes when Origin is absent and Sec-Fetch-Site is same-origin', async () => {
    const res = await request('POST', { 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(200);
  });

  it('passes when Origin is absent and Sec-Fetch-Site is same-site', async () => {
    const res = await request('POST', { 'sec-fetch-site': 'same-site' });
    expect(res.status).toBe(200);
  });

  it('rejects when Origin is absent and Sec-Fetch-Site is cross-site', async () => {
    const res = await request('POST', { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(BAD_ORIGIN_BODY);
  });

  it('rejects when Origin is absent and Sec-Fetch-Site is none', async () => {
    const res = await request('POST', { 'sec-fetch-site': 'none' });
    expect(res.status).toBe(403);
  });

  it('passes when neither Origin nor Sec-Fetch-Site is present (legacy HTTP clients)', async () => {
    const res = await request('POST');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('does not block safe methods (GET) even from a bad origin', async () => {
    const res = await request('GET', { origin: 'https://evil.com' });
    expect(res.status).toBe(200);
  });

  it('does not block safe methods (HEAD) even from a bad origin', async () => {
    const res = await request('HEAD', { origin: 'https://evil.com' });
    expect(res.status).toBe(200);
  });

  // The raw-unicode homograph (`https://оxy.so`) is covered in the
  // isAllowedOrigin unit tests — Node refuses non-Latin1 header values
  // outright, and real browsers send the punycode form tested here.
  it.each([
    'https://oxy.so.evil.com',
    'https://oxy-so.example.com',
    'https://EVIL.oxy.so',
    'https://xn--xy-flc.so',
  ])('rejects attack origin %s', async (origin) => {
    const res = await request('POST', { origin });
    expect(res.status).toBe(403);
    expect(res.body).toEqual(BAD_ORIGIN_BODY);
  });

  it('ORIGIN_GUARD_MODE=log-only lets a bad origin through but still logs', async () => {
    process.env.ORIGIN_GUARD_MODE = 'log-only';
    const res = await request('POST', { origin: 'https://evil.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockWarn).toHaveBeenCalledWith(
      'csrf.origin.reject',
      expect.objectContaining({
        origin: 'https://evil.com',
        mode: 'log-only',
      })
    );
  });
});
