import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServices } from '../OxyServices';

let server: Server;
let origin: string;
let foreign: Server;
let foreignOrigin: string;
let foreignCalls = 0;
let release: (() => void) | undefined;
let arrived: (() => void) | undefined;
const seen: Array<{ authorization?: string; cookie?: string }> = [];
function token(userId: string) {
  return `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp: 2_000_000_000 })).toString('base64url')}.fixture`;
}
async function listen(value: Server) {
  await new Promise<void>((resolve) => value.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(value.address() as AddressInfo).port}`;
}
beforeAll(async () => {
  foreign = createServer((_req, res) => {
    foreignCalls++;
    res.end('foreign');
  });
  foreignOrigin = await listen(foreign);
  server = createServer(async (req, res) => {
    seen.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
    if (req.url === '/held') {
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      arrived?.();
      await ready;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: foreignOrigin });
      return res.end();
    }
    res.writeHead(req.url === '/private' && !req.headers.authorization ? 401 : 200);
    res.end('public-or-own');
  });
  origin = await listen(server);
});
afterAll(async () => {
  release?.();
  await Promise.all(
    [server, foreign].map(async (value) => {
      value.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        value.close((error) => (error ? reject(error) : resolve())),
      );
    }),
  );
});
it('serves anonymous public endpoints and attaches only the current session when present', async () => {
  const oxy = new OxyServices({ baseURL: origin });
  const linked = oxy.createLinkedClient({ baseURL: origin });
  try {
    const request = new Request(`${origin}/public`, {
      headers: { authorization: 'Bearer forged', cookie: 'ambient=1' },
    });
    expect(await (await linked.fetchOptional(request)).text()).toBe('public-or-own');
    expect(seen.at(-1)).toEqual({ authorization: undefined, cookie: undefined });
    expect((await linked.fetchOptional(`${origin}/private`)).status).toBe(401);
    await expect(linked.fetch(`${origin}/public`)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    oxy.session.setAccessToken(token('A'));
    await linked.fetchOptional(request);
    expect(seen.at(-1)).toEqual({ authorization: `Bearer ${token('A')}`, cookie: undefined });
    await expect(linked.fetchOptional(`${origin}/redirect`)).rejects.toMatchObject({
      message: expect.any(String),
    });
    const refresh = jest.fn(async () => token('A'));
    oxy.http.setAuthRefreshHandler(refresh);
    await expect(linked.fetchOptional(foreignOrigin)).rejects.toThrow('configured API origin');
    expect(refresh).not.toHaveBeenCalled();
    expect(foreignCalls).toBe(0);
    linked.dispose();
    await expect(linked.fetchOptional(request)).rejects.toThrow('disposed');
  } finally {
    linked.dispose();
    oxy.dispose();
  }
});
it.each(['switch', 'logout', 'signin'] as const)(
  'refuses a response after %s changes its session context',
  async (change) => {
    const oxy = new OxyServices({ baseURL: origin });
    if (change !== 'signin') oxy.session.setAccessToken(token('A'));
    const linked = oxy.createLinkedClient({ baseURL: origin });
    try {
      const ready = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const result = linked.fetchOptional(`${origin}/held`);
      await ready;
      if (change === 'logout') oxy.session.clear();
      else oxy.session.setAccessToken(token('B'));
      release?.();
      await expect(result).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    } finally {
      release?.();
      arrived = undefined;
      linked.dispose();
      oxy.dispose();
    }
  },
);

it('disables the browser HTTP cache across anonymous and account-bound reads even when the caller requests caching', async () => {
  const oxy = new OxyServices({ baseURL: origin });
  const linked = oxy.createLinkedClient({ baseURL: origin });
  const networkFetch = globalThis.fetch;
  const policies: Array<RequestCache | undefined> = [];
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    policies.push(init?.cache);
    return networkFetch(input, init);
  });
  try {
    await (await linked.fetchOptional('/public', { cache: 'force-cache' })).text();
    oxy.session.setAccessToken(token('cache-account-A'));
    await (await linked.fetch('/private', { cache: 'force-cache' })).text();
    oxy.session.setAccessToken(token('cache-account-B'));
    await (await linked.fetchOptional('/private', { cache: 'force-cache' })).text();
    expect(policies).toEqual(['no-store', 'no-store', 'no-store']);
    expect(seen.slice(-3).map(({ authorization }) => authorization)).toEqual([
      undefined,
      `Bearer ${token('cache-account-A')}`,
      `Bearer ${token('cache-account-B')}`,
    ]);
  } finally {
    spy.mockRestore();
    linked.dispose();
    oxy.dispose();
  }
});
