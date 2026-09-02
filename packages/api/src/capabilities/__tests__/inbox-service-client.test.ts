const mockConfigureServiceAuth = jest.fn();
const mockOxyServices = jest.fn().mockImplementation((options) => ({
  options,
  configureServiceAuth: mockConfigureServiceAuth,
}));

jest.mock('@oxyhq/core', () => ({ OxyServices: mockOxyServices }));

async function loadServiceClient(): Promise<typeof import('../inbox-service-client')> {
  let loaded: typeof import('../inbox-service-client') | undefined;
  await jest.isolateModulesAsync(async () => {
    loaded = await import('../inbox-service-client');
  });
  if (!loaded) throw new Error('Inbox service client module did not load');
  return loaded;
}

describe('Inbox service client', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.INBOX_APPLICATION_KEY;
    delete process.env.INBOX_APPLICATION_SECRET;
    delete process.env.OXY_API_URL;
  });

  afterAll(() => {
    delete process.env.INBOX_APPLICATION_KEY;
    delete process.env.INBOX_APPLICATION_SECRET;
    delete process.env.OXY_API_URL;
  });

  it('fails closed and caches the unconfigured state', async () => {
    const { inboxServiceClient } = await loadServiceClient();
    expect(inboxServiceClient()).toBeNull();

    process.env.INBOX_APPLICATION_KEY = 'late-key';
    process.env.INBOX_APPLICATION_SECRET = 'late-secret';
    expect(inboxServiceClient()).toBeNull();
    expect(mockOxyServices).not.toHaveBeenCalled();
  });

  it('configures one cached client with trimmed credentials and base URL', async () => {
    process.env.INBOX_APPLICATION_KEY = '  application-key  ';
    process.env.INBOX_APPLICATION_SECRET = '  application-secret  ';
    process.env.OXY_API_URL = 'https://api.example.test/';
    const { inboxServiceClient } = await loadServiceClient();

    const first = inboxServiceClient();
    expect(first).not.toBeNull();
    expect(inboxServiceClient()).toBe(first);
    expect(mockOxyServices).toHaveBeenCalledTimes(1);
    expect(mockOxyServices).toHaveBeenCalledWith({ baseURL: 'https://api.example.test' });
    expect(mockConfigureServiceAuth).toHaveBeenCalledWith(
      'application-key',
      'application-secret',
    );
  });

  it('requires configuration explicitly when publishing is mandatory', async () => {
    const { requiredInboxServiceClient } = await loadServiceClient();
    expect(() => requiredInboxServiceClient()).toThrow(
      'Inbox application credentials are not configured',
    );
  });

  it('returns the configured client from the required accessor', async () => {
    process.env.INBOX_APPLICATION_KEY = 'application-key';
    process.env.INBOX_APPLICATION_SECRET = 'application-secret';
    const { requiredInboxServiceClient } = await loadServiceClient();

    const client = requiredInboxServiceClient();
    expect(client).not.toBeNull();
    expect(mockOxyServices).toHaveBeenCalledWith({ baseURL: 'https://api.oxy.so' });
  });
});
