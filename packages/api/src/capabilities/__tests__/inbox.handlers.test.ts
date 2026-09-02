import type { CatalogInvocationContext } from '@oxyhq/mcp';

const mockSearchMessages = jest.fn();
const mockSendMessage = jest.fn();
const mockGetMessage = jest.fn();
const mockReserveEffect = jest.fn();
const mockFinalizeEffect = jest.fn();

jest.mock('../../controllers/email.controller', () => ({
  searchMessagesForUser: (...args: unknown[]) => mockSearchMessages(...args),
  sendMessageForUser: (...args: unknown[]) => mockSendMessage(...args),
}));
jest.mock('../../services/email.service', () => ({
  emailService: {
    ensureMailboxes: jest.fn(),
    getMessage: (...args: unknown[]) => mockGetMessage(...args),
    getQuotaUsage: jest.fn(),
    getThread: jest.fn(),
    listLabels: jest.fn(),
    listMailboxes: jest.fn(),
    listMessages: jest.fn(),
    moveMessage: jest.fn(),
    updateMessageFlags: jest.fn(),
  },
}));
jest.mock('../../services/capabilityRuntimeStore.service', () => ({
  reserveCapabilityEffectFor: (...args: unknown[]) => mockReserveEffect(...args),
  finalizeCapabilityEffectFor: (...args: unknown[]) => mockFinalizeEffect(...args),
}));

import { INBOX_CAPABILITY_CATALOG } from '../inbox.catalog';
import { INBOX_MCP_HANDLERS } from '../inbox.handlers';

function context(toolName: string): CatalogInvocationContext {
  const tool = INBOX_CAPABILITY_CATALOG.tools.find(({ name }) => name === toolName);
  if (!tool) throw new Error(`Unknown test tool: ${toolName}`);
  return {
    appId: 'inbox',
    tool,
    principal: {
      accountId: 'account-1',
      clientId: 'client-1',
      scopes: tool.requiredCapabilities,
      subject: 'account-1',
    },
    request: {},
  } as CatalogInvocationContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReserveEffect.mockResolvedValue(true);
  mockFinalizeEffect.mockResolvedValue(undefined);
});

describe('Inbox MCP handlers', () => {
  it('implements every public catalog tool exactly once', () => {
    const publicTools = INBOX_CAPABILITY_CATALOG.tools
      .filter(({ exposure }) => exposure.includes('mcp'))
      .map(({ name }) => name)
      .sort();

    expect(Object.keys(INBOX_MCP_HANDLERS).sort()).toEqual(publicTools);
  });

  it('binds reads to the OAuth-selected account', async () => {
    const message = { id: 'message-1', subject: 'Hello' };
    mockGetMessage.mockResolvedValue(message);

    await expect(INBOX_MCP_HANDLERS.readEmail?.(
      { messageId: 'message-1' },
      context('readEmail'),
    )).resolves.toEqual({ structuredContent: { data: message } });
    expect(mockGetMessage).toHaveBeenCalledWith('account-1', 'message-1');
  });

  it('reserves and finalizes a durable idempotency key around a send', async () => {
    mockSendMessage.mockResolvedValue({ data: { id: 'sent-1' } });
    const input = {
      to: ['person@example.com'],
      subject: 'Hello',
      text: 'Body',
      idempotencyKey: 'run-1:send-1',
    };

    await expect(INBOX_MCP_HANDLERS.sendEmail?.(
      input,
      context('sendEmail'),
    )).resolves.toEqual({ structuredContent: { data: { id: 'sent-1' } } });

    expect(mockReserveEffect).toHaveBeenCalledWith(expect.objectContaining({
      effectiveAccountId: 'account-1',
      appSlug: 'inbox',
      tool: 'sendEmail',
      authorizationId: 'mcp:client-1',
      keyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(mockSendMessage).toHaveBeenCalledWith(
      'account-1',
      input,
      'run-1:send-1',
    );
    expect(mockFinalizeEffect).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'sendEmail',
      statusCode: 200,
    }));
  });

  it('rejects a duplicate key before executing the domain effect', async () => {
    mockReserveEffect.mockResolvedValue(false);

    await expect(INBOX_MCP_HANDLERS.moveEmail?.(
      {
        messageId: 'message-1',
        mailboxId: 'mailbox-2',
        idempotencyKey: 'run-1:move-1',
      },
      context('moveEmail'),
    )).rejects.toMatchObject({ statusCode: 409 });

    expect(mockFinalizeEffect).not.toHaveBeenCalled();
  });
});
