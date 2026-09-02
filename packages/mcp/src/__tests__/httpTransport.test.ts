import type { AppCapabilityCatalog } from '@oxyhq/contracts';
import {
  createServer,
  request as createHttpRequest,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCatalogMcpHttpService } from '../httpTransport';

const AUTHORIZATION_SERVER = 'http://127.0.0.1:3999';
const ACCESS_TOKEN = 'central-access-token';
const SERVICE_TOKEN = 'noted-service-token';

let server: Server;
let baseUrl: string;
let resource: string;
let introspectionMode: 'active' | 'inactive' | 'mismatch' | 'unavailable';
const serviceBox: {
  current?: ReturnType<typeof createCatalogMcpHttpService>;
} = {};
const introspectionFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const logger = { error: jest.fn() };
const authorize = jest.fn(async (_input, context: { principal: { accountId: string } }) => ({
  allowed: true as const,
  effectiveAccountId: context.principal.accountId,
}));

function catalogFor(resourceUrl: string): AppCapabilityCatalog {
  return {
    schemaVersion: '1',
    appId: 'noted',
    version: '1.2.0',
    audience: 'oxy-noted-api',
    internalBaseUrl: 'http://127.0.0.1:3001',
    accountResourceType: 'noted_account',
    externalMcp: { resource: resourceUrl },
    tools: [{
      name: 'searchNotes',
      version: '1.0.0',
      description: 'Search notes.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { notes: { type: 'array', items: { type: 'object' } } },
        required: ['notes'],
        additionalProperties: false,
      },
      capabilityPackage: 'read',
      requiredCapabilities: ['notes.read'],
      resourceTypes: ['noted_account'],
      effect: 'read',
      idempotency: 'none',
      rollback: 'none',
      exposure: ['internal', 'mcp'],
      limitKeys: [],
      invocation: { method: 'GET', path: '/_oxy/capabilities/searchNotes' },
    }],
    events: [],
  };
}

function activeClaims() {
  const now = Math.floor(Date.now() / 1000);
  return {
    active: true,
    iss: AUTHORIZATION_SERVER,
    sub: 'owner-account',
    aud: 'oxy-noted-api',
    resource: introspectionMode === 'mismatch' ? `${resource}/other` : resource,
    client_id: 'client-1',
    scope: 'notes.read',
    jti: 'access-token-1',
    iat: now - 30,
    nbf: now - 30,
    exp: now + 600,
    account_id: 'noted-account-1',
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const service = serviceBox.current;
    if (!service) {
      response.writeHead(503).end();
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === service.protectedResourceMetadataPath) {
      service.handleProtectedResourceMetadata(request, response);
      return;
    }
    if (pathname === service.mcpPath) {
      void service.handleMcp(request, response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  resource = baseUrl;

  introspectionFetch.mockImplementation(async (_input, init) => {
    if (introspectionMode === 'unavailable') {
      return new Response('unavailable', { status: 503 });
    }
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${SERVICE_TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({ token: ACCESS_TOKEN });
    return Response.json(
      introspectionMode === 'inactive' ? { active: false } : activeClaims(),
    );
  });

  serviceBox.current = createCatalogMcpHttpService({
    catalog: catalogFor(resource),
    handlers: {
      searchNotes: async () => ({ structuredContent: { notes: [] } }),
    },
    authorizationServer: AUTHORIZATION_SERVER,
    introspectionEndpoint: `${AUTHORIZATION_SERVER}/auth/mcp/oauth/introspect`,
    getServiceToken: async () => SERVICE_TOKEN,
    authorize,
    allowedOrigins: ['https://claude.ai'],
    maxBodyBytes: 1024,
    fetch: introspectionFetch as unknown as typeof fetch,
    logger,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) =>
    error ? reject(error) : resolve()));
});

beforeEach(() => {
  introspectionMode = 'active';
  introspectionFetch.mockClear();
  logger.error.mockClear();
  authorize.mockClear();
});

function authorizedHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${ACCESS_TOKEN}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...extra,
  };
}

describe('catalog MCP HTTP service', () => {
  it('serves exact protected-resource metadata from the catalog', async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300, must-revalidate');
    await expect(response.json()).resolves.toEqual({
      resource,
      authorization_servers: [AUTHORIZATION_SERVER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['notes.read'],
    });
  });

  it('challenges unauthenticated clients before reading their body', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      `resource_metadata="${resource}/.well-known/oauth-protected-resource"`,
    );
    expect(introspectionFetch).not.toHaveBeenCalled();
  });

  it('rejects disallowed origins before token introspection', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: authorizedHeaders({ origin: 'https://attacker.example' }),
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect(introspectionFetch).not.toHaveBeenCalled();
  });

  it('rejects the MCP route on a host other than the bound resource', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const target = new URL(baseUrl);
      const request = createHttpRequest({
        hostname: target.hostname,
        port: target.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          ...authorizedHeaders(),
          host: 'api.noted.test',
          'content-length': '2',
        },
      }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end('{}');
    });

    expect(status).toBe(421);
    expect(introspectionFetch).not.toHaveBeenCalled();
  });

  it('rejects combined bearer credentials as ambiguous', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: authorizedHeaders({
        authorization: `Bearer ${ACCESS_TOKEN}, Bearer second-token`,
      }),
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(introspectionFetch).not.toHaveBeenCalled();
  });

  it('distinguishes inactive, mismatched, and unavailable authorization', async () => {
    introspectionMode = 'inactive';
    const inactive = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: authorizedHeaders(), body: '{}',
    });
    expect(inactive.status).toBe(401);

    introspectionMode = 'mismatch';
    const mismatch = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: authorizedHeaders(), body: '{}',
    });
    expect(mismatch.status).toBe(401);

    introspectionMode = 'unavailable';
    const unavailable = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: authorizedHeaders(), body: '{}',
    });
    expect(unavailable.status).toBe(503);
  });

  it('rejects oversized input before allocating an MCP server', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: authorizedHeaders(),
      body: JSON.stringify({ value: 'x'.repeat(2048) }),
    });

    expect(response.status).toBe(413);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('serves a stateless authenticated MCP initialize request', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: authorizedHeaders({ origin: 'https://claude.ai' }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'transport-test', version: '1.0.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    const body = await response.json() as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe('noted-mcp');
    expect(introspectionFetch).toHaveBeenCalledTimes(1);
  });

  it('uses an injected live introspector without a service-token HTTP hop', async () => {
    const previous = serviceBox.current;
    const introspectToken = jest.fn(async () => activeClaims());
    serviceBox.current = createCatalogMcpHttpService({
      catalog: catalogFor(resource),
      handlers: {
        searchNotes: async () => ({ structuredContent: { notes: [] } }),
      },
      authorizationServer: AUTHORIZATION_SERVER,
      introspectToken,
      authorize,
      serverName: 'in-process-noted-mcp',
    });

    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: authorizedHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'in-process-test', version: '1.0.0' },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(introspectToken).toHaveBeenCalledWith(ACCESS_TOKEN);
      expect(introspectionFetch).not.toHaveBeenCalled();
    } finally {
      serviceBox.current = previous;
    }
  });

  it('executes a catalog handler through the authenticated transport', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: authorizedHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'searchNotes', arguments: {} },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      result?: { structuredContent?: { notes?: unknown[] } };
    };
    expect(body.result?.structuredContent?.notes).toEqual([]);
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});
