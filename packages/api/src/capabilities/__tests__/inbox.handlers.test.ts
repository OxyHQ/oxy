import type { CatalogInvocationContext } from '@oxy.so/mcp';

const mockToolRun = jest.fn();
const mockReserveEffect = jest.fn();
const mockFinalizeEffect = jest.fn();

// The adapter's job is binding and retry keys; the tools themselves are
// `inbox.tools.test.ts`. Every tool resolves to this one spy.
jest.mock('../inbox.tools', () => {
  const { INBOX_CAPABILITY_CATALOG } = jest.requireActual('../inbox.catalog');
  return {
    INBOX_TOOLS: Object.fromEntries(
      INBOX_CAPABILITY_CATALOG.tools.map((tool: { name: string }) => [
        tool.name,
        (input: unknown, context: unknown) => mockToolRun(tool.name, input, context),
      ]),
    ),
  };
});
jest.mock('../../services/capabilityRuntimeStore.service', () => ({
  reserveCapabilityEffectFor: (...args: unknown[]) => mockReserveEffect(...args),
  finalizeCapabilityEffectFor: (...args: unknown[]) => mockFinalizeEffect(...args),
}));

import { INBOX_CAPABILITY_CATALOG } from '../inbox.catalog';
import { INBOX_MCP_CATALOG, INBOX_MCP_HANDLERS } from '../inbox.handlers';

function context(toolName: string, activeAccountId = 'account-1'): CatalogInvocationContext {
  const tool = INBOX_MCP_CATALOG.tools.find(({ name }) => name === toolName);
  if (!tool) throw new Error(`Unknown test tool: ${toolName}`);
  return {
    appId: 'inbox',
    tool,
    principal: {
      accountId: 'account-1',
      // The member the connection is acting as; a connection covering several
      // accounts may act as one other than the token's origin.
      activeAccountId,
      connection: null,
      clientId: 'client-1',
      scopes: tool.requiredCapabilities,
      subject: 'account-1',
    },
    request: {},
  } as CatalogInvocationContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockToolRun.mockResolvedValue({ data: { ok: true } });
  mockReserveEffect.mockResolvedValue(true);
  mockFinalizeEffect.mockResolvedValue(undefined);
});

describe('Inbox MCP adapter', () => {
  it('serves every public catalog tool and not the internal context tool', () => {
    const publicTools = INBOX_CAPABILITY_CATALOG.tools
      .filter(({ exposure }) => exposure.includes('mcp'))
      .map(({ name }) => name)
      .sort();
    expect(Object.keys(INBOX_MCP_HANDLERS).sort()).toEqual(publicTools);
    expect(INBOX_MCP_HANDLERS.getEmailContext).toBeUndefined();
  });

  it('adds a required idempotencyKey argument to exactly the tools that need one', () => {
    for (const [index, mcpTool] of INBOX_MCP_CATALOG.tools.entries()) {
      const canonical = INBOX_CAPABILITY_CATALOG.tools[index]!;
      const canonicalProperties = canonical.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(canonicalProperties)).not.toContain('idempotencyKey');
      const properties = mcpTool.inputSchema.properties as Record<string, unknown>;
      if (canonical.idempotency === 'required') {
        expect(properties.idempotencyKey).toMatchObject({ type: 'string', minLength: 1 });
        expect(mcpTool.inputSchema.required).toEqual(expect.arrayContaining(['idempotencyKey']));
      } else {
        expect(mcpTool).toBe(canonical);
      }
    }
  });

  it('binds a read to the OAuth-selected member account with no mailbox scope', async () => {
    mockToolRun.mockResolvedValue({ data: { id: 'email-2' } });
    await expect(
      INBOX_MCP_HANDLERS.readEmail?.({ emailId: 'email-2' }, context('readEmail', 'account-2')),
    ).resolves.toEqual({ structuredContent: { data: { id: 'email-2' } } });
    expect(mockToolRun).toHaveBeenCalledWith(
      'readEmail',
      { emailId: 'email-2' },
      { accountId: 'account-2' },
    );
    expect(mockReserveEffect).not.toHaveBeenCalled();
  });

  it('reserves the key, strips it from the tool input and passes it as context', async () => {
    await expect(
      INBOX_MCP_HANDLERS.sendEmail?.(
        { to: [{ address: 'person@example.com' }], text: 'Hi', idempotencyKey: 'client-key-1' },
        context('sendEmail'),
      ),
    ).resolves.toEqual({ structuredContent: { data: { ok: true } } });

    expect(mockReserveEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveAccountId: 'account-1',
        appSlug: 'inbox',
        tool: 'sendEmail',
        authorizationId: 'mcp:client-1',
        keyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(mockToolRun).toHaveBeenCalledWith(
      'sendEmail',
      { to: [{ address: 'person@example.com' }], text: 'Hi' },
      { accountId: 'account-1', idempotencyKey: 'client-key-1' },
    );
    expect(mockFinalizeEffect).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'sendEmail', statusCode: 200 }),
    );
  });

  it('refuses an effect without a key, and a reused key before executing', async () => {
    await expect(
      INBOX_MCP_HANDLERS.trashEmail?.({ emailId: 'email-1' }, context('trashEmail')),
    ).rejects.toMatchObject({ statusCode: 400 });

    mockReserveEffect.mockResolvedValue(false);
    await expect(
      INBOX_MCP_HANDLERS.moveEmail?.(
        { emailId: 'email-1', mailbox: 'archive', idempotencyKey: 'used' },
        context('moveEmail'),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(mockToolRun).not.toHaveBeenCalled();
    expect(mockFinalizeEffect).not.toHaveBeenCalled();
  });

  it('records a failed effect with its status before rethrowing', async () => {
    mockToolRun.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 404 }));
    await expect(
      INBOX_MCP_HANDLERS.archiveEmail?.(
        { emailId: 'email-1', idempotencyKey: 'k' },
        context('archiveEmail'),
      ),
    ).rejects.toThrow('gone');
    // A plain Error carries no ApiError status, so it settles as a 500.
    expect(mockFinalizeEffect).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'archiveEmail', statusCode: 500 }),
    );
  });
});
