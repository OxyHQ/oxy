import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { OxyServices } from '../../OxyServices';
import { OxyServer } from '../OxyServer';

const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
const bearer = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sessionId: 's', userId: 'u', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(server: http.Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const valid = {
  valid: true,
  user: { id: 'u' },
  sessionId: 's',
  actor: { schemaVersion: 1, effectiveAccountId: 'u', actorAccountId: 'u', delegated: false },
  expiresAt: '2030-01-01T00:00:00Z',
  lastActivity: '2029-01-01T00:00:00Z',
};

it('refuses an injected live option on the public client without sending a request', async () => {
  const authority = express();
  let requests = 0;
  authority.use((_req, res) => {
    requests++;
    res.json(valid);
  });
  const upstream = await listen(authority);
  const client = new OxyServices({ baseURL: upstream.baseURL });
  client.session.setAccessToken(bearer);
  const epoch = client.http.getSessionEpoch();
  try {
    const injected = { accessToken: bearer, liveSession: true } as { accessToken: string };
    await expect(client.session.validate('s', injected)).rejects.toMatchObject({ status: 503 });
    expect(requests).toBe(0);
    expect(client.session.accessToken).toBe(bearer);
    expect(client.http.getSessionEpoch()).toBe(epoch);
  } finally {
    client.dispose();
    await close(upstream.server);
  }
});

it.each([
  ['old successful server', 200, valid, 503, false],
  ['old unauthorized server', 401, { message: 'Invalid session' }, 503, false],
  ['old forbidden server', 403, { message: 'Forbidden' }, 503, false],
  ['old missing endpoint', 404, {}, 503, false],
  ['rate limited authority', 429, {}, 503, false],
  ['unavailable authority', 503, {}, 503, false],
  [
    'marked success with expired session',
    200,
    { ...valid, expiresAt: '2020-01-01T00:00:00Z', liveSessionAuthority: 'session-row-v1' },
    503,
    false,
  ],
  [
    'unmarked invalid payload',
    200,
    { ...valid, valid: false, liveSessionAuthority: 'session-row-v1' },
    503,
    false,
  ],
  [
    'wrong session in payload',
    200,
    { ...valid, sessionId: 'other', liveSessionAuthority: 'session-row-v1' },
    503,
    false,
  ],
  [
    'missing actor in payload',
    200,
    { ...valid, actor: null, liveSessionAuthority: 'session-row-v1' },
    503,
    false,
  ],
  [
    'confirmed invalid session',
    401,
    { error: { code: 'OXY_LIVE_SESSION_INVALID_V1', message: 'Invalid' } },
    401,
    true,
  ],
  [
    'confirmed policy denial',
    403,
    { error: { code: 'OXY_LIVE_SESSION_POLICY_V1', message: 'Denied' } },
    403,
    false,
  ],
  ['confirmed active row', 200, { ...valid, liveSessionAuthority: 'session-row-v1' }, 200, false],
] as const)(
  '%s is resolved without a silent fallback',
  async (_name, status, body, expected, clearsBearer) => {
    const authority = express();
    let header: string | undefined;
    let cacheControl: string | undefined;
    let requests = 0;
    authority.get('/session/validate-header/:sessionId', (req, res) => {
      requests++;
      header = req.header('x-oxy-session-authority');
      cacheControl = req.header('cache-control');
      res.status(status).json(body);
    });
    const upstream = await listen(authority);
    const oxy = new OxyServer({ baseURL: upstream.baseURL, maxRetries: 1, retryDelay: 1 });
    const app = express();
    app.get('/private', oxy.middleware.auth({ liveSession: true }), (_req, res) =>
      res.json({ ok: true }),
    );
    const downstream = await listen(app);
    const client = new OxyServices({ baseURL: downstream.baseURL });
    client.session.setAccessToken(bearer);
    const epoch = client.http.getSessionEpoch();
    try {
      if (expected === 200) {
        await expect(client.http.get('/private', { retry: false, cache: false })).resolves.toEqual({
          ok: true,
        });
      } else {
        await expect(
          client.http.get('/private', { retry: false, cache: false }),
        ).rejects.toMatchObject({ status: expected });
      }
      expect(header).toBe('live-v1');
      expect(cacheControl).toBe('no-store');
      expect(requests).toBe(1);
      expect(client.session.accessToken).toBe(clearsBearer ? null : bearer);
      if (clearsBearer) expect(client.http.getSessionEpoch()).toBeGreaterThan(epoch);
      else expect(client.http.getSessionEpoch()).toBe(epoch);
    } finally {
      client.dispose();
      oxy.dispose();
      await close(downstream.server);
      await close(upstream.server);
    }
  },
);
