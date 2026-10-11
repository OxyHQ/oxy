const mockOxyServer = jest.fn().mockImplementation((options) => ({ options }));

jest.mock('@oxy.so/core/server', () => ({
  OxyServer: mockOxyServer,
  // The real predicate, minus the FULL_URI variant: ECS sets the relative URI on
  // every task, and that is the presence these cases toggle.
  canAttestWorkloadIdentity: (env: NodeJS.ProcessEnv = process.env) =>
    Boolean(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI),
}));

async function loadServiceClient(): Promise<typeof import('../inbox-service-client')> {
  let loaded: typeof import('../inbox-service-client') | undefined;
  await jest.isolateModulesAsync(async () => {
    loaded = await import('../inbox-service-client');
  });
  if (!loaded) throw new Error('Inbox service client module did not load');
  return loaded;
}

const ENV_NAMES = [
  'INBOX_APPLICATION_KEY',
  'INBOX_APPLICATION_SECRET',
  'OXY_API_URL',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
] as const;

function clearEnv(): void {
  for (const name of ENV_NAMES) delete process.env[name];
}

describe('Inbox service client', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    clearEnv();
  });

  afterAll(() => {
    clearEnv();
  });

  it('fails closed and caches the unconfigured state', async () => {
    const { inboxServiceClient } = await loadServiceClient();
    expect(inboxServiceClient()).toBeNull();

    process.env.INBOX_APPLICATION_KEY = 'late-key';
    process.env.INBOX_APPLICATION_SECRET = 'late-secret';
    expect(inboxServiceClient()).toBeNull();
    expect(mockOxyServer).not.toHaveBeenCalled();
  });

  it('configures one cached client with trimmed credentials and base URL', async () => {
    process.env.INBOX_APPLICATION_KEY = '  application-key  ';
    process.env.INBOX_APPLICATION_SECRET = '  application-secret  ';
    process.env.OXY_API_URL = 'https://api.example.test/';
    const { inboxServiceClient } = await loadServiceClient();

    const first = inboxServiceClient();
    expect(first).not.toBeNull();
    expect(inboxServiceClient()).toBe(first);
    expect(mockOxyServer).toHaveBeenCalledTimes(1);
    expect(mockOxyServer).toHaveBeenCalledWith({
      baseURL: 'https://api.example.test',
      serviceAuth: { apiKey: 'application-key', apiSecret: 'application-secret' },
    });
  });

  it('attests the task role when there is no pair at all', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';
    const { inboxServiceClient } = await loadServiceClient();

    expect(inboxServiceClient()).not.toBeNull();
    // No `serviceAuth`: OxyServer.serviceToken() then attests (ADR 0026).
    expect(mockOxyServer).toHaveBeenCalledTimes(1);
    expect(mockOxyServer).toHaveBeenCalledWith({ baseURL: 'https://api.oxy.so' });
  });

  it('keeps using a full pair on a host that could attest', async () => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';
    process.env.INBOX_APPLICATION_KEY = 'application-key';
    process.env.INBOX_APPLICATION_SECRET = 'application-secret';
    const { inboxServiceClient } = await loadServiceClient();

    inboxServiceClient();
    expect(mockOxyServer).toHaveBeenCalledWith({
      baseURL: 'https://api.oxy.so',
      serviceAuth: { apiKey: 'application-key', apiSecret: 'application-secret' },
    });
  });

  it.each([
    ['only the key', { INBOX_APPLICATION_KEY: 'application-key' }],
    ['only the secret', { INBOX_APPLICATION_SECRET: 'application-secret' }],
    ['a blank secret', { INBOX_APPLICATION_KEY: 'application-key', INBOX_APPLICATION_SECRET: ' ' }],
  ])('refuses half a pair (%s) rather than attesting instead', async (_label, env) => {
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/task';
    Object.assign(process.env, env);
    const { inboxServiceClient, inboxServiceIdentity } = await loadServiceClient();

    expect(inboxServiceIdentity()).toEqual({ kind: 'none', reason: 'half_pair' });
    expect(inboxServiceClient()).toBeNull();
    expect(mockOxyServer).not.toHaveBeenCalled();
  });

  it('decides one identity for every Inbox caller', async () => {
    const { inboxServiceIdentity } = await loadServiceClient();

    expect(inboxServiceIdentity({})).toEqual({ kind: 'none', reason: 'no_identity' });
    expect(
      inboxServiceIdentity({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task' }),
    ).toEqual({ kind: 'workload' });
    expect(
      inboxServiceIdentity({
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task',
        INBOX_APPLICATION_KEY: 'k',
        INBOX_APPLICATION_SECRET: 's',
      }),
    ).toEqual({ kind: 'credential', apiKey: 'k', apiSecret: 's' });
  });

  it('requires an identity explicitly when publishing is mandatory', async () => {
    const { requiredInboxServiceClient } = await loadServiceClient();
    expect(() => requiredInboxServiceClient()).toThrow(
      'Inbox application identity is not available',
    );
  });

  it('returns the configured client from the required accessor', async () => {
    process.env.INBOX_APPLICATION_KEY = 'application-key';
    process.env.INBOX_APPLICATION_SECRET = 'application-secret';
    const { requiredInboxServiceClient } = await loadServiceClient();

    const client = requiredInboxServiceClient();
    expect(client).not.toBeNull();
    expect(mockOxyServer).toHaveBeenCalledWith({
      baseURL: 'https://api.oxy.so',
      serviceAuth: { apiKey: 'application-key', apiSecret: 'application-secret' },
    });
  });
});
