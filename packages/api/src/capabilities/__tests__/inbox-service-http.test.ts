/** Actual Core transport + AWS role provider + HTTP issuer/recipient; no bearer callback. */
import { createServer, type Server } from 'node:http';
import { capabilityCatalogDigest } from '@oxy.so/mcp';
import { buildInboxMessageEvents } from '../inbox.events';
import { INBOX_CAPABILITY_CATALOG } from '../inbox.catalog';

const mockRole = jest.fn(async () => ({
  accessKeyId: 'ASIAROLE',
  secretAccessKey: 'synthetic-secret',
  sessionToken: 'temporary-session',
  expiration: new Date(Date.now() + 3600000),
}));
jest.mock('@aws-sdk/credential-provider-node', () => ({ defaultProvider: () => mockRole }));
const envNames = [
  'OXY_API_URL',
  'ALIA_API_URL',
  'INBOX_APPLICATION_KEY',
  'INBOX_APPLICATION_SECRET',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
] as const;
const original = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture needs port');
  return `http://127.0.0.1:${address.port}`;
}
afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const name of envNames) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});
it('mints v2 per audience, refreshes once with the same event, refuses redirects and leaves 503 retries to the durable outbox', async () => {
  for (const name of envNames) delete process.env[name];
  let foreignRequests = 0;
  const foreign = await listen(
    createServer((_req, res) => {
      foreignRequests++;
      res.end();
    }),
  );
  let mode: 'refresh' | 'unavailable' | 'redirect' = 'refresh';
  const exchanges: Array<Record<string, unknown>> = [];
  const events: Array<{ body: unknown; key: string | undefined; bearer: string | undefined }> = [];
  const issued = new Map<string, { audience: string; generation: number }>();
  const origin = await listen(
    createServer(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += part;
      res.setHeader('content-type', 'application/json');
      if (req.url?.endsWith('/challenge'))
        return res.end(JSON.stringify({ nonce: 'synthetic-challenge' }));
      if (req.url?.endsWith('/workload')) {
        const body = JSON.parse(raw);
        exchanges.push(body);
        const generation = exchanges.length;
        const audience = body.audience ?? 'oxy-api';
        const now = Math.floor(Date.now() / 1000);
        const token = `e30.${Buffer.from(JSON.stringify({ type: 'service', authority: 'first_party', appId: 'inbox-source', credentialId: 'wl_inbox', ownerAccountId: 'owner', environment: 'development', aud: audience, iss: 'oxy-auth', iat: now, exp: now + 300, generation })).toString('base64url')}.sig`;
        issued.set(`Bearer ${token}`, { audience, generation });
        return res.end(JSON.stringify({ token, expiresIn: 300, appName: 'Inbox' }));
      }
      const identity = issued.get(req.headers.authorization ?? '');
      if (req.url === '/webhooks/oxy') {
        events.push({
          body: JSON.parse(raw),
          key:
            typeof req.headers['idempotency-key'] === 'string'
              ? req.headers['idempotency-key']
              : undefined,
          bearer: req.headers.authorization,
        });
        if (identity?.audience !== 'oxy-service:6a2f851751b784a86fd0e934') {
          res.statusCode = 403;
          return res.end('{}');
        }
        if (mode === 'redirect') {
          res.statusCode = 302;
          res.setHeader('location', foreign);
          return res.end('{}');
        }
        res.statusCode = mode === 'unavailable' ? 503 : identity.generation === 1 ? 401 : 202;
        return res.end('{}');
      }
      if (req.url === '/capabilities/catalogs/register') {
        if (identity?.audience !== 'oxy-api') {
          res.statusCode = 403;
          return res.end('{}');
        }
        const { catalog } = JSON.parse(raw);
        return res.end(
          JSON.stringify({
            registration: {
              id: 'registered-inbox',
              version: catalog.version,
              digest: capabilityCatalogDigest(catalog),
            },
          }),
        );
      }
      res.statusCode = 404;
      res.end('{}');
    }),
  );
  process.env.OXY_API_URL = origin;
  process.env.ALIA_API_URL = origin;
  const { deliverNormalizedAppEvent } = await import(
    '../../services/normalizedAppEventOutbox.worker'
  );
  const { requiredInboxServiceClient } = await import('../inbox-service-client');
  const event = buildInboxMessageEvents({
    ownerAccountId: 'original-account',
    mailboxId: 'mailbox',
    messageId: 'message',
    senderAddress: 'sender@example.test',
    subject: 'Question',
    headers: {},
    receivedAt: new Date(),
    snippet: 'Question',
    folder: 'inbox',
  })[0];
  const client = requiredInboxServiceClient();
  try {
    await deliverNormalizedAppEvent(event);
    expect(events).toHaveLength(2);
    expect(events.map((row) => row.key)).toEqual([event.eventId, event.eventId]);
    expect(events.map((row) => row.body)).toEqual([event, event]);
    expect(events[0].bearer).not.toBe(events[1].bearer);
    expect(exchanges).toHaveLength(2);
    for (const exchange of exchanges) {
      expect(exchange.protocolVersion).toBe(2);
      expect(exchange).not.toHaveProperty('scopes');
      expect(exchange.audience).toBe('oxy-service:6a2f851751b784a86fd0e934');
    }
    mode = 'unavailable';
    await expect(deliverNormalizedAppEvent(event)).rejects.toThrow('(503)');
    expect(events).toHaveLength(3);
    expect(exchanges).toHaveLength(2);
    mode = 'redirect';
    const redirected = await deliverNormalizedAppEvent(event).then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error }),
    );
    expect({ foreignRequests, requests: events.length, status: redirected.status }).toEqual({
      foreignRequests: 0,
      requests: 4,
      status: 'rejected',
    });
    expect(mockRole).toHaveBeenCalledTimes(2);
    const { main } = await import('../../../scripts/register-inbox-capability-catalog');
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await main();
    } finally {
      write.mockRestore();
    }
    expect(exchanges).toHaveLength(3);
    expect(exchanges[2]).toMatchObject({ protocolVersion: 2 });
    expect(exchanges[2]).not.toHaveProperty('scopes');
    expect(INBOX_CAPABILITY_CATALOG.appId).toBe('inbox');
  } finally {
    client.dispose();
  }
});
