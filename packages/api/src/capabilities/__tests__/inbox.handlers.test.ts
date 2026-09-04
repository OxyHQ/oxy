import type { CatalogInvocationContext } from '@oxyhq/mcp';

const mockSearchMessages = jest.fn();
const mockSendMessage = jest.fn();
const mockGetMessage = jest.fn();
const mockEnsureMailboxes = jest.fn();
const mockGetQuotaUsage = jest.fn();
const mockGetThread = jest.fn();
const mockListLabels = jest.fn();
const mockListMailboxes = jest.fn();
const mockListMessages = jest.fn();
const mockMoveMessage = jest.fn();
const mockUpdateMessageFlags = jest.fn();
const mockReserveEffect = jest.fn();
const mockFinalizeEffect = jest.fn();

jest.mock('../../controllers/email.controller', () => ({
  searchMessagesForUser: (...args: unknown[]) => mockSearchMessages(...args),
  sendMessageForUser: (...args: unknown[]) => mockSendMessage(...args),
}));
jest.mock('../../services/email.service', () => ({
  emailService: {
    ensureMailboxes: (...args: unknown[]) => mockEnsureMailboxes(...args),
    getMessage: (...args: unknown[]) => mockGetMessage(...args),
    getQuotaUsage: (...args: unknown[]) => mockGetQuotaUsage(...args),
    getThread: (...args: unknown[]) => mockGetThread(...args),
    listLabels: (...args: unknown[]) => mockListLabels(...args),
    listMailboxes: (...args: unknown[]) => mockListMailboxes(...args),
    listMessages: (...args: unknown[]) => mockListMessages(...args),
    moveMessage: (...args: unknown[]) => mockMoveMessage(...args),
    updateMessageFlags: (...args: unknown[]) => mockUpdateMessageFlags(...args),
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
      // The member the connection is acting as — the same account here, since
      // this connection covers only the one its token was minted for.
      activeAccountId: 'account-1',
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

  it('reads the mailbox of the connection member being acted as', async () => {
    const message = { id: 'message-2', subject: 'From the other account' };
    mockGetMessage.mockResolvedValue(message);
    const linked = context('readEmail');
    const acting = {
      ...linked,
      principal: {
        ...linked.principal,
        // The token stays bound to `account-1`; the connection is acting as a
        // member that approved its own membership on the IdP.
        activeAccountId: 'account-2',
        connection: {
          connection_id: 'connection-1',
          origin_account_id: 'account-1',
          active_account_id: 'account-2',
          accounts: [
            { account_id: 'account-1', is_origin: true, linked_at: '2026-01-01T00:00:00.000Z' },
            { account_id: 'account-2', is_origin: false, linked_at: '2026-02-01T00:00:00.000Z' },
          ],
        },
      },
    } as CatalogInvocationContext;

    await expect(INBOX_MCP_HANDLERS.readEmail?.({ messageId: 'message-2' }, acting))
      .resolves.toEqual({ structuredContent: { data: message } });
    expect(mockGetMessage).toHaveBeenCalledWith('account-2', 'message-2');
  });

  it('rejects a missing or unknown message', async () => {
    await expect(INBOX_MCP_HANDLERS.readEmail?.(
      {},
      context('readEmail'),
    )).rejects.toMatchObject({ statusCode: 400 });

    mockGetMessage.mockResolvedValue(null);
    await expect(INBOX_MCP_HANDLERS.readEmail?.(
      { messageId: 'missing' },
      context('readEmail'),
    )).rejects.toMatchObject({ statusCode: 404 });
  });

  it('searches and reads threads within the selected account', async () => {
    const search = { data: [{ id: 'message-1' }], pagination: { total: 1 } };
    const thread = [{ id: 'message-1' }, { id: 'message-2' }];
    mockSearchMessages.mockResolvedValue(search);
    mockGetThread.mockResolvedValue(thread);

    await expect(INBOX_MCP_HANDLERS.searchEmails?.(
      { q: 'invoice', limit: 10 },
      context('searchEmails'),
    )).resolves.toEqual({ structuredContent: search });
    expect(mockSearchMessages).toHaveBeenCalledWith('account-1', { q: 'invoice', limit: 10 });

    await expect(INBOX_MCP_HANDLERS.getEmailThread?.(
      { messageId: 'message-1' },
      context('getEmailThread'),
    )).resolves.toEqual({ structuredContent: { data: thread } });
    expect(mockGetThread).toHaveBeenCalledWith('account-1', 'message-1');
  });

  it('lists unread mail with bounded pagination and cursor metadata', async () => {
    mockListMessages
      .mockResolvedValueOnce({
        data: [{ id: 'message-1' }],
        total: 2,
        limit: 100,
        offset: 0,
        nextCursor: 'cursor-2',
      })
      .mockResolvedValueOnce({
        data: [],
        total: 0,
        limit: 50,
        offset: 0,
      });

    await expect(INBOX_MCP_HANDLERS.getUnreadEmails?.(
      { limit: 500, offset: -10 },
      context('getUnreadEmails'),
    )).resolves.toEqual({
      structuredContent: {
        data: [{ id: 'message-1' }],
        pagination: {
          total: 2,
          limit: 100,
          offset: 0,
          hasMore: true,
          nextCursor: 'cursor-2',
        },
      },
    });
    expect(mockListMessages).toHaveBeenCalledWith('account-1', null, {
      limit: 100,
      offset: 0,
      unseenOnly: true,
    });

    await expect(INBOX_MCP_HANDLERS.getUnreadEmails?.(
      { limit: 'invalid' },
      context('getUnreadEmails'),
    )).resolves.toEqual({
      structuredContent: {
        data: [],
        pagination: { total: 0, limit: 50, offset: 0, hasMore: false },
      },
    });
  });

  it('lists mailboxes, labels, and quota for only the selected account', async () => {
    const mailboxes = [{ id: 'inbox' }];
    const labels = [{ id: 'important' }];
    const quota = { used: 10, limit: 100 };
    mockListMailboxes.mockResolvedValue(mailboxes);
    mockListLabels.mockResolvedValue(labels);
    mockGetQuotaUsage.mockResolvedValue(quota);

    await expect(INBOX_MCP_HANDLERS.listMailboxes?.(
      {},
      context('listMailboxes'),
    )).resolves.toEqual({ structuredContent: { data: mailboxes } });
    expect(mockEnsureMailboxes).toHaveBeenCalledWith('account-1');
    expect(mockListMailboxes).toHaveBeenCalledWith('account-1');

    await expect(INBOX_MCP_HANDLERS.listLabels?.(
      {},
      context('listLabels'),
    )).resolves.toEqual({ structuredContent: { data: labels } });
    expect(mockListLabels).toHaveBeenCalledWith('account-1');

    await expect(INBOX_MCP_HANDLERS.getEmailQuota?.(
      {},
      context('getEmailQuota'),
    )).resolves.toEqual({ structuredContent: { data: quota } });
    expect(mockGetQuotaUsage).toHaveBeenCalledWith('account-1');
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

  it('moves mail and updates flags through durable effects', async () => {
    const moved = { id: 'message-1', mailboxId: 'archive' };
    const flagged = { id: 'message-1', flags: { seen: true } };
    mockMoveMessage.mockResolvedValue(moved);
    mockUpdateMessageFlags.mockResolvedValue(flagged);

    await expect(INBOX_MCP_HANDLERS.moveEmail?.(
      {
        messageId: 'message-1',
        mailboxId: 'archive',
        idempotencyKey: 'run-1:move-2',
      },
      context('moveEmail'),
    )).resolves.toEqual({ structuredContent: { data: moved } });
    expect(mockMoveMessage).toHaveBeenCalledWith('account-1', 'message-1', 'archive');

    await expect(INBOX_MCP_HANDLERS.updateEmailFlags?.(
      {
        messageId: 'message-1',
        flags: { seen: true },
        idempotencyKey: 'run-1:flags-1',
      },
      context('updateEmailFlags'),
    )).resolves.toEqual({ structuredContent: { data: flagged } });
    expect(mockUpdateMessageFlags).toHaveBeenCalledWith(
      'account-1',
      'message-1',
      { seen: true },
    );
  });

  it('validates write inputs at the direct domain boundary', async () => {
    await expect(INBOX_MCP_HANDLERS.sendEmail?.(
      { idempotencyKey: 'run-1:send-invalid' },
      context('sendEmail'),
    )).rejects.toMatchObject({ statusCode: 400 });

    await expect(INBOX_MCP_HANDLERS.updateEmailFlags?.(
      {
        messageId: 'message-1',
        flags: [],
        idempotencyKey: 'run-1:flags-invalid',
      },
      context('updateEmailFlags'),
    )).rejects.toMatchObject({ statusCode: 400 });
  });

  it('records a failed domain effect before returning its error', async () => {
    mockMoveMessage.mockRejectedValue(new Error('mail store unavailable'));

    await expect(INBOX_MCP_HANDLERS.moveEmail?.(
      {
        messageId: 'message-1',
        mailboxId: 'archive',
        idempotencyKey: 'run-1:move-failed',
      },
      context('moveEmail'),
    )).rejects.toThrow('mail store unavailable');

    expect(mockFinalizeEffect).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'moveEmail',
      statusCode: 500,
    }));
  });
});
