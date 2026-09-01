/**
 * Unit tests for transparency-checkpoint scheduling.
 *
 * Forces the in-process fallback path (no Redis) and mocks the service so we can
 * verify boot-time genesis publish and the missing-key visibility without Mongo.
 */

const mockBuildCheckpoint = jest.fn();
const mockGetLatestCheckpoint = jest.fn();

jest.mock('../../services/transparency.service', () => ({
  buildCheckpoint: (...args: unknown[]) => mockBuildCheckpoint(...args),
  getLatestCheckpoint: () => mockGetLatestCheckpoint(),
}));
jest.mock('../connection', () => ({ getQueueConnectionOptions: jest.fn(() => ({})) }));
jest.mock('../queueManager', () => ({ isQueueEnabled: () => false }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { logger } from '../../utils/logger';
import {
  publishCheckpoint,
  startTransparencyCheckpointJobs,
  stopTransparencyCheckpointJobs,
} from '../transparencyCheckpoint.queue';

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(async () => {
  jest.clearAllMocks();
  await stopTransparencyCheckpointJobs();
  delete process.env.OXY_PRIVATE_KEY;
  mockBuildCheckpoint.mockResolvedValue({
    index: 0,
    periodEnd: 1_800_000_000_000,
    treeSize: 0,
    root: 'a'.repeat(64),
    prevCheckpointHash: null,
    signatures: [{ publicKey: '04'.repeat(65), alg: 'ES256K-DER-SHA256', signature: 'sig' }],
    anchors: [],
  });
  mockGetLatestCheckpoint.mockResolvedValue(null);
});

afterEach(async () => {
  await stopTransparencyCheckpointJobs();
  delete process.env.OXY_PRIVATE_KEY;
});

describe('publishCheckpoint', () => {
  it('logs and swallows publish failures instead of throwing', async () => {
    mockBuildCheckpoint.mockRejectedValue(new Error('boom'));
    await expect(publishCheckpoint(Date.now())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('startTransparencyCheckpointJobs', () => {
  it('publishes a genesis checkpoint on boot when the log is empty', async () => {
    process.env.OXY_PRIVATE_KEY = 'a'.repeat(64);
    await startTransparencyCheckpointJobs();
    await flush();

    expect(mockBuildCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('does not publish on boot when a checkpoint already exists', async () => {
    process.env.OXY_PRIVATE_KEY = 'a'.repeat(64);
    mockGetLatestCheckpoint.mockResolvedValue({
      index: 0,
      periodEnd: 1_800_000_000_000,
      treeSize: 0,
      root: 'a'.repeat(64),
      prevCheckpointHash: null,
      signatures: [{ publicKey: '04'.repeat(65), alg: 'ES256K-DER-SHA256', signature: 'sig' }],
      anchors: [],
    });

    await startTransparencyCheckpointJobs();
    await flush();

    expect(mockBuildCheckpoint).not.toHaveBeenCalled();
  });

  it('logs an error when signing is missing and the log is empty', async () => {
    await startTransparencyCheckpointJobs();
    await flush();

    expect(mockBuildCheckpoint).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('OXY_PRIVATE_KEY is not configured'),
      expect.objectContaining({ component: 'transparencyCheckpoint' }),
    );
  });

  it('warns when signing is missing but historical checkpoints exist', async () => {
    mockGetLatestCheckpoint.mockResolvedValue({
      index: 2,
      periodEnd: 1_800_000_000_000,
      treeSize: 1,
      root: 'b'.repeat(64),
      prevCheckpointHash: 'a'.repeat(64),
      signatures: [{ publicKey: '04'.repeat(65), alg: 'ES256K-DER-SHA256', signature: 'sig' }],
      anchors: [],
    });

    await startTransparencyCheckpointJobs();
    await flush();

    expect(mockBuildCheckpoint).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('cannot publish new checkpoints'),
      expect.objectContaining({ component: 'transparencyCheckpoint', latestIndex: 2 }),
    );
  });
});
