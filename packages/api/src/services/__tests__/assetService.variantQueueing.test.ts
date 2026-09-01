/**
 * The upload path must HAND OFF variant generation, not perform it.
 *
 * `AssetService.queueVariantGeneration` was a method named `queue…` that awaited
 * `variantService.generateVariants` inline. Its eight call sites never awaited
 * it, so the HTTP response was not blocked — what was unbounded was how many
 * sharp/ffmpeg runs could be in flight in this process at once. On a 512 CPU /
 * 1024 MiB Fargate task that pinned CPU at 100%, and the JS thread lost the CPU
 * for long enough to miss the ELB's 5 s `/health` probe three times running, so
 * the load balancer killed the task mid-upload.
 *
 * These run against the REAL queue module (its no-Redis fallback), not a stub of
 * it, so what is asserted is the actual end-to-end property: generation is
 * SCHEDULED during the request and RUNS after it. Only S3 and the variant
 * pipeline are faked; the rows are real.
 *
 * Mutation-tested. Restoring the inline `void this.variantService
 * .generateVariants(file.id)` fails "does not run variant generation during the
 * request" by name ("Received number of calls: 1"); making the call site await
 * the handoff as well times out "resolves without waiting for generation to
 * finish" at 10 s, which is the request-path-blocked signature itself.
 */

import { randomBytes } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema';
import type { S3Service } from '../s3Service';
import { AssetService } from '../assetService';
import fileCache from '../../utils/fileCache';

/**
 * The one variant pipeline in play. `AssetService` builds a `VariantService` and
 * so does the queue module, and both resolve to THIS class — so a single spy
 * distinguishes "ran during the request" from "ran on the background drain" by
 * WHEN it was called, with no ambiguity about which instance did the work.
 */
const mockGenerateVariants = jest.fn(() => Promise.resolve());

jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) {
      /* no-op */
    }
    generateVariants = (...args: unknown[]) => mockGenerateVariants(...args);
  },
}));

// The queue module builds its pipeline over the shared storage client at import
// time; nothing in these tests should reach real S3.
jest.mock('../s3ServiceSingleton', () => ({ s3Service: {} }));

import { startAssetVariantJobs, stopAssetVariantJobs } from '../../queue/assetVariants.queue';

/** A real PNG magic prefix + random suffix, so the content guard accepts it and
 *  no two cases collide on the table-wide live-sha256 constraint. */
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(16),
  ]);

function buildAssetService(): AssetService {
  const fakeS3 = {
    fileExists: jest.fn(() => Promise.resolve(true)),
    uploadBuffer: jest.fn(() => Promise.resolve()),
    getPresignedUploadUrl: jest.fn(() => Promise.resolve('https://s3.invalid/put')),
  };
  return new AssetService(fakeS3 as unknown as S3Service);
}

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

/** Let the fallback's `setImmediate` drain kick and settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  mockGenerateVariants.mockClear();
  mockGenerateVariants.mockImplementation(() => Promise.resolve());
  await startAssetVariantJobs();
});

afterEach(async () => {
  await stopAssetVariantJobs();
  fileCache.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('uploadFileDirect hands variant generation off', () => {
  it('does not run variant generation during the request', async () => {
    const userId = await insertUser();
    const service = buildAssetService();

    const file = await service.uploadFileDirect(userId, png(), 'image/png', 'shot.png');

    // The request itself must have transcoded nothing. This is the assertion the
    // inline call fails: with it restored, generation runs before
    // uploadFileDirect returns.
    expect(mockGenerateVariants).not.toHaveBeenCalled();

    // ...but the work was scheduled, and runs once the request is off the stack.
    await settle();
    await settle();
    expect(mockGenerateVariants).toHaveBeenCalledWith(file.id);
  });

  it('resolves without waiting for generation to finish', async () => {
    const userId = await insertUser();
    const service = buildAssetService();

    // Generation that never settles: if the upload path awaited it — inline, or
    // by awaiting the handoff — this test times out instead of returning a file.
    let started = false;
    mockGenerateVariants.mockImplementation(() => {
      started = true;
      return new Promise<void>(() => {
        /* never resolves */
      });
    });

    const file = await service.uploadFileDirect(userId, png(), 'image/png', 'clip.png');

    expect(file.id).toBeTruthy();
    expect(started).toBe(false); // not even begun when the response is ready

    await settle();
    await settle();
    expect(started).toBe(true); // it is the background drain that runs it
  });

  it('schedules generation once per uploaded file', async () => {
    const userId = await insertUser();
    const service = buildAssetService();

    const first = await service.uploadFileDirect(userId, png(), 'image/png', 'a.png');
    const second = await service.uploadFileDirect(userId, png(), 'image/png', 'b.png');
    await settle();
    await settle();
    await settle();

    expect(mockGenerateVariants.mock.calls.map((call) => call[0]).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});
