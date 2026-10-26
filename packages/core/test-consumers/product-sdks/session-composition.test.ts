import { expect, vi, test } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '@oxy.so/core';
// Only renderer hooks are stubbed: the published Alia transport source and packed
// Core HTTP/auth implementation execute unchanged against a real local server.
vi.mock('@oxy.so/services/ui/client', () => ({
  useOxy() {
    throw Error('renderer hook not used');
  },
  useAppAssertion() {
    throw Error('renderer hook not used');
  },
}));
const { createAliaApi } = await import('./node_modules/@alia.onl/sdk/src/runtime/api.ts');
const jwt = (userId: string, generation: number) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: `session-${userId}`, exp: Math.floor(Date.now() / 1000) + 300, generation })).toString('base64url')}.sig`;
test('published Alia session REST replays JSON once with packed Core refresh and fences account switches', async () => {
  const stale = jwt('A', 1),
    fresh = jwt('A', 2);
  const calls: Array<{ body: string; bearer?: string }> = [];
  let reached!: () => void, release!: () => void;
  const arrived = new Promise<void>((r) => (reached = r));
  const held = new Promise<void>((r) => (release = r));
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const p of req) body += p;
    calls.push({ body, bearer: req.headers.authorization });
    if (req.url === '/held') {
      reached();
      await held;
    }
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization === `Bearer ${stale}`) {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    res.end(JSON.stringify({ owner: 'A' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  oxy.session.setAccessToken(stale);
  let refreshes = 0;
  oxy.http.setAuthRefreshHandler(async () => {
    refreshes++;
    return fresh;
  });
  const alia = createAliaApi(oxy, baseURL);
  try {
    expect((await alia.post('/write', { synthetic: true })).data).toEqual({ owner: 'A' });
    expect(refreshes).toBe(1);
    expect(calls.map((x) => x.body)).toEqual(['{"synthetic":true}', '{"synthetic":true}']);
    expect(calls.map((x) => x.bearer)).toEqual([`Bearer ${stale}`, `Bearer ${fresh}`]);
    const pending = alia.get('/held');
    const result = pending.then(
      () => ({ ok: true }),
      (error) => ({ error }),
    );
    await arrived;
    oxy.session.setAccessToken(jwt('B', 1));
    release();
    expect(await result).toMatchObject({
      error: { name: 'OxyAuthenticationError', code: 'AUTH_SESSION_CHANGED' },
    });
  } finally {
    release();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
