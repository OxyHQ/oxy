import { createServer, type Server } from 'node:http';
import { OxyServer } from '../OxyServer';
import { postOxyServiceJson } from '../../../../mcp/src/serviceRequest';
import { introspectOxyMcpAccessToken } from '../../../../mcp/src/introspection';
import {
  registerCapabilityCatalog,
  capabilityCatalogDigest,
} from '../../../../mcp/src/catalogRegistration';
import type { AppCapabilityCatalog } from '@oxy.so/contracts';
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  return `http://127.0.0.1:${address.port}`;
}
const catalog: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: 'test',
  version: '1.0.0',
  audience: 'test-api',
  internalBaseUrl: 'https://api.example.test',
  accountResourceType: 'account',
  internalTransport: 'mcp',
  tools: [
    {
      name: 'read',
      version: '1.0.0',
      description: 'Read.',
      inputSchema: { type: 'object' },
      capabilityPackage: 'read',
      requiredCapabilities: ['read'],
      resourceTypes: ['account'],
      effect: 'read',
      idempotency: 'none',
      rollback: 'none',
      exposure: ['internal'],
      limitKeys: [],
      invocation: { method: 'GET', path: '/read' },
    },
  ],
  events: [],
};
it('shares core workload mint, origin, refresh and fixed requester transport across MCP authority calls', async () => {
  const minted: unknown[] = [];
  const subjects: string[] = [];
  let foreignDeliveries = 0;
  let refusals = 0;
  let introspections = 0;
  let revoked = false;
  const foreign = createServer((_req, res) => {
    foreignDeliveries++;
    res.end('{}');
  });
  const foreignURL = await listen(foreign);
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/challenge')) return res.end(JSON.stringify({ nonce: 'nonce' }));
    if (req.url?.endsWith('/workload')) {
      const exchange = JSON.parse(body);
      minted.push(exchange);
      const now = Math.floor(Date.now() / 1000);
      const token = `e30.${Buffer.from(JSON.stringify({ type: 'service', authority: 'first_party', appId: 'test-app', credentialId: 'wl_test', ownerAccountId: 'owner', environment: 'development', iss: 'oxy-auth', iat: now, exp: now + 300, aud: exchange.audience ?? 'oxy-api', protocol: exchange.protocolVersion, nonce: minted.length })).toString('base64url')}.sig`;
      return res.end(JSON.stringify({ token, expiresIn: 300 }));
    }
    const token = req.headers.authorization?.slice(7);
    const claims = token
      ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      : {};
    if (claims.protocol !== 2 || claims.aud !== 'oxy-api') {
      res.statusCode = 403;
      return res.end('{}');
    }
    if (req.url === '/capabilities/catalogs/register')
      return res.end(
        JSON.stringify({
          registration: {
            id: 'registered',
            version: catalog.version,
            digest: capabilityCatalogDigest(JSON.parse(body).catalog),
          },
        }),
      );
    if (req.url === '/redirect') {
      res.writeHead(302, { location: foreignURL });
      return res.end();
    }
    if (req.url === '/always401') {
      refusals++;
      res.statusCode = 401;
      return res.end('{}');
    }
    if (req.url === '/introspect') {
      introspections++;
      return res.end('{"active":false}');
    }
    const account = String(req.headers['x-oxy-user-id']);
    subjects.push(account);
    if (revoked) {
      res.statusCode = 403;
      return res.end('{"error":"revoked"}');
    }
    res.end(JSON.stringify({ account, task: req.headers['x-oxy-task-id'] }));
  });
  const baseURL = await listen(server);
  const oxy = new OxyServer({
    baseURL,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIATEST',
      SecretAccessKey: 'secret',
      Token: 'temporary',
    }),
  });
  const processClient = oxy.createServiceClient({ baseURL, audience: 'oxy-api' });
  const a = oxy.createServiceClient({
    baseURL,
    audience: 'oxy-api',
    requester: { accountId: 'A', taskId: 'task-A' },
  });
  const b = oxy.createServiceClient({
    baseURL,
    audience: 'oxy-api',
    requester: { accountId: 'B', taskId: 'task-B' },
  });
  try {
    expect(
      await registerCapabilityCatalog(catalog, { oxyApiUrl: baseURL, transport: processClient }),
    ).toMatchObject({ registrationId: 'registered' });
    const results = await Promise.all(
      [a, b].map((transport) =>
        postOxyServiceJson({}, { endpoint: `${baseURL}/audit`, transport }),
      ),
    );
    expect(results).toEqual([
      { account: 'A', task: 'task-A' },
      { account: 'B', task: 'task-B' },
    ]);
    expect(minted).toHaveLength(1);
    await expect(postOxyServiceJson({}, { endpoint: foreignURL, transport: a })).rejects.toThrow(
      'configured API origin',
    );
    await expect(
      postOxyServiceJson({}, { endpoint: `${baseURL}/redirect`, transport: a }),
    ).rejects.toBeDefined();
    expect(foreignDeliveries).toBe(0);
    for (let i = 0; i < 2; i++)
      expect(
        await introspectOxyMcpAccessToken('external-access', {
          endpoint: `${baseURL}/introspect`,
          transport: processClient,
        }),
      ).toBeNull();
    expect(introspections).toBe(2);
    await expect(
      postOxyServiceJson({}, { endpoint: `${baseURL}/always401`, transport: processClient }),
    ).rejects.toMatchObject({ status: 401 });
    expect(refusals).toBe(2);
    expect(minted).toHaveLength(2);
    revoked = true;
    await expect(
      postOxyServiceJson({}, { endpoint: `${baseURL}/audit`, transport: a }),
    ).rejects.toMatchObject({ status: 403 });
    expect(subjects).toHaveLength(3);
  } finally {
    for (const client of [a, b, processClient]) client.dispose();
    oxy.dispose();
    for (const current of [server, foreign]) {
      current.closeAllConnections();
      await new Promise<void>((resolve) => current.close(() => resolve()));
    }
  }
});

it('cancels MCP during workload preparation without cancelling another consumer or sending the abandoned operation', async () => {
  let challengeArrived!: () => void;
  const waiting = new Promise<void>((resolve) => {
    challengeArrived = resolve;
  });
  let releaseChallenge!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseChallenge = resolve;
  });
  const operations: string[] = [];
  let exchanges = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/challenge')) {
      challengeArrived();
      await release;
      return res.end('{"nonce":"nonce"}');
    }
    if (req.url?.endsWith('/workload')) {
      exchanges++;
      const token = `e30.${Buffer.from(JSON.stringify({ sub: 'workload', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.sig`;
      return res.end(JSON.stringify({ token, expiresIn: 300 }));
    }
    operations.push(req.url ?? '');
    res.end('{"ok":true}');
  });
  const baseURL = await listen(server);
  const oxy = new OxyServer({
    baseURL,
    workloadCredentials: async () => ({ AccessKeyId: 'ASIATEST', SecretAccessKey: 'test' }),
  });
  const transport = oxy.createServiceClient({ baseURL, audience: 'oxy-api' });
  try {
    const cancelled = postOxyServiceJson(
      {},
      { endpoint: `${baseURL}/abandoned`, transport, timeoutMs: 50 },
    );
    // Install the handler before triggering cancellation, including under CI load.
    const rejected = expect(cancelled).rejects.toBeDefined();
    await waiting;
    const survivor = postOxyServiceJson({}, { endpoint: `${baseURL}/survivor`, transport });
    await rejected;
    expect(operations).toEqual([]);
    releaseChallenge();
    expect(await survivor).toEqual({ ok: true });
    expect(exchanges).toBe(1);
    expect(operations).toEqual(['/survivor']);
  } finally {
    releaseChallenge();
    transport.dispose();
    oxy.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
