const mockCreateCatalogMcpHttpService = jest.fn();
const mockIntrospectMcpAccessToken = jest.fn();
const mockResolveMcpResource = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@oxyhq/mcp', () => ({
  createCatalogMcpHttpService: (...args: unknown[]) => mockCreateCatalogMcpHttpService(...args),
}));
jest.mock('../../services/mcpOAuth.service', () => ({
  introspectMcpAccessToken: (...args: unknown[]) => mockIntrospectMcpAccessToken(...args),
  resolveMcpResource: (...args: unknown[]) => mockResolveMcpResource(...args),
}));
jest.mock('../inbox.handlers', () => ({ INBOX_MCP_HANDLERS: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));

import { INBOX_CAPABILITY_CATALOG } from '../inbox.catalog';
import {
  createInboxMcpHttpService,
  parseInboxMcpAllowedOrigins,
} from '../inbox-mcp-http';

describe('Inbox MCP HTTP service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.INBOX_MCP_ALLOWED_ORIGINS;
    delete process.env.OXY_API_URL;
    mockCreateCatalogMcpHttpService.mockImplementation((options) => ({ options }));
    mockResolveMcpResource.mockResolvedValue({ registeredByApplicationId: 'application-1' });
    mockIntrospectMcpAccessToken.mockResolvedValue({ active: true });
  });

  afterAll(() => {
    delete process.env.INBOX_MCP_ALLOWED_ORIGINS;
    delete process.env.OXY_API_URL;
  });

  it('keeps the trusted defaults and normalizes configured origins', () => {
    expect(parseInboxMcpAllowedOrigins(
      ' https://example.com,https://chatgpt.com,,https://example.com ',
    )).toEqual([
      'https://chatgpt.com',
      'https://claude.ai',
      'https://example.com',
    ]);
  });

  it('adapts the canonical catalog and binds introspection to its registered app', async () => {
    process.env.OXY_API_URL = 'https://api.example.test';
    process.env.INBOX_MCP_ALLOWED_ORIGINS = 'https://client.example.test';
    createInboxMcpHttpService();

    expect(mockCreateCatalogMcpHttpService).toHaveBeenCalledTimes(1);
    const options = mockCreateCatalogMcpHttpService.mock.calls[0][0];
    expect(options).toMatchObject({
      catalog: INBOX_CAPABILITY_CATALOG,
      authorizationServer: 'https://api.example.test',
      allowedOrigins: [
        'https://chatgpt.com',
        'https://claude.ai',
        'https://client.example.test',
      ],
      serverName: 'inbox-mcp',
    });

    await expect(options.introspectToken('access-token')).resolves.toEqual({ active: true });
    await options.introspectToken('second-token');
    expect(mockResolveMcpResource).toHaveBeenCalledTimes(1);
    expect(mockResolveMcpResource).toHaveBeenCalledWith('https://mcp.inbox.oxy.so');
    expect(mockIntrospectMcpAccessToken).toHaveBeenNthCalledWith(
      1,
      'access-token',
      'application-1',
    );
    expect(await options.authorize({}, { principal: { accountId: 'account-1' } })).toEqual({
      allowed: true,
      effectiveAccountId: 'account-1',
    });

    const error = new Error('adapter failure');
    options.logger.error('failed', error);
    expect(mockLoggerError).toHaveBeenCalledWith('failed', error);
  });

  it('does not cache a failed resource lookup', async () => {
    mockResolveMcpResource
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ registeredByApplicationId: 'application-2' });
    createInboxMcpHttpService();
    const options = mockCreateCatalogMcpHttpService.mock.calls[0][0];

    await expect(options.introspectToken('first-token')).rejects.toThrow('temporary failure');
    await expect(options.introspectToken('second-token')).resolves.toEqual({ active: true });
    expect(mockResolveMcpResource).toHaveBeenCalledTimes(2);
    expect(mockIntrospectMcpAccessToken).toHaveBeenCalledWith(
      'second-token',
      'application-2',
    );
  });
});
