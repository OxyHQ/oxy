/**
 * `createOxyCors` over a REAL socket, plus the two halves of the opaque-origin
 * guard.
 *
 * `cors.test.ts` drives the middleware with a fake `Request`/`Response` pair,
 * which is fine for header bookkeeping but cannot answer the question this
 * suite exists for: what a client actually receives. These tests start an
 * Express app on an ephemeral port and read the response headers off the wire.
 *
 * `node:http` rather than `fetch`: `Origin` is a forbidden header name for
 * `fetch`, so the request under test has to be built by hand.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { configureLogger, resetLoggerConfig } from '../../logger';
import type { LogEntry } from '../../logger';
import { createOxyCors, matchesAllowedOrigin, normalizeAppOrigins } from '../cors';
import type { OxyCorsOptions } from '../cors';

interface CorsResponse {
  status: number;
  allowOrigin: string | undefined;
  allowCredentials: string | undefined;
}

/** Start an Express app carrying `createOxyCors(options)` on an ephemeral port. */
async function startServer(options: OxyCorsOptions): Promise<http.Server> {
  const app = express();
  app.use(createOxyCors(options));
  app.get('/catalogue', (_req, res) => {
    res.json({ ok: true });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Issue a real request carrying `Origin` and read the CORS headers back. */
function requestWithOrigin(
  server: http.Server,
  method: 'GET' | 'OPTIONS',
  origin: string,
): Promise<CorsResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: '/catalogue',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            allowOrigin: res.headers['access-control-allow-origin'],
            allowCredentials: res.headers['access-control-allow-credentials'],
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * The exact shape that was live: one custom-scheme entry alongside ordinary
 * ones. Every origin below normalizes to the opaque origin, so before the fix
 * the `exp://` entry admitted all of them.
 */
const CONFIGURED_WITH_OPAQUE_ENTRY = ['https://app.example.com', 'exp://localhost:8150'];
const OTHER_OPAQUE_SCHEME_ORIGINS = [
  'vscode-webview://abc123',
  'capacitor://localhost',
  'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'file://',
];

describe('createOxyCors over a real socket', () => {
  let server: http.Server;

  beforeAll(async () => {
    // The dropped entry logs at error level by design; that log is asserted in
    // the configure-side suite below. Swallow it here so this suite's output
    // carries only its own failures.
    configureLogger({ sink: () => undefined });
    server = await startServer({ appOrigins: CONFIGURED_WITH_OPAQUE_ENTRY });
    resetLoggerConfig();
  });

  afterAll(async () => {
    await stopServer(server);
  });

  it('POSITIVE CONTROL: a configured https origin gets its headers over the wire', async () => {
    for (const method of ['GET', 'OPTIONS'] as const) {
      const res = await requestWithOrigin(server, method, 'https://app.example.com');
      expect(res.allowOrigin).toBe('https://app.example.com');
      expect(res.allowCredentials).toBe('true');
    }
  });

  it('POSITIVE CONTROL: the built-in Oxy apex family still gets its headers', async () => {
    const res = await requestWithOrigin(server, 'GET', 'https://auth.oxy.so');
    expect(res.allowOrigin).toBe('https://auth.oxy.so');
    expect(res.allowCredentials).toBe('true');
  });

  it('a custom-scheme origin is NOT admitted by a custom-scheme allowlist entry', async () => {
    for (const origin of OTHER_OPAQUE_SCHEME_ORIGINS) {
      for (const method of ['GET', 'OPTIONS'] as const) {
        const res = await requestWithOrigin(server, method, origin);
        expect(res.allowOrigin).toBeUndefined();
        expect(res.allowCredentials).toBeUndefined();
      }
    }
  });

  it('the opaque-origin entry does not admit even ITSELF', async () => {
    const res = await requestWithOrigin(server, 'GET', 'exp://localhost:8150');
    expect(res.allowOrigin).toBeUndefined();
    expect(res.allowCredentials).toBeUndefined();
  });

  it('NEGATIVE CONTROL: a literal `Origin: null` is refused, as it always was', async () => {
    const res = await requestWithOrigin(server, 'GET', 'null');
    expect(res.allowOrigin).toBeUndefined();
    expect(res.allowCredentials).toBeUndefined();
  });

  it('NEGATIVE CONTROL: an unrelated https origin is refused', async () => {
    const res = await requestWithOrigin(server, 'GET', 'https://evil.example.com');
    expect(res.allowOrigin).toBeUndefined();
    expect(res.allowCredentials).toBeUndefined();
  });
});

/**
 * The CONFIGURE-SIDE half. Its behavioural effect is masked by the match-side
 * half — with both in place, deleting this one changes no response — so what
 * this suite asserts is the observable the drop-rather-than-throw decision
 * rests on: the entry is named in an error log, and nothing else stops.
 */
describe('normalizeAppOrigins (configure side)', () => {
  let entries: LogEntry[];

  beforeEach(() => {
    entries = [];
    configureLogger({ sink: (entry) => entries.push(entry) });
  });

  afterEach(() => {
    resetLoggerConfig();
  });

  it('drops an opaque-origin entry from the set and names it in an error log', () => {
    const explicit = normalizeAppOrigins(CONFIGURED_WITH_OPAQUE_ENTRY);

    expect([...explicit]).toEqual(['https://app.example.com']);
    expect(explicit.has('null')).toBe(false);

    const dropped = entries.filter((entry) => entry.level === 'error');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.context?.entry).toBe('exp://localhost:8150');
    expect(dropped[0]?.message).toContain('no origin to match against');
  });

  it('drops an entry that is not a URL at all, separately named', () => {
    const explicit = normalizeAppOrigins(['not a url', 'https://app.example.com']);

    expect([...explicit]).toEqual(['https://app.example.com']);
    const dropped = entries.filter((entry) => entry.level === 'error');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.context?.entry).toBe('not a url');
    expect(dropped[0]?.message).toContain('not a URL');
  });

  it('VACUITY FLOOR: a wholly valid list is dropped from silently', () => {
    const explicit = normalizeAppOrigins(['https://app.example.com', 'http://localhost:3000']);

    expect([...explicit].sort()).toEqual(['http://localhost:3000', 'https://app.example.com']);
    expect(entries.filter((entry) => entry.level === 'error')).toHaveLength(0);
  });
});

/**
 * The MATCH-SIDE half, driven with the hostile precondition the configure side
 * prevents: a set that already contains the opaque origin. This is the only
 * way to observe this half — through `createOxyCors` it is unreachable, so a
 * test there would measure `normalizeAppOrigins` and report on this.
 */
describe('matchesAllowedOrigin (match side)', () => {
  const poisoned: ReadonlySet<string> = new Set(['null', 'https://app.example.com']);

  it('refuses every opaque-scheme origin even against a set containing "null"', () => {
    for (const origin of [...OTHER_OPAQUE_SCHEME_ORIGINS, 'exp://localhost:8150']) {
      expect(matchesAllowedOrigin(poisoned, origin)).toBe(false);
    }
  });

  it('POSITIVE CONTROL: the same poisoned set still matches its real entry', () => {
    expect(matchesAllowedOrigin(poisoned, 'https://app.example.com')).toBe(true);
    expect(matchesAllowedOrigin(poisoned, 'https://auth.oxy.so')).toBe(true);
    expect(matchesAllowedOrigin(poisoned, 'https://evil.example.com')).toBe(false);
  });

  it('NEGATIVE CONTROL: a literal `null` never reaches the set lookup either', () => {
    expect(matchesAllowedOrigin(poisoned, 'null')).toBe(false);
  });
});
