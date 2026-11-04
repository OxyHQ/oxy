import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mockDispose = jest.fn();
const mockRetrieve = jest.fn();
const mockClient = { merchants: { retrieve: mockRetrieve }, dispose: mockDispose };
const mockFactory = jest.fn(() => ({ client: mockClient, dispose: mockDispose }));
jest.mock('../peablePersonalRuntime.service', () => ({
  getPeablePersonalRuntime: () => undefined,
}));
jest.mock('../peableBillingWorkload.service', () => ({
  ...jest.requireActual('../peableBillingWorkload.service'),
  createPeableBillingClient: mockFactory,
}));
import {
  loadPeablePersonalManagement,
  stopPeablePersonalManagement,
} from '../peablePersonalManagement.service';
const previous = { ...process.env };
let directory: string;
const configuration = {
  merchantId: 'merch_reviewed',
  applicationId: 'app_reviewed',
  namespace: { mode: 'live', environment: 'production' },
  offers: [{ offerId: 'plus', offerVersion: 1, planId: 'plan', providerPriceId: 'price' }],
};
beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.OXY_ONE_PEABLE_PUBLIC_KEY;
  delete process.env.OXY_ONE_PEABLE_SECRET;
  delete process.env.OXY_PEABLE_BILLING_AWS_PROFILE;
  delete process.env.OXY_ONE_PEABLE_MANAGEMENT_FILE;
  directory = await mkdtemp(join(tmpdir(), 'billing-management-'));
  mockRetrieve.mockResolvedValue({
    id: configuration.merchantId,
    oxy_app_id: configuration.applicationId,
    environment: 'production',
  });
});
afterEach(async () => {
  await stopPeablePersonalManagement();
  await rm(directory, { recursive: true, force: true });
  process.env = { ...previous };
});
async function configure() {
  const path = join(directory, 'management.json');
  await writeFile(path, JSON.stringify(configuration));
  process.env.OXY_ONE_PEABLE_MANAGEMENT_FILE = path;
  process.env.OXY_PEABLE_BILLING_AWS_PROFILE = 'reviewed-billing';
}
it('does not construct a client when management is unconfigured', async () => {
  await expect(loadPeablePersonalManagement()).resolves.toBeUndefined();
  expect(mockFactory).not.toHaveBeenCalled();
});
it('does not use ambient authority when a management file exists', async () => {
  await configure();
  delete process.env.OXY_PEABLE_BILLING_AWS_PROFILE;
  await expect(loadPeablePersonalManagement()).rejects.toThrow('OXY_PEABLE_BILLING_AWS_PROFILE');
  expect(mockFactory).not.toHaveBeenCalled();
});
it('shares one verified management client and disposes it at shutdown', async () => {
  await configure();
  const [first, second] = await Promise.all([
    loadPeablePersonalManagement(),
    loadPeablePersonalManagement(),
  ]);
  expect(first).toBe(second);
  expect(mockFactory).toHaveBeenCalledTimes(1);
  expect(mockRetrieve).toHaveBeenCalledTimes(1);
  await stopPeablePersonalManagement();
  expect(mockDispose).toHaveBeenCalledTimes(1);
});
it('disposes mismatched authority and allows a later verified retry', async () => {
  await configure();
  mockRetrieve.mockResolvedValueOnce({
    id: configuration.merchantId,
    oxy_app_id: 'inbox',
    environment: 'production',
  });
  await expect(loadPeablePersonalManagement()).rejects.toThrow('workload owner differs');
  expect(mockDispose).toHaveBeenCalledTimes(1);
  await expect(loadPeablePersonalManagement()).resolves.toHaveProperty(
    'configuration',
    configuration,
  );
  expect(mockFactory).toHaveBeenCalledTimes(2);
});
