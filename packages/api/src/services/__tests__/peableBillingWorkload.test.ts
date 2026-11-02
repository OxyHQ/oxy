const mockCredentials = jest.fn();
const mockProvider = jest.fn(() => mockCredentials);
const mockOxyDispose = jest.fn();
const mockOxy = { dispose: mockOxyDispose };
const mockOxyServer = jest.fn(() => mockOxy);
const mockClientDispose = jest.fn();
const mockMerchant = jest.fn();
const mockClient = { dispose: mockClientDispose, merchants: { retrieve: mockMerchant } };
const mockPeable = jest.fn(() => mockClient);
jest.mock('@oxy.so/core/server', () => ({ OxyServer: mockOxyServer }));
jest.mock('@oxy.so/core/server/aws', () => ({ createAwsWorkloadCredentialProvider: mockProvider }));
jest.mock('@peable.to/sdk', () => ({ peableForOxyService: mockPeable }));
import {
  assertPeableBillingMerchant,
  createPeableBillingClient,
} from '../peableBillingWorkload.service';
const names = [
  'OXY_ONE_PEABLE_PUBLIC_KEY',
  'OXY_ONE_PEABLE_SECRET',
  'OXY_PEABLE_BILLING_AWS_PROFILE',
  'OXY_API_URL',
] as const;
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
beforeEach(() => {
  jest.clearAllMocks();
  for (const name of names) delete process.env[name];
});
afterAll(() => {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});
it('requires an explicit billing profile before constructing any workload client', () => {
  expect(() => createPeableBillingClient()).toThrow('OXY_PEABLE_BILLING_AWS_PROFILE');
  expect(mockOxyServer).not.toHaveBeenCalled();
  expect(mockProvider).not.toHaveBeenCalled();
  expect(mockPeable).not.toHaveBeenCalled();
});
it.each(['OXY_ONE_PEABLE_PUBLIC_KEY', 'OXY_ONE_PEABLE_SECRET'])(
  'rejects retired %s even with a profile',
  (name) => {
    process.env[name] = 'legacy';
    process.env.OXY_PEABLE_BILLING_AWS_PROFILE = 'billing';
    expect(() => createPeableBillingClient()).toThrow('remove OXY_ONE_PEABLE_PUBLIC_KEY');
    expect(mockProvider).not.toHaveBeenCalled();
  },
);
it('uses the reviewed profile and pinned keys without selecting an application by configuration', () => {
  process.env.OXY_PEABLE_BILLING_AWS_PROFILE = 'reviewed-billing';
  process.env.OXY_API_URL = 'https://identity.example.test/';
  const keys = {
    invoiceAuthorityKeys: { invoice: 'public' },
    taxQuoteAuthorityKeys: { tax: 'public' },
  };
  const owned = createPeableBillingClient(keys);
  expect(mockProvider).toHaveBeenCalledWith({ profile: 'reviewed-billing' });
  expect(mockOxyServer).toHaveBeenCalledWith({
    baseURL: 'https://identity.example.test',
    workloadCredentials: mockCredentials,
  });
  expect(mockPeable).toHaveBeenCalledWith({ oxy: mockOxy, ...keys });
  expect(mockCredentials).not.toHaveBeenCalled();
  owned.dispose();
  owned.dispose();
  expect(mockClientDispose).toHaveBeenCalledTimes(1);
  expect(mockOxyDispose).toHaveBeenCalledTimes(1);
});
it('does not dispose a host owned by explicit deployment composition', () => {
  const host = { createServiceClient: jest.fn(), dispose: jest.fn() };
  const owned = createPeableBillingClient({}, host);
  expect(mockProvider).not.toHaveBeenCalled();
  expect(mockPeable).toHaveBeenCalledWith({ oxy: host });
  owned.dispose();
  expect(host.dispose).not.toHaveBeenCalled();
  expect(mockClientDispose).toHaveBeenCalledTimes(1);
});
it.each(['id', 'oxyAppId', 'environment'])(
  'refuses a merchant with different %s',
  async (field) => {
    const cfg = {
      merchantId: 'merch_reviewed',
      applicationId: 'billing-app',
      namespace: { environment: 'production' },
    };
    mockMerchant.mockResolvedValue({
      id: cfg.merchantId,
      oxyAppId: cfg.applicationId,
      environment: 'production',
      [field]: 'other',
    });
    const host = { createServiceClient: jest.fn() };
    const owned = createPeableBillingClient({}, host);
    await expect(assertPeableBillingMerchant(owned.client, cfg)).rejects.toThrow(
      'workload owner differs',
    );
  },
);
it('accepts only the complete reviewed merchant/application/environment binding', async () => {
  const cfg = {
    merchantId: 'merch_reviewed',
    applicationId: 'billing-app',
    namespace: { environment: 'production' },
  };
  mockMerchant.mockResolvedValue({
    id: cfg.merchantId,
    oxyAppId: cfg.applicationId,
    environment: 'production',
  });
  const owned = createPeableBillingClient({}, { createServiceClient: jest.fn() });
  await expect(assertPeableBillingMerchant(owned.client, cfg)).resolves.toBeUndefined();
});
it('disposes its host if SDK construction fails', () => {
  process.env.OXY_PEABLE_BILLING_AWS_PROFILE = 'reviewed-billing';
  mockPeable.mockImplementationOnce(() => {
    throw new Error('SDK construction failed');
  });
  expect(() => createPeableBillingClient()).toThrow('SDK construction failed');
  expect(mockOxyDispose).toHaveBeenCalledTimes(1);
});
it('disposes its host even if closing the SDK client fails', () => {
  process.env.OXY_PEABLE_BILLING_AWS_PROFILE = 'reviewed-billing';
  const owned = createPeableBillingClient();
  mockClientDispose.mockImplementationOnce(() => {
    throw new Error('Client close failed');
  });
  expect(() => owned.dispose()).toThrow('Client close failed');
  owned.dispose();
  expect(mockOxyDispose).toHaveBeenCalledTimes(1);
  expect(mockClientDispose).toHaveBeenCalledTimes(1);
});
