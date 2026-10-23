import { createServer, type Server } from 'node:http';
import { OxyServer } from '../OxyServer';
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
      const version = JSON.parse(body).protocolVersion ?? 1;
      versions.push(version);
      return res.end(
        JSON.stringify({ token: serviceToken(version), expiresIn: 300, appName: 'test' }),
      );
    }
    received.push(req.headers.authorization ?? '');
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
it('isolates legacy manual mint/cache from v2 namespaces, receiver introspection and product transport', async () => {
  const oxy = new OxyServer({
    baseURL,
    workloadCredentials: async () => ({
      accessKeyId: 'ASIATEST',
      secretAccessKey: 'secret',
      sessionToken: 'temporary',
      expiration: new Date(Date.now() + 3600000),
    }),
  });
  try {
    expect(await oxy.serviceToken()).toBe(serviceToken(1));
    await oxy.serviceRequest('GET', '/metadata');
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
    expect(await oxy.serviceToken()).toBe(serviceToken(1));
    expect(versions).toEqual([1, 2]);
    expect(received).toHaveLength(3);
    expect(received.every((bearer) => bearer === `Bearer ${serviceToken(2)}`)).toBe(true);
  } finally {
    oxy.dispose();
  }
});
