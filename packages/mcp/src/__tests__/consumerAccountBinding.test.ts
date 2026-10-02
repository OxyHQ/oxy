import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppCapabilityCatalog } from '@oxy.so/contracts';
import { createCatalogMcpHttpService } from '../httpTransport';

/** Reduced policy projections from pinned sources; not their production code. */
const sources = {
  Noted: { pin: '806e9cae040a7d9446557e7ce9eda64069116056', path: 'packages/backend/src/capabilities/noted-mcp-http.ts', accountResourceType: 'noted_account', resourceType: 'note' },
  Mercaria: { pin: '9e546e66b36b8050bfe07a37f53ee436444688cf', path: 'packages/backend/src/capabilities/mercaria-mcp-http.ts', accountResourceType: 'mercaria_account', resourceType: 'store' },
  website: { pin: 'a53531ee471304b390e4be5ec1322e0672c9b08e', path: 'server/mcp/catalog.ts', accountResourceType: 'oxy_account', resourceType: 'website_content' },
} as const;
let server: Server;
let origin: string;
let service: ReturnType<typeof createCatalogMcpHttpService>;
const effect = jest.fn(async () => ({ structuredContent: { count: 1 } }));

beforeAll(async () => {
  server = createServer((req, res) => { void service.handleMcp(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => effect.mockClear());

function fixture(product: keyof typeof sources, adapt: boolean, allowedB = true, admin = 'account-B') {
  const source = sources[product];
  const catalog: AppCapabilityCatalog = {
    schemaVersion: '1', appId: product.toLowerCase(), version: 'fixture', audience: 'fixture-api', internalBaseUrl: origin,
    accountResourceType: source.accountResourceType, externalMcp: { resource: `${origin}/mcp` }, events: [],
    tools: [{ name: 'projectedInvocation', version: '1', description: 'Reduced account-authority fixture.',
      inputSchema: { type: 'object', properties: { storeId: { type: 'string' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
      capabilityPackage: 'read', requiredCapabilities: ['read'], resourceTypes: [source.resourceType], effect: 'read', idempotency: 'none', rollback: 'none',
      // website's pinned catalog is external-only; never silently widen exposure.
      exposure: ['mcp'], limitKeys: [], invocation: { method: 'GET', path: '/projection' } }],
  };
  service = createCatalogMcpHttpService({ catalog, handlers: { projectedInvocation: effect }, authorizationServer: 'https://api.oxy.so',
    introspectToken: async () => {
      if (!allowedB) return null;
      const now = Math.floor(Date.now() / 1000);
      return { iss: 'https://api.oxy.so', sub: 'requester', aud: catalog.audience, resource: `${origin}/mcp`, client_id: 'client', jti: 'token', iat: now, exp: now + 60,
        account_id: 'account-A', scope: 'read', connection: { connection_id: 'connection', origin_account_id: 'account-A', active_account_id: 'account-B',
          accounts: [{ account_id: 'account-A', is_origin: true, linked_at: 'date' }, { account_id: 'account-B', is_origin: false, linked_at: 'date' }] } };
    },
    authorize: async (input, { principal }) => {
      // Noted and Mercaria's pinned callbacks select accountId; website uses active.
      const account = product === 'website' || adapt ? principal.activeAccountId : principal.accountId;
      if (product === 'Mercaria') {
        // Projection of store.members + effectivePermissions, not Oxy membership alone.
        const stores = { storeA: { oxyUserId: 'account-B', permissions: ['orders:read'] }, storeB: { oxyUserId: 'account-A', permissions: ['orders:read'] } };
        const member = stores[input.storeId as keyof typeof stores];
        if (!member || member.oxyUserId !== account || !member.permissions.includes('orders:read')) return { allowed: false, reason: 'store_membership_required' };
      }
      if (product === 'website' && account !== admin) return { allowed: false, reason: 'admin_only' };
      return { allowed: true, effectiveAccountId: account };
    },
  });
}
async function call(input: Record<string, unknown> = {}) {
  const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'projectedInvocation', arguments: input } }) });
  return { status: response.status, body: await response.json() };
}

it('Noted pinned accountId callback fails A→B; an explicit active-account adaptation succeeds, central revoke refuses', async () => {
  fixture('Noted', false);
  expect((await call()).body.result.isError).toBe(true); expect(effect).not.toHaveBeenCalled();
  fixture('Noted', true);
  expect((await call()).body.result.structuredContent).toEqual({ count: 1 });
  fixture('Noted', true, false);
  expect((await call()).status).toBe(401); expect(effect).toHaveBeenCalledTimes(1);
});

it('Mercaria adaptation retains live store membership/permission and cannot use origin A to operate A-owned store as B', async () => {
  fixture('Mercaria', false);
  expect((await call({ storeId: 'storeB' })).body.result.isError).toBe(true); expect(effect).not.toHaveBeenCalled();
  fixture('Mercaria', true);
  expect((await call({ storeId: 'storeA' })).body.result.structuredContent).toEqual({ count: 1 });
  expect((await call({ storeId: 'storeB' })).body.result.isError).toBe(true);
  expect((await call({ storeId: 'missing' })).body.result.isError).toBe(true);
  fixture('Mercaria', true, false);
  expect((await call({ storeId: 'storeA' })).status).toBe(401); expect(effect).toHaveBeenCalledTimes(1);
});

it('website uses active B for its admin boundary; origin admin A cannot grant B admin access', async () => {
  fixture('website', false, true, 'account-A');
  expect((await call()).body.result.isError).toBe(true); expect(effect).not.toHaveBeenCalled();
  fixture('website', false, true, 'account-B');
  expect((await call()).body.result.structuredContent).toEqual({ count: 1 });
  fixture('website', false, false, 'account-B');
  expect((await call()).status).toBe(401); expect(effect).toHaveBeenCalledTimes(1);
});
