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
  jest.spyOn(oxy, 'serviceToken').mockResolvedValue('workload');
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

it('isolates operation clients across private graph and Files reads, ignores forged proof headers and never caches a revoked ticket', async () => {
  const seen: string[] = [];
  let revoked = false;
  const server = createServer((req, res) => {
    const proof = req.headers['x-oxy-capability-ticket'];
    if (typeof proof === 'string') seen.push(proof);
    expect(req.headers['x-oxy-task-id']).toBeUndefined();
    expect(req.headers['x-oxy-requester-token']).toBeUndefined();
    expect(req.headers.authorization).toBe('Bearer workload');
    res.writeHead(revoked ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(revoked ? { error: 'revoked' } : { data: { proof } }));
  });
  const baseURL = await listen(server);
  const oxy = new OxyServer({ baseURL, enableRetry: false });
  jest.spyOn(oxy, 'serviceToken').mockResolvedValue('workload');
  const proof = { capabilityTicket: 'operation-A' };
  const a = oxy.withRequester(proof);
  const b = oxy.withRequester({ capabilityTicket: 'operation-B' });
  proof.capabilityTicket = 'mutated';
  try {
    const [first, second] = await Promise.all([a.follows.viewerGraph(), b.follows.viewerGraph()]);
    expect(first).toEqual({ proof: 'operation-A' });
    expect(second).toEqual({ proof: 'operation-B' });
    expect(
      await a.request('GET', '/privacy/blocked', undefined, {
        headers: {
          'x-oxy-capability-ticket': 'forged',
          'X-Oxy-Task-Id': 'forged',
          'X-Oxy-Requester-Token': 'forged',
        },
        cache: true,
        deduplicate: true,
      }),
    ).toEqual({ proof: 'operation-A' });
    expect(await oxy.assets.withRequester({ capabilityTicket: 'operation-A' }).get('file')).toEqual(
      { proof: 'operation-A' },
    );
    revoked = true;
    await expect(a.follows.viewerGraph()).rejects.toBeDefined();
    expect(seen).toHaveLength(5);
    await expect(a.request('GET', 'https://unrelated.invalid/private')).rejects.toThrow(
      'configured API origin',
    );
    expect(seen).toHaveLength(5);
  } finally {
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('keeps an external MCP media proof separate and confines it to its exact media transport', async () => {
  const calls: { token: unknown; tool: unknown; owner: unknown }[] = [];
  let revoked = false;
  const server = createServer((req, res) => {
    calls.push({
      token: req.headers['x-oxy-mcp-media-token'],
      tool: req.headers['x-oxy-mcp-media-tool'],
      owner: req.headers['x-owner-user-id'],
    });
    expect(req.headers['x-oxy-requester-token']).toBeUndefined();
    expect(req.headers['x-oxy-task-id']).toBeUndefined();
    expect(req.headers['x-oxy-capability-ticket']).toBeUndefined();
    expect(req.headers.authorization).toBe('Bearer workload');
    req.resume();
    res.writeHead(revoked ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(revoked ? { error: 'revoked' } : { data: { file: { id: 'media' } } }));
  });
  const baseURL = await listen(server);
  const oxy = new OxyServer({ baseURL, enableRetry: false });
  jest.spyOn(oxy, 'serviceToken').mockResolvedValue('workload');
  try {
    const proof = {
      connectionToken: 'external-original',
      tool: 'upload-media' as const,
      accountId: 'account',
    };
    const media = oxy.assets.withMcpMediaRequester(proof);
    proof.connectionToken = 'mutated';
    expect(await media.uploadUserMedia('account', new Uint8Array([1]), 'image/png')).toEqual({
      id: 'media',
    });
    expect(media).not.toHaveProperty('get');
    await expect(
      media.importUserMedia('account', 'https://example.test/image.png'),
    ).rejects.toThrow('limited');
    expect(calls).toEqual([{ token: 'external-original', tool: 'upload-media', owner: 'account' }]);
    const urls = oxy.assets.withMcpMediaRequester({
      connectionToken: 'external-url',
      tool: 'upload-media-from-url',
    });
    await urls.importUserMedia('account', 'https://example.test/image.png');
    revoked = true;
    await expect(
      urls.importUserMedia('account', 'https://example.test/image.png'),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(3);
  } finally {
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('keeps forwarded contexts isolated across namespace reads and strips a forged presented service token', async () => {
  const seen: unknown[] = [];
  let revoked = false;
  const server = createServer((req, res) => {
    const proof = req.headers['x-oxy-requester-context'];
    seen.push(proof);
    expect(req.headers['x-oxy-presented-service-token']).toBeUndefined();
    expect(req.headers['x-oxy-presented-requester-context']).toBeUndefined();
    res.writeHead(revoked ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(revoked ? { error: 'revoked' } : { data: { proof } }));
  });
  const baseURL = await listen(server);
  const oxy = new OxyServer({ baseURL, enableRetry: false });
  jest.spyOn(oxy, 'serviceToken').mockResolvedValue('workload');
  try {
    const a = oxy.withRequester({ requesterContext: 'context-A' }),
      b = oxy.withRequester({ requesterContext: 'context-B' });
    const answers = await Promise.all([
      a.request('GET', '/users/me/graph', undefined, {
        headers: {
          'X-Oxy-Presented-Service-Token': 'forged',
          'X-Oxy-Presented-Requester-Context': 'forged',
        },
      }),
      b.request('GET', '/users/me/graph'),
    ]);
    expect(answers).toEqual([{ proof: 'context-A' }, { proof: 'context-B' }]);
    revoked = true;
    await expect(a.request('GET', '/users/me/graph')).rejects.toBeDefined();
    expect(seen.slice(0, 2).sort()).toEqual(['context-A', 'context-B']);
    expect(seen.slice(2)).toEqual(['context-A']);
  } finally {
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
