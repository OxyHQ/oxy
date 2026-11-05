import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { OxyServices } from '../../OxyServices';
import { OxyServer } from '../OxyServer';

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({
  sessionId: 'session-test',
  userId: 'user-test',
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.signature`;

async function listen(app: express.Express) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: http.Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

it.each(['/required', '/optional'])(
  'keeps the bearer and propagates authority 503 through %s',
  async (path) => {
    let authorityRequests = 0;
    const authority = express();
    authority.get('/session/validate-header/:sessionId', (_req, res) => {
      authorityRequests += 1;
      res.status(503).json({ error: 'service_unavailable' });
    });
    const upstream = await listen(authority);
    const oxyServer = new OxyServer({ baseURL: upstream.url, maxRetries: 1, retryDelay: 1 });
    const app = express();
    app.get('/required', oxyServer.middleware.auth(), (_req, res) => res.json({ ok: true }));
    app.get('/optional', oxyServer.middleware.auth({ optional: true }), (_req, res) =>
      res.json({ ok: true }),
    );
    const downstream = await listen(app);
    const client = new OxyServices({ baseURL: downstream.url });
    client.session.setAccessToken(token);
    const epoch = client.http.getSessionEpoch();
    try {
      await expect(client.http.get(path, { retry: false, cache: false })).rejects.toMatchObject({
        status: 503,
      });
      expect(authorityRequests).toBeGreaterThan(0);
      expect(client.session.accessToken).toBe(token);
      expect(client.http.getSessionEpoch()).toBe(epoch);
    } finally {
      client.dispose();
      oxyServer.dispose();
      await close(downstream.server);
      await close(upstream.server);
    }
  },
);

it.each([401, 403])('retains the existing behavior for a confirmed %s refusal', async (status) => {
  const authority = express();
  authority.get('/session/validate-header/:sessionId', (_req, res) => {
    res.status(status).json({ error: 'refused' });
  });
  const upstream = await listen(authority);
  const oxyServer = new OxyServer({ baseURL: upstream.url, maxRetries: 1, retryDelay: 1 });
  const app = express();
  app.get('/required', oxyServer.middleware.auth(), (_req, res) => res.json({ ok: true }));
  const downstream = await listen(app);
  const client = new OxyServices({ baseURL: downstream.url });
  client.session.setAccessToken(token);
  const epoch = client.http.getSessionEpoch();
  try {
    await expect(
      client.http.get('/required', { retry: false, cache: false }),
    ).rejects.toMatchObject({
      status,
    });
    expect(client.session.accessToken).toBe(status === 401 ? null : token);
    if (status === 401) expect(client.http.getSessionEpoch()).toBeGreaterThan(epoch);
    else expect(client.http.getSessionEpoch()).toBe(epoch);
  } finally {
    client.dispose();
    oxyServer.dispose();
    await close(downstream.server);
    await close(upstream.server);
  }
});
