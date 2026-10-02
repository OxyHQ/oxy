import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { appCapabilityCatalogSchema, canonicalCapabilityJson, type AppCapabilityCatalog, type CapabilityTicketClaims } from '@oxy.so/contracts';
import { issueCapabilityTicket, verifyCapabilityTicket } from '../../../core/src/server/capabilityTicket';
import { createLiveCapabilityTicketVerifier } from '../../../core/src/server/liveCapabilityTicket';
import { createInternalCatalogMcpHttpService } from '../internalTransport';
import { createInternalCatalogMcpClient } from '../internalClient';

const keys = generateKeyPairSync('ed25519');
let server: Server;
let origin: string;
let service: ReturnType<typeof createInternalCatalogMcpHttpService>;
let catalog: AppCapabilityCatalog;
let token: string;
let claims: CapabilityTicketClaims;
let mode: 'active' | 'revoked' | 'different' | 'timeout';
let consumedBody = false;
const effect = jest.fn(async () => ({ structuredContent: { count: 1 } }));
const authorize = jest.fn(async () => ({ allowed: true as const, effectiveAccountId: 'account-B' }));
const verification = { audience: 'inbox-api', issuer: 'https://api.oxy.so', resolvePublicKey: () => keys.publicKey };
const introspect = jest.fn(async () => {
  if (mode === 'timeout') return new Promise<never>(() => {});
  return { active: mode !== 'revoked', claims: mode === 'different' ? { ...claims, requesterAccountId: 'other-requester' } : claims };
});

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url !== '/_oxy/mcp') { response.writeHead(404).end(); return; }
    if (consumedBody) {
      request.once('end', () => { void service.handleMcp(request, response); });
      request.resume();
    } else void service.handleMcp(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  mode = 'active'; consumedBody = false; effect.mockClear(); authorize.mockClear(); introspect.mockClear();
  catalog = appCapabilityCatalogSchema.parse({
    schemaVersion: '1', appId: 'inbox', version: '1.0.0', audience: 'inbox-api', internalBaseUrl: origin, accountResourceType: 'mailbox',
    tools: [{ name: 'readMailbox', version: '1', description: 'Read exact mailbox.',
      inputSchema: { type: 'object', properties: { resourceId: { type: 'string' }, amount: { type: 'number' } }, required: ['resourceId', 'amount'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
      capabilityPackage: 'read', requiredCapabilities: ['mail.read'], resourceTypes: ['mailbox'], effect: 'read', idempotency: 'none', rollback: 'none',
      exposure: ['internal', 'mcp'], limitKeys: [{ key: 'amount', kind: 'maximum_number' }], invocation: { method: 'GET', path: '/mailbox' } },
    { name: 'otherTool', version: '1', description: 'Other.', inputSchema: { type: 'object' }, capabilityPackage: 'read', requiredCapabilities: ['mail.read'],
      resourceTypes: ['mailbox'], effect: 'read', idempotency: 'none', rollback: 'none', exposure: ['internal'], limitKeys: [], invocation: { method: 'GET', path: '/other' } }], events: [],
  });
  const binding = { registrationId: 'registration', version: catalog.version, digest: createHash('sha256').update(canonicalCapabilityJson(catalog)).digest('hex') };
  token = issueCapabilityTicket({ aud: catalog.audience, sub: 'alia:account-A', requesterAccountId: 'account-A', ownerAccountId: 'account-A',
    actor: { type: 'alia', ownerAccountId: 'account-A' }, coordinator: { applicationId: 'alia', credentialId: 'credential' },
    executionAuthorization: { kind: 'direct_request', id: 'authorization' }, runId: 'run', resource: { appId: 'inbox', effectiveAccountId: 'account-B', resourceType: 'mailbox', resourceId: 'mailbox-A' },
    tool: 'readMailbox', capabilities: ['mail.read'], limits: [{ tool: 'readMailbox', key: 'amount', value: 10 }], autonomy: 'read_only', catalog: binding,
  }, { issuer: verification.issuer, keyId: 'key', privateKey: keys.privateKey });
  claims = verifyCapabilityTicket(token, verification);
  service = createInternalCatalogMcpHttpService({ catalog, binding, handlers: { readMailbox: effect },
    verifyTicket: createLiveCapabilityTicketVerifier({ ...verification, introspect, timeoutMs: 20 }), authorize,
    resolveResource: (input) => ({ appId: 'inbox', effectiveAccountId: 'account-B', resourceType: 'mailbox', resourceId: String(input.resourceId) }),
  });
});

function rpc(name: string, input: Record<string, unknown>, authorization = `Capability ${token}`) {
  return fetch(`${origin}/_oxy/mcp`, { method: 'POST', headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) });
}

it('uses fresh Capability proof through the common client, never parameters, OAuth state or session ID', async () => {
  const captures: { headers: Headers; body: string }[] = [];
  const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp`, fetch: async (url, init) => {
    captures.push({ headers: new Headers(init?.headers), body: String(init?.body ?? '') });
    return fetch(url, init);
  } });
  const listed = await client.listTools(token);
  expect(listed.tools.map((tool) => tool.name)).toEqual(['readMailbox']);
  expect(effect).not.toHaveBeenCalled();
  const result = await client.callTool(token, 'readMailbox', { resourceId: 'mailbox-A', amount: 8 });
  expect(result.structuredContent).toEqual({ count: 1 });
  expect(effect).toHaveBeenCalledTimes(1);
  expect(captures.every(({ headers, body }) => headers.get('authorization') === `Capability ${token}` && !headers.has('mcp-session-id') && !body.includes(token))).toBe(true);
  expect(effect.mock.calls[0][1].principal.kind).toBe('capability');
  expect(effect.mock.calls[0][1].principal.claims.requesterAccountId).toBe('account-A');
});

it('rejects ticket A calling another tool or resource B even when domain authorization would permit B', async () => {
  for (const [tool, input] of [['otherTool', { resourceId: 'mailbox-A', amount: 8 }], ['readMailbox', { resourceId: 'mailbox-B', amount: 8 }], ['readMailbox', { resourceId: 'mailbox-A', amount: 11 }]] as const) {
    const result = await (await rpc(tool, input)).json() as { error?: unknown; result?: { isError?: boolean } };
    expect(Boolean(result.error || result.result?.isError)).toBe(true);
  }
  expect(effect).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});

it('refuses an already consumed request body promptly instead of hanging or executing', async () => {
  consumedBody = true;
  expect((await rpc('readMailbox', { resourceId: 'mailbox-A', amount: 8 })).status).toBe(403);
  expect(effect).not.toHaveBeenCalled();
});

it('does not reuse tools/list authority after revocation and rechecks after domain I/O before an effect', async () => {
  const client = createInternalCatalogMcpClient({ endpoint: `${origin}/_oxy/mcp` });
  await client.listTools(token);
  mode = 'revoked';
  await expect(client.callTool(token, 'readMailbox', { resourceId: 'mailbox-A', amount: 8 })).rejects.toThrow();
  expect(effect).not.toHaveBeenCalled();
  mode = 'active';
  authorize.mockImplementationOnce(async () => { mode = 'revoked'; return { allowed: true, effectiveAccountId: 'account-B' }; });
  const result = await (await rpc('readMailbox', { resourceId: 'mailbox-A', amount: 8 })).json() as { result: { isError: boolean } };
  expect(result.result.isError).toBe(true);
  expect(effect).not.toHaveBeenCalled();
});

it('refuses different active claims, timeout, forged OAuth proof and a changed catalogue with the same tool name', async () => {
  for (const value of ['different', 'timeout'] as const) {
    mode = value;
    expect((await rpc('readMailbox', { resourceId: 'mailbox-A', amount: 8 })).status).toBe(403);
  }
  mode = 'active';
  expect((await rpc('readMailbox', {}, `Bearer ${token}`)).status).toBe(401);
  expect((await rpc('readMailbox', {}, `Capability ${token.slice(0, -2)}aa`)).status).toBe(403);
  const changed = { ...catalog, tools: catalog.tools.map((tool) => ({ ...tool, description: 'Changed definition, same name.' })) };
  service = createInternalCatalogMcpHttpService({ catalog: changed, binding: { registrationId: 'registration', version: changed.version, digest: createHash('sha256').update(canonicalCapabilityJson(changed)).digest('hex') },
    handlers: { readMailbox: effect }, verifyTicket: createLiveCapabilityTicketVerifier({ ...verification, introspect }), authorize,
    resolveResource: () => claims.resource });
  expect((await rpc('readMailbox', { resourceId: 'mailbox-A', amount: 8 })).status).toBe(403);
  expect(effect).not.toHaveBeenCalled();
});
