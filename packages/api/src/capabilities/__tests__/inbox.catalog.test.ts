import { appCapabilityCatalogSchema, findOverlappingCatalogInvocations } from '@oxy.so/contracts';
import { createCatalogMcpToolDefinitions, type CatalogToolHandlers } from '@oxy.so/mcp';
import { INBOX_CAPABILITY_CATALOG, INBOX_DEFAULT_PAGE_SIZE } from '../inbox.catalog';

describe('Inbox canonical capability catalog', () => {
  it('validates, and lists every tool once with the internal context tool kept internal', () => {
    expect(appCapabilityCatalogSchema.safeParse(INBOX_CAPABILITY_CATALOG).success).toBe(true);
    expect(INBOX_CAPABILITY_CATALOG.version).toBe('2.0.0');
    expect(INBOX_CAPABILITY_CATALOG.tools.map((tool) => tool.name).sort()).toEqual([
      'archiveEmail', 'cancelOutboundEmail', 'createDraft', 'getEmailContext', 'getEmailQuota',
      'getEmailThread', 'getUnreadEmails', 'listEmails', 'listLabels', 'listMailboxes',
      'listOutboundEmails', 'moveEmail', 'readEmail', 'replyToEmail', 'searchEmails', 'sendEmail',
      'setEmailLabels', 'snoozeEmail', 'suggestContacts', 'trashEmail', 'updateEmailFlags',
    ]);
    expect(INBOX_CAPABILITY_CATALOG.tools.filter((tool) => !tool.exposure.includes('mcp')).map((tool) => tool.name))
      .toEqual(['getEmailContext']);
    expect(INBOX_CAPABILITY_CATALOG.externalMcp).toEqual({
      resource: 'https://mcp.inbox.oxy.so',
    });
  });

  it('never lets two tools match the same request', () => {
    expect(findOverlappingCatalogInvocations(INBOX_CAPABILITY_CATALOG.tools)).toEqual([]);
    // Positive control: the check sees an overlap when one exists.
    const readEmail = INBOX_CAPABILITY_CATALOG.tools.find((tool) => tool.name === 'readEmail')!;
    expect(findOverlappingCatalogInvocations([
      ...INBOX_CAPABILITY_CATALOG.tools,
      { ...readEmail, name: 'shadow', invocation: { method: 'GET', path: '/email/messages/unread' } },
    ])).toHaveLength(1);
  });

  it('never asks the model for an idempotency key; the transports carry it', () => {
    for (const tool of INBOX_CAPABILITY_CATALOG.tools) {
      if (tool.effect !== 'read') expect(tool.idempotency).toBe('required');
      expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>)).not.toContain('idempotencyKey');
    }
  });

  it('defaults every limited page size to the advertised default', () => {
    for (const tool of INBOX_CAPABILITY_CATALOG.tools) {
      for (const limit of tool.limitKeys.filter(({ kind }) => kind === 'maximum_number')) {
        const property = (tool.inputSchema.properties as Record<string, Record<string, unknown>>)[limit.key];
        expect({ tool: tool.name, default: property?.default }).toEqual({ tool: tool.name, default: INBOX_DEFAULT_PAGE_SIZE });
      }
    }
  });

  it('keeps sending, drafting and outbox control on the whole account', () => {
    const accountOnly = ['sendEmail', 'replyToEmail', 'createDraft', 'cancelOutboundEmail', 'listOutboundEmails', 'suggestContacts'];
    for (const name of accountOnly) {
      expect(INBOX_CAPABILITY_CATALOG.tools.find((tool) => tool.name === name)?.resourceTypes).toEqual(['email_account']);
    }
  });

  it('publishes exactly the OAuth scopes external clients and grants already know', () => {
    // `scopes_supported` is derived from these (`routes/mcpOAuth.ts`), and the
    // deploy's MCP smoke (`.github/scripts/smoke-inbox-mcp.sh`) pins the set: a
    // tool that introduces a capability is a new OAuth scope for every client
    // and grant, and failed a production deploy (2026-09-30) before this test.
    const published = [...new Set(INBOX_CAPABILITY_CATALOG.tools
      .filter((tool) => tool.exposure.includes('mcp'))
      .flatMap((tool) => tool.requiredCapabilities))].sort();
    expect(published).toEqual(['email.organize', 'email.read', 'email.send']);
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

});
