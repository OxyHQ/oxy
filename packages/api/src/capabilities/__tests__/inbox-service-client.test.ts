const mockCredentials = jest.fn();
const mockProvider = jest.fn(() => mockCredentials);
const mockOxyServer = jest.fn().mockImplementation((options) => ({ options }));
jest.mock('@oxy.so/core/server', () => ({ OxyServer: mockOxyServer }));
jest.mock('@oxy.so/core/server/aws', () => ({ createAwsWorkloadCredentialProvider: mockProvider }));
const names = [
  'INBOX_APPLICATION_KEY',
  'INBOX_APPLICATION_SECRET',
  'OXY_API_URL',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
] as const;
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  for (const name of names) delete process.env[name];
});
afterAll(() => {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});
it('constructs one lazy workload client even without ECS environment, using the shared temporary-role provider', async () => {
  process.env.OXY_API_URL = 'https://api.example.test/';
  const { inboxServiceClient, requiredInboxServiceClient } = await import(
    '../inbox-service-client'
  );
  const client = inboxServiceClient();
  expect(requiredInboxServiceClient()).toBe(client);
  expect(mockOxyServer).toHaveBeenCalledTimes(1);
  expect(mockOxyServer).toHaveBeenCalledWith({
    baseURL: 'https://api.example.test',
    workloadCredentials: mockCredentials,
  });
  expect(mockProvider).toHaveBeenCalledTimes(1);
  expect(mockCredentials).not.toHaveBeenCalled();
});
it.each([
  { INBOX_APPLICATION_KEY: 'old-key' },
  { INBOX_APPLICATION_SECRET: 'old-secret' },
  { INBOX_APPLICATION_KEY: 'old-key', INBOX_APPLICATION_SECRET: 'old-secret' },
])(
  'rejects retired own key configuration without credential or workload fallback (%o)',
  async (env) => {
    Object.assign(process.env, env);
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/temporary-role';
    const { inboxServiceClient } = await import('../inbox-service-client');
    expect(inboxServiceClient).toThrow('Inbox uses workload identity');
    expect(mockOxyServer).not.toHaveBeenCalled();
  },
);
