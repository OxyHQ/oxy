import { appCapabilityCatalogSchema } from '@oxyhq/contracts';
import { createCatalogMcpToolDefinitions, type CatalogToolHandlers } from '@oxyhq/mcp';
import { INBOX_CAPABILITY_CATALOG } from '../inbox.catalog';

describe('Inbox canonical capability catalog', () => {
  it('contains the ten public tools once and a typed internal context tool', () => {
    expect(appCapabilityCatalogSchema.safeParse(INBOX_CAPABILITY_CATALOG).success).toBe(true);
    expect(INBOX_CAPABILITY_CATALOG.tools.filter((tool) => tool.exposure.includes('mcp'))).toHaveLength(10);
    expect(INBOX_CAPABILITY_CATALOG.tools.filter((tool) => tool.name === 'getEmailContext')).toHaveLength(1);
    expect(INBOX_CAPABILITY_CATALOG.externalMcp).toEqual({
      resource: 'https://mcp.inbox.oxy.so',
    });
  });

  it('derives MCP names, schemas and capabilities from the internal catalog', () => {
    const handlers = Object.fromEntries(
      INBOX_CAPABILITY_CATALOG.tools
        .filter((tool) => tool.exposure.includes('mcp'))
        .map((tool) => [tool.name, async () => ({ structuredContent: {} })]),
    ) as CatalogToolHandlers;
    const mcpTools = createCatalogMcpToolDefinitions(INBOX_CAPABILITY_CATALOG, handlers);
    const publicCatalogTools = INBOX_CAPABILITY_CATALOG.tools.filter((tool) => tool.exposure.includes('mcp'));
    expect(mcpTools.map((definition) => ({
      name: definition.tool.name,
      input: definition.tool.inputSchema,
      capabilities: definition.tool.requiredCapabilities,
    }))).toEqual(publicCatalogTools.map((tool) => ({
      name: tool.name,
      input: tool.inputSchema,
      capabilities: tool.requiredCapabilities,
    })));
  });

  it('requires a caller key in every effectful MCP input', () => {
    for (const tool of INBOX_CAPABILITY_CATALOG.tools) {
      if (tool.effect === 'read') continue;
      expect(tool.idempotency).toBe('required');
      expect(tool.inputSchema).toMatchObject({
        required: expect.arrayContaining(['idempotencyKey']),
      });
    }
  });
});
