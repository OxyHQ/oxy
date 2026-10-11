import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  appCapabilityCatalogSchema,
  canonicalCapabilityJson,
  type CapabilityTicketClaims,
} from '@oxy.so/contracts';
import {
  issueCapabilityTicket,
  verifyCapabilityTicket,
} from '../../../core/src/server/capabilityTicket';
import { createLiveCapabilityTicketVerifier } from '../../../core/src/server/liveCapabilityTicket';
import { createInternalCatalogMcpClient } from '../internalClient';
import {
  createInternalCatalogMcpHttpService,
  type InternalCatalogMcpHttpServiceOptions,
} from '../internalTransport';

const keys = generateKeyPairSync('ed25519');
const verification = {
  audience: 'mention-api',
  issuer: 'https://api.oxy.so',
  resolvePublicKey: () => keys.publicKey,
};
let server: Server;
let origin: string;
let service: ReturnType<typeof createInternalCatalogMcpHttpService>;
let token: string;
let claims: CapabilityTicketClaims;
let active = true;
// This in-memory receipt fixture observes transport identity; it is NOT Mention's PostgreSQL ledger.
const receipts = new Set<string>();
const effects: string[] = [];
const seenKeys: string[] = [];
const handler = jest.fn(async (_input, context) => {
  const key = context.request.requestInfo?.headers['idempotency-key'];
  if (typeof key !== 'string') throw new Error('Missing domain operation key');
  seenKeys.push(key);
  if (receipts.has(key))
    return { isError: true, content: [{ type: 'text' as const, text: 'already_reserved' }] };
  receipts.add(key);
  effects.push(context.principal.claims.resource.effectiveAccountId);
  return { structuredContent: { count: effects.length } };
});
const authorize = jest.fn(async () => ({
  allowed: true as const,
  effectiveAccountId: 'account-B',
}));
const resolveResource = jest.fn(
  (
    _input: Readonly<Record<string, unknown>>,
    context: Parameters<InternalCatalogMcpHttpServiceOptions['resolveResource']>[1],
  ) => {
    const accountId = context.principal.claims.resource.effectiveAccountId;
    return {
      appId: context.appId,
      effectiveAccountId: accountId,
      resourceType: 'mention_account',
      resourceId: accountId,
    };
  },
);
const introspect = jest.fn(async () => ({ active, claims }));

beforeAll(async () => {
  server = createServer((request, response) => {
    void service.handleMcp(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  active = true;
  receipts.clear();
  effects.length = 0;
  seenKeys.length = 0;
  handler.mockClear();
  authorize.mockClear();
  resolveResource.mockClear();
  introspect.mockClear();
  configure();
});

function configure(idempotency: 'required' | 'none' | 'supported' = 'required') {
  const catalog = appCapabilityCatalogSchema.parse({
    schemaVersion: '1',
    appId: 'mention',
    version: '1.3.0',
    audience: 'mention-api',
    internalBaseUrl: origin,
    accountResourceType: 'mention_account',
    tools: [
      {
        name: 'create-lane',
        version: '1',
        description: 'Fixture effect on exact account root.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        capabilityPackage: 'administer',
        requiredCapabilities: ['social.lanes.manage'],
        resourceTypes: ['mention_account'],
        effect: idempotency === 'none' ? 'read' : 'write',
        idempotency,
        rollback: 'none',
        exposure: ['internal'],
        limitKeys: [],
        invocation: { method: 'POST', path: '/_oxy/capabilities/create-lane' },
      },
    ],
    events: [],
  });
  const binding = {
    registrationId: 'registration',
    version: catalog.version,
    digest: createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex'),
  };
  token = issueCapabilityTicket(
    {
      aud: catalog.audience,
      sub: 'alia:account-A',
      requesterAccountId: 'account-A',
      ownerAccountId: 'account-A',
      actor: { type: 'alia', ownerAccountId: 'account-A' },
      coordinator: { applicationId: 'alia', credentialId: 'credential' },
      executionAuthorization: { kind: 'direct_request', id: 'authorization' },
      runId: 'run',
      resource: {
        appId: 'mention',
        effectiveAccountId: 'account-B',
        resourceType: 'mention_account',
        resourceId: 'account-B',
      },
      tool: 'create-lane',
      capabilities: ['social.lanes.manage'],
      limits: [],
      autonomy: 'execute_on_request',
      catalog: binding,
    },
    { issuer: verification.issuer, keyId: 'key', privateKey: keys.privateKey },
  );
  claims = verifyCapabilityTicket(token, verification);
  service = createInternalCatalogMcpHttpService({
    catalog,
    binding,
    handlers: { 'create-lane': handler },
    verifyTicket: createLiveCapabilityTicketVerifier({ ...verification, introspect }),
    authorize,
    resolveResource,
  });
}

function keyFor(callId: string) {
  // The existing Alia operation identity, not an MCP JSON-RPC request ID.
  return createHash('sha256')
    .update(JSON.stringify(['run', 'create-lane', callId]))
    .digest('hex');
}
function call(key?: string, fetchImpl?: typeof fetch) {
  const client = createInternalCatalogMcpClient({
    endpoint: `${origin}/_oxy/mcp`,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const options = { signal: undefined, ...(key !== undefined ? { idempotencyKey: key } : {}) };
  return client.callTool(token, 'create-lane', { name: 'same deliberate input' }, options);
}

it('preserves the stable key through real HTTP, rejects replay in the domain fixture, and distinguishes a new intent', async () => {
  const captures: { headers: Headers; body: string }[] = [];
  const capture: typeof fetch = async (url, init) => {
    captures.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') });
    return fetch(url, init);
  };
  expect((await call(keyFor('call-A'), capture)).isError).not.toBe(true);
  expect((await call(keyFor('call-A'), capture)).isError).toBe(true);
  expect((await call(keyFor('call-B'), capture)).isError).not.toBe(true);
  expect(seenKeys).toEqual([keyFor('call-A'), keyFor('call-A'), keyFor('call-B')]);
  expect(effects).toEqual(['account-B', 'account-B']);
  expect(
    captures.every(
      ({ headers, body }) =>
        headers.get('authorization') === `Capability ${token}` &&
        !body.includes(token) &&
        !body.includes('idempotencyKey'),
    ),
  ).toBe(true);
  expect(
    captures
      .filter(({ body }) => body.includes('tools/call'))
      .map(({ headers }) => headers.get('idempotency-key')),
  ).toEqual(seenKeys);
});

it('allows discovery without a key but rejects an effect without one before domain authorization or handler', async () => {
  const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp` });
  expect((await client.listTools(token)).tools.map((tool) => tool.name)).toEqual(['create-lane']);
  const result = await call();
  expect(result.isError).toBe(true);
  expect(authorize.mock.calls.length).toBe(0);
  expect(handler.mock.calls.length).toBe(0);
});

it.each(['', '   ', 'x'.repeat(256), 'bad\nheader'])(
  'rejects invalid client key before making a network request (%p)',
  async (key) => {
    const capture = jest.fn(async () => {
      throw new Error('Unexpected network');
    });
    await expect(call(key, capture)).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  },
);

it.each(['', 'x'.repeat(256)])(
  'also refuses an invalid HTTP key before domain execution (%p)',
  async (key) => {
    const response = await fetch(`${origin}/_oxy/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Capability ${token}`,
        'idempotency-key': key,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create-lane', arguments: { name: 'lane' } },
      }),
    });
    const body = (await response.json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(Boolean(body.error || body.result?.isError)).toBe(true);
    expect(authorize.mock.calls.length).toBe(0);
    expect(handler.mock.calls.length).toBe(0);
  },
);

it('accepts the shared maximum key length and does not retain it across calls or discovery', async () => {
  const captures: { key: string | null; body: string }[] = [];
  const client = createInternalCatalogMcpClient({
    endpoint: `${origin}/_oxy/mcp`,
    fetch: async (url, init) => {
      captures.push({
        key: new Headers(init?.headers).get('idempotency-key'),
        body: String(init?.body ?? ''),
      });
      return fetch(url, init);
    },
  });
  expect(
    (
      await client.callTool(
        token,
        'create-lane',
        { name: 'lane' },
        { idempotencyKey: 'x'.repeat(255) },
      )
    ).isError,
  ).not.toBe(true);
  const firstCallRequests = captures.length;
  await client.listTools(token);
  expect((await client.callTool(token, 'create-lane', { name: 'lane' })).isError).toBe(true);
  expect(captures.slice(firstCallRequests).every(({ key }) => key === null)).toBe(true);
  expect(effects).toHaveLength(1);
});

it('resolves the root from verified capability B while preserving requester/owner/actor A', async () => {
  const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp` });
  const result = await client.callTool(
    token,
    'create-lane',
    { name: 'account-A' },
    { idempotencyKey: keyFor('call-A') },
  );
  expect(result.isError).not.toBe(true);
  const context = resolveResource.mock.calls[0][1];
  expect(context.principal.kind).toBe('capability');
  expect(context.principal.claims).toMatchObject({
    requesterAccountId: 'account-A',
    ownerAccountId: 'account-A',
    actor: { ownerAccountId: 'account-A' },
    resource: { effectiveAccountId: 'account-B', resourceId: 'account-B' },
  });
  expect(effects).toEqual(['account-B']);
});

it('refuses caller-supplied authority and a resource resolver disagreeing with the signed root', async () => {
  const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp` });
  expect(
    (
      await client.callTool(
        token,
        'create-lane',
        { name: 'lane', effectiveAccountId: 'account-A' },
        { idempotencyKey: keyFor('call-A') },
      )
    ).isError,
  ).toBe(true);
  resolveResource.mockImplementationOnce(() => ({ ...claims.resource, resourceId: 'account-A' }));
  expect((await call(keyFor('call-A'))).isError).toBe(true);
  expect(authorize.mock.calls.length).toBe(0);
  expect(handler.mock.calls.length).toBe(0);
});

it('rechecks live authority after resource/domain awaits, before entering the simulated effect', async () => {
  authorize.mockImplementationOnce(async () => {
    active = false;
    return { allowed: true, effectiveAccountId: 'account-B' };
  });
  expect((await call(keyFor('call-A'))).isError).toBe(true);
  expect(handler.mock.calls.length).toBe(0);
  expect(effects).toHaveLength(0);
});

it.each(['none', 'supported'] as const)(
  'keeps a key optional for catalogue policy %s',
  async (policy) => {
    configure(policy);
    handler.mockImplementationOnce(async () => ({ structuredContent: { count: 0 } }));
    expect((await call()).isError).not.toBe(true);
    expect(handler.mock.calls.length).toBe(1);
    expect((await call(keyFor('call-A'))).isError).not.toBe(true);
    expect(seenKeys).toEqual([keyFor('call-A')]);
  },
);
