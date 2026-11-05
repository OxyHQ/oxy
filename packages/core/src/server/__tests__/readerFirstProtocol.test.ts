import { createServer, type Server } from 'node:http';
import { OxyServer } from '../OxyServer';
import { createEcosystemTraffic } from '../traffic';
let server: Server;
let baseURL: string;
const versions: number[] = [];
const received: string[] = [];
const issuedAt = Math.floor(Date.now() / 1000);
function serviceToken(version: number) {
  return `e30.${Buffer.from(JSON.stringify({ iat: issuedAt, exp: issuedAt + 300, version })).toString('base64url')}.sig`;
}
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/challenge')) return res.end(JSON.stringify({ nonce: 'test-nonce' }));
    if (req.url?.endsWith('/workload')) {
      const exchange = JSON.parse(body);
      expect(exchange.attestation.headers['x-amz-security-token']).toBe('temporary');
      expect(exchange.attestation.headers.authorization).toContain('Credential=ASIATEST/');
      const version = exchange.protocolVersion ?? 1;
      versions.push(version);
      return res.end(
        JSON.stringify({ token: serviceToken(version), expiresIn: 300, appName: 'test' }),
      );
    }
    received.push(req.headers.authorization ?? '');
    if (req.url?.startsWith('/internal/service-acting-as/verify')) {
      if (
        req.headers.authorization !== `Bearer ${serviceToken(2)}` ||
        req.headers['x-oxy-requester-token'] !== 'requester-proof'
      ) {
        res.statusCode = 403;
        return res.end('{}');
      }
      return res.end(JSON.stringify({ authorized: true, authority: 'first_party', epoch: '1' }));
    }
    if (req.url === '/auth/resources/introspect')
      return res.end(
        JSON.stringify({
          active: true,
          kind: 'session',
          permissions: [],
          authority: 'first_party',
          accountId: 'org',
          effectiveAccountId: 'org',
          requesterAccountId: 'human',
          applicationId: null,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      );
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  baseURL = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it('uses one v2 mint/cache for manual calls, namespaces, receiver introspection and product transport', async () => {
  const oxy = new OxyServer({
    baseURL,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIATEST',
      SecretAccessKey: 'secret',
      Token: 'temporary',
    }),
  });
  try {
    expect(await oxy.serviceToken()).toBe(serviceToken(2));
    await oxy.serviceRequest('GET', '/metadata');
    await expect(
      oxy.verifyActingAs('sender', 'person', { requesterToken: 'requester-proof' }),
    ).resolves.toEqual({ authorized: true, authority: 'first_party', epoch: '1' });
    const person = await oxy.introspectResourceToken('a-session');
    expect(person).toMatchObject({
      kind: 'session',
      authority: 'first_party',
      accountId: 'org',
      requesterAccountId: 'human',
    });
    expect(person).not.toHaveProperty('scopes');
    const client = oxy.createServiceClient({ baseURL, audience: 'oxy-api' });
    await client.fetch('/product');
    client.dispose();
    expect(await oxy.serviceToken()).toBe(serviceToken(2));
    expect(versions).toEqual([2]);
    expect(received).toHaveLength(4);
    expect(received.every((bearer) => bearer === `Bearer ${serviceToken(2)}`)).toBe(true);
  } finally {
    oxy.dispose();
  }
});

it('publishes activity through v2 with an injected role and no container environment', async () => {
  const startVersions = versions.length;
  const startRequests = received.length;
  const onError = jest.fn();
  const traffic = createEcosystemTraffic({
    service: 'test',
    region: 'us-west-2',
    baseURL,
    onError,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIATEST',
      SecretAccessKey: 'secret',
      Token: 'temporary',
    }),
  });
  await traffic.stop();
  expect(onError).not.toHaveBeenCalled();
  expect(versions.slice(startVersions)).toEqual([2]);
  expect(received.slice(startRequests)).toEqual([
    `Bearer ${serviceToken(2)}`,
    `Bearer ${serviceToken(2)}`,
  ]);
});

it('refreshes the shared workload cache once after a real product 401', async () => {
  let minted = 0;
  const tokenFor = (generation: number) =>
    `e30.${Buffer.from(JSON.stringify({ type: 'service', appId: 'own-app', credentialId: 'wl_test', ownerAccountId: 'owner', environment: 'development', aud: 'oxy-api', iss: 'oxy-auth', authority: 'first_party', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, generation })).toString('base64url')}.sig`;
  const tokens = [tokenFor(1), tokenFor(2)];
  const productBearers: string[] = [];
  const issuer = createServer(async (req, res) => {
    for await (const _part of req) {
      /* Drain request for connection reuse. */
    }
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/challenge')) return res.end(JSON.stringify({ nonce: 'refresh-proof' }));
    if (req.url?.endsWith('/workload')) {
      minted += 1;
      return res.end(
        JSON.stringify({ token: tokens[minted - 1], expiresIn: 300, appName: 'refresh' }),
      );
    }
    productBearers.push(req.headers.authorization ?? '');
    if (req.headers.authorization === `Bearer ${tokens[0]}`) res.statusCode = 401;
    res.end('{}');
  });
  await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', resolve));
  const address = issuer.address();
  if (!address || typeof address === 'string') throw new Error('Missing refresh port');
  const origin = `http://127.0.0.1:${address.port}`;
  const oxy = new OxyServer({
    baseURL: origin,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIATEST',
      SecretAccessKey: 'secret',
      Token: 'temporary',
    }),
  });
  const transport = oxy.createServiceClient({ baseURL: origin, audience: 'oxy-api' });
  try {
    expect(await oxy.serviceToken()).toBe(tokens[0]);
    const response = await transport.fetch('/product');
    expect(response.status).toBe(200);
    await response.text();
    expect(productBearers).toEqual(tokens.map((token) => `Bearer ${token}`));
    expect(minted).toBe(2);
    expect(await oxy.serviceToken()).toBe(tokens[1]);
  } finally {
    transport.dispose();
    oxy.dispose();
    await new Promise<void>((resolve) => issuer.close(() => resolve()));
  }
});
