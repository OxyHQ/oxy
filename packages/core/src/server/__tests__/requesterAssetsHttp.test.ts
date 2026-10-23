jest.mock('../workloadIdentity', () => ({
  canAttestWorkloadIdentity: () => true,
  requestWorkloadServiceToken: jest.fn(async () => ({
    token: 'workload',
    expiresIn: 300,
    appName: 'test',
  })),
}));
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OxyServer } from '../OxyServer';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(() => jest.restoreAllMocks());

it('routes inherited Files reads through each fixed proof and checks revocation before downloading again', async () => {
  const calls: { path: string; proof?: string; authorization?: string }[] = [];
  const downloads: string[] = [];
  let revoked = false;
  let baseURL = '';
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    const proof = (req.headers['x-oxy-task-id'] ?? req.headers['x-oxy-requester-token']) as
      | string
      | undefined;
    if (path.startsWith('/bytes/')) {
      expect(proof).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
      expect(req.headers.cookie).toBeUndefined();
      downloads.push(path);
      res.end(path.endsWith('/A') ? 'private A' : 'private B');
      return;
    }
    calls.push({ path, proof, authorization: req.headers.authorization });
    const account = proof === 'task-A' ? 'A' : proof === 'session-B' ? 'B' : undefined;
    if (!account || revoked || req.headers.authorization !== 'Bearer workload') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"revoked"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: path.endsWith('/url')
          ? { url: `${baseURL}/bytes/${account}` }
          : path === '/assets'
            ? { files: [{ id: account }], total: 1, hasMore: false }
            : { assetId: 'private', file: { id: 'private', owner: account } },
      }),
    );
  });
  baseURL = await listen(server);
  const oxy = new OxyServer({ baseURL, enableRetry: false });
  oxy.http.setTokens('unrelated-shared-session');
  const actualFetch = globalThis.fetch;
  const fetch = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation((input, init) => actualFetch(input, init));
  try {
    const a = oxy.assets.withRequester({ taskId: 'task-A' });
    const b = oxy.assets.withRequester({ requesterToken: 'session-B' });
    const [metaA, metaB] = await Promise.all([a.get('private'), b.get('private')]);
    expect(metaA.file).toMatchObject({ owner: 'A' });
    expect(metaB.file).toMatchObject({ owner: 'B' });
    expect(await (await a.blob('private')).text()).toBe('private A');
    expect(await b.text('private')).toBe('private B');
    expect(await a.url('private')).toBe(`${baseURL}/bytes/A`);
    expect((await b.list()).files).toEqual([{ id: 'B' }]);
    expect(oxy.http.getAccessToken()).toBe('unrelated-shared-session');
    expect(calls.every((call) => call.authorization === 'Bearer workload')).toBe(true);
    for (const [input, init] of fetch.mock.calls) {
      if (String(input).includes('/bytes/')) expect(init?.credentials).toBe('omit');
    }
    const previous = calls.length;
    revoked = true;
    await expect(a.get('private')).rejects.toBeDefined();
    await expect(a.blob('private')).rejects.toBeDefined();
    await expect(b.text('private')).rejects.toBeDefined();
    await expect(a.url('private')).rejects.toBeDefined();
    expect(calls.length).toBe(previous + 4);
    expect(downloads).toEqual(['/bytes/A', '/bytes/B']);
  } finally {
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
