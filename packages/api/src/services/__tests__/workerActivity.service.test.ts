import type { createEcosystemTraffic, EcosystemTrafficOptions } from '@oxy.so/core/server';
import { observeAssetJob, startWorkerActivity, stopWorkerActivity } from '../workerActivity.service';

type Publisher = ReturnType<typeof createEcosystemTraffic>;
const keys = ['OXY_ECOSYSTEM_ACTIVITY_ENABLED', 'AWS_REGION', 'OXY_ACTIVITY_API_KEY', 'OXY_ACTIVITY_API_SECRET', 'NODE_ENV'] as const;
let original: Array<string | undefined>;
const record = jest.fn();
const stop = jest.fn(async () => undefined);
const installFetch = jest.fn();
const create = jest.fn((_options: EcosystemTrafficOptions) => ({ record, stop, installFetch }) as unknown as Publisher);

beforeEach(() => {
  original = keys.map(key => process.env[key]);
  keys.forEach(key => { delete process.env[key]; });
  jest.clearAllMocks();
});
afterEach(async () => {
  await stopWorkerActivity();
  keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; });
});
function enable() {
  process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = 'true';
  process.env.AWS_REGION = 'us-west-2';
  process.env.OXY_ACTIVITY_API_KEY = 'dedicated-test-key';
  process.env.OXY_ACTIVITY_API_SECRET = 'dedicated-test-secret';
}

test('AWS storage configuration alone never enables activity; explicit false stays disabled', () => {
  process.env.AWS_REGION = 'us-west-2';
  expect(startWorkerActivity('oxy-asset-variant-worker', () => true, create)).toBeUndefined();
  process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = 'false';
  expect(startWorkerActivity('oxy-asset-variant-worker', () => true, create)).toBeUndefined();
  observeAssetJob('us-west-2');
  expect(create).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});
test('invalid enablement, region and incomplete dedicated credentials fail before publisher creation', () => {
  process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED = 'yes';
  expect(() => startWorkerActivity('worker', () => false, create)).toThrow('true or false');
  enable();
  process.env.AWS_REGION = 'private-host/path';
  expect(() => startWorkerActivity('worker', () => false, create)).toThrow('valid AWS_REGION');
  process.env.AWS_REGION = 'us-west-2';
  delete process.env.OXY_ACTIVITY_API_SECRET;
  expect(() => startWorkerActivity('worker', () => false, create)).toThrow('dedicated');
  expect(create).not.toHaveBeenCalled();
});
test('readiness follows the running consumer and shutdown stops the publisher exactly once without NODE_ENV', async () => {
  enable();
  let ready = false;
  startWorkerActivity('oxy-asset-variant-worker', () => ready, create);
  expect(installFetch).toHaveBeenCalledTimes(1);
  const options = create.mock.calls[0][0];
  expect(options.ready?.()).toBe(false);
  ready = true;
  expect(options.ready?.()).toBe(true);
  expect(() => startWorkerActivity('worker', () => ready, create)).toThrow('already running');
  ready = false;
  expect(options.ready?.()).toBe(false);
  await stopWorkerActivity();
  await stopWorkerActivity();
  expect(stop).toHaveBeenCalledTimes(1);
});
test('jobs report bounded media infrastructure metadata and legacy jobs retain unknown source geography', () => {
  enable();
  startWorkerActivity('oxy-asset-variant-worker', () => true, create);
  observeAssetJob('eu-west-1');
  observeAssetJob(undefined);
  observeAssetJob({ fileId: 'private-file', userId: 'private-user' });
  expect(record.mock.calls[0][0]).toEqual({ scope: 'internal', direction: 'inbound', activityType: 'media', sourceService: 'oxy-api', sourceRegion: 'eu-west-1', targetService: 'oxy-asset-variant-worker', targetRegion: 'us-west-2' });
  expect(record.mock.calls[1][0].sourceRegion).toBeUndefined();
  expect(record.mock.calls[2][0].sourceRegion).toBeUndefined();
  expect(JSON.stringify(record.mock.calls)).not.toMatch(/private|dedicated/);
});
