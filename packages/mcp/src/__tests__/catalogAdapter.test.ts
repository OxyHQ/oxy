import type { AppCapabilityCatalog } from '@oxyhq/contracts';
import {
  createCatalogMcpToolDefinitions,
  validateMcpAccessTokenClaims,
} from '../index';

const catalog: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: 'noted',
  version: '1.0.0',
  audience: 'noted-api',
  accountResourceType: 'workspace',
  tools: [{
    name: 'searchNotes',
    version: '1.0.0',
    description: 'Search delegated notes.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    capabilityPackage: 'read',
    requiredCapabilities: ['notes.read'],
    resourceTypes: ['workspace'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
    invocation: { method: 'GET', path: '/notes/search' },
  }],
  events: [],
};

describe('@oxyhq/mcp catalog adapter', () => {
  it('derives the MCP tool and schemas from the canonical catalog', () => {
    const definitions = createCatalogMcpToolDefinitions(catalog, {
      searchNotes: async () => ({ structuredContent: { count: 1 } }),
    });
    expect(definitions.map(({ tool }) => tool.name)).toEqual(catalog.tools.map(({ name }) => name));
    expect(definitions[0]?.inputSchema.safeParse({ query: 'weekly' }).success).toBe(true);
    expect(definitions[0]?.inputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a token replayed across resources or accounts', () => {
    const claims = {
      iss: 'https://accounts.oxy.so',
      sub: 'user-1',
      aud: 'noted-mcp',
      resource: 'https://mcp.noted.oxy.so',
      client_id: 'client-1',
      scope: 'notes.read',
      iat: 1_788_256_800,
      exp: 1_788_257_100,
      account_id: 'account-1',
    };
    const options = {
      issuer: 'https://accounts.oxy.so',
      audience: 'noted-mcp',
      resource: 'https://mcp.noted.oxy.so',
      requiredScopes: ['notes.read'],
      now: new Date('2026-09-01T10:00:00.000Z'),
    };
    expect(validateMcpAccessTokenClaims(claims, options).account_id).toBe('account-1');
    expect(() => validateMcpAccessTokenClaims(claims, {
      ...options,
      resource: 'https://mcp.mention.earth',
    })).toThrow('MCP token resource mismatch');
  });
});
