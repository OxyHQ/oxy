import type { AppCapabilityCatalog } from '@oxyhq/contracts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import {
  createCatalogMcpToolDefinitions,
  createMcpAuthInfo,
  registerCatalogWithMcp,
} from '../index';

const now = new Date('2026-09-01T10:00:00.000Z');
const tokenClaims = {
  iss: 'https://accounts.oxy.so',
  sub: 'user-1',
  aud: 'noted-mcp',
  resource: 'https://mcp.noted.oxy.so',
  client_id: 'client-1',
  scope: 'notes.read notes.write',
  jti: 'token-1',
  iat: 1_788_256_800,
  exp: 1_788_257_100,
  account_id: 'account-1',
};

const catalog: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: 'noted',
  version: '1.0.0',
  audience: 'noted-api',
  internalBaseUrl: 'https://api.noted.oxy.so',
  accountResourceType: 'workspace',
  tools: [
    {
      name: 'searchNotes',
      version: '1.0.0',
      description: 'Search delegated notes.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 } },
        required: ['query'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
      capabilityPackage: 'read',
      requiredCapabilities: ['notes.read'],
      resourceTypes: ['workspace'],
      effect: 'read',
      idempotency: 'none',
      rollback: 'none',
      exposure: ['internal', 'mcp'],
      invocation: { method: 'GET', path: '/notes/search' },
    },
    {
      name: 'reportSyncError',
      version: '1.0.0',
      description: 'Return a domain error without structured content.',
      inputSchema: { type: 'object', additionalProperties: false },
      capabilityPackage: 'read',
      requiredCapabilities: ['notes.read'],
      resourceTypes: ['workspace'],
      effect: 'read',
      idempotency: 'none',
      rollback: 'none',
      exposure: ['mcp'],
      invocation: { method: 'GET', path: '/notes/sync-status' },
    },
  ],
  events: [],
};

function withoutDialect(schema: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!schema) return undefined;
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}

class AuthenticatedTransport implements Transport {
  constructor(
    private readonly transport: InMemoryTransport,
    private readonly authInfo: AuthInfo,
  ) {}

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  set onclose(callback: (() => void) | undefined) {
    this.transport.onclose = callback;
  }

  set onerror(callback: ((error: Error) => void) | undefined) {
    this.transport.onerror = callback;
  }

  set onmessage(callback: ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void) | undefined) {
    this.transport.onmessage = callback;
  }

  start(): Promise<void> {
    return this.transport.start();
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.transport.send(message, {
      relatedRequestId: options?.relatedRequestId,
      authInfo: this.authInfo,
    });
  }
}

describe('@oxyhq/mcp catalog adapter', () => {
  it('derives exactly the MCP-exposed tools and complete schemas from the catalog', () => {
    const definitions = createCatalogMcpToolDefinitions(catalog, {
      searchNotes: async () => ({ structuredContent: { count: 1 } }),
      reportSyncError: async () => ({ content: [], isError: true }),
    });
    expect(definitions.map(({ tool }) => tool.name)).toEqual(['searchNotes', 'reportSyncError']);
    expect(definitions[0]?.inputSchema.safeParse({ query: 'weekly' }).success).toBe(true);
    expect(definitions[0]?.inputSchema.safeParse({}).success).toBe(false);
    expect(definitions[0]?.outputSchema).toBeDefined();
    expect(definitions[1]?.outputSchema).toBeUndefined();
  });

  it('binds authInfo to an immutable principal and preserves MCP result semantics', async () => {
    const authorizationAccounts: string[] = [];
    const seenContexts: Array<{ frozen: boolean; scopesFrozen: boolean; token?: string }> = [];
    const server = new McpServer({ name: 'noted-test', version: '1.0.0' });
    registerCatalogWithMcp(server, catalog, {
      searchNotes: async (_input, context) => {
        seenContexts.push({
          frozen: Object.isFrozen(context.principal),
          scopesFrozen: Object.isFrozen(context.principal.scopes),
          token: context.request.authInfo?.token,
        });
        return { structuredContent: { count: 2 } };
      },
      reportSyncError: async () => ({
        content: [{ type: 'text', text: 'sync unavailable' }],
        isError: true,
      }),
    }, {
      authentication: {
        issuer: tokenClaims.iss,
        audience: tokenClaims.aud,
        resource: tokenClaims.resource,
        maxTokenTtlSeconds: 600,
        now,
      },
      authorize: async (_input, context) => {
        authorizationAccounts.push(context.principal.accountId);
        return {
          allowed: true,
          effectiveAccountId: _input.query === 'cross-account'
            ? 'account-2'
            : context.principal.accountId,
        };
      },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const authenticatedTransport = new AuthenticatedTransport(
      clientTransport,
      createMcpAuthInfo('signed-token', tokenClaims),
    );
    const client = new Client({ name: 'catalog-test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(authenticatedTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual(['searchNotes', 'reportSyncError']);
      expect(withoutDialect(listed.tools[0]?.inputSchema)).toEqual(catalog.tools[0]?.inputSchema);
      expect(withoutDialect(listed.tools[0]?.outputSchema)).toMatchObject(catalog.tools[0]?.outputSchema ?? {});
      expect(listed.tools[0]?._meta?.['oxy/requiredCapabilities']).toEqual(['notes.read']);
      expect(listed.tools[0]?.outputSchema).toBeDefined();
      expect(listed.tools[1]?.outputSchema).toBeUndefined();

      const success = await client.callTool({ name: 'searchNotes', arguments: { query: 'weekly' } });
      expect(success.structuredContent).toEqual({ count: 2 });
      expect(success.isError).toBeUndefined();

      const failure = await client.callTool({ name: 'reportSyncError', arguments: {} });
      expect(failure.content).toEqual([{ type: 'text', text: 'sync unavailable' }]);
      expect(failure.structuredContent).toBeUndefined();
      expect(failure.isError).toBe(true);

      const crossAccount = await client.callTool({
        name: 'searchNotes',
        arguments: { query: 'cross-account' },
      });
      expect(crossAccount.isError).toBe(true);
      expect(crossAccount.content).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('MCP authorization account binding mismatch'),
        }),
      ]));
      expect(authorizationAccounts).toEqual(['account-1', 'account-1', 'account-1']);
      expect(seenContexts).toEqual([{
        frozen: true,
        scopesFrozen: true,
        token: 'signed-token',
      }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fails closed before authorization and handlers when authInfo is absent', async () => {
    const handler = jest.fn(async () => ({ structuredContent: { count: 1 } }));
    const authorize = jest.fn(async () => ({
      allowed: true as const,
      effectiveAccountId: 'account-1',
    }));
    const server = new McpServer({ name: 'noted-unauthenticated-test', version: '1.0.0' });
    registerCatalogWithMcp(server, catalog, {
      searchNotes: handler,
      reportSyncError: async () => ({ content: [], isError: true }),
    }, {
      authentication: {
        issuer: tokenClaims.iss,
        audience: tokenClaims.aud,
        resource: tokenClaims.resource,
        maxTokenTtlSeconds: 600,
        now,
      },
      authorize,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'unauthenticated-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({ name: 'searchNotes', arguments: { query: 'weekly' } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('MCP authentication is required') }),
      ]));
      expect(authorize).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
