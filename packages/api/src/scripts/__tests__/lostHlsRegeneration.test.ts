/**
 * Re-encoding videos whose HLS playlists were lost, against a REAL Postgres
 * for the scan and a fake S3 for the objects.
 *
 * The case is the one the segment-key repair measured in production on
 * 2026-10-10: `file_variants` names a `.m3u8` that storage no longer has, so
 * there is nothing to copy back — the ladder has to be encoded again.
 */

import { createHash, randomBytes } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import type { S3Service } from '../../services/s3Service';
import { regenerateLostHls } from '../lostHlsRegeneration';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

const sha = () => createHash('sha256').update(randomBytes(16)).digest('hex');

/** A video row with one ready HLS master playlist. */
async function insertVideo(
  sha256: string,
  options: { visibility?: 'public' | 'private'; status?: 'active' | 'deleted' } = {},
) {
  const visibility = options.visibility ?? 'public';
  const prefix = visibility === 'public' ? 'public/' : '';
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [file] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 4,
      mime: 'video/mp4',
      ext: 'mp4',
      ownerUserId: owner.id,
      visibility,
      status: options.status ?? 'active',
      storageKey: `${prefix}content/2026/07/${sha256.slice(0, 2)}/${sha256}.mp4`,
    })
    .returning();
  const playlist = `${prefix}variants/2026/07/${sha256.slice(0, 2)}/${sha256}/hls_master.m3u8`;
  await getDb()
    .insert(fileVariants)
    .values({ fileId: file.id, type: 'hls_master', key: playlist, readyAt: new Date() });
  return { id: file.id, original: file.storageKey, playlist };
}

/** Only these objects exist in storage. */
function fakeS3(existing: string[]) {
  const objects = new Set(existing);
  return {
    fileExists: jest.fn((key: string) => Promise.resolve(objects.has(key))),
  } as unknown as S3Service;
}

/** The ids this test seeded that `regenerate` was called with — the table is shared with other suites. */
function calledWith(regenerate: jest.Mock, ids: string[]): string[] {
  return regenerate.mock.calls
    .map(([id]) => id as string)
    .filter((id) => ids.includes(id))
    .sort();
}

describe('regenerateLostHls', () => {
  it('encodes once per content and spelling, from the original, and never a healthy, deleted or originless video', async () => {
    const shared = sha();
    const first = await insertVideo(shared);
    const twin = await insertVideo(shared);
    const privateTwin = await insertVideo(shared, { visibility: 'private' });
    const healthy = await insertVideo(sha());
    const deleted = await insertVideo(sha(), { status: 'deleted' });
    const originless = await insertVideo(sha());

    const s3 = fakeS3([
      first.original,
      privateTwin.original,
      healthy.original,
      healthy.playlist,
      deleted.original,
    ]);
    const regenerate = jest.fn(() => Promise.resolve());

    await regenerateLostHls({ s3, regenerate });

    const seeded = [first, twin, privateTwin, healthy, deleted, originless].map((v) => v.id);
    // The public pair is one group (one encode, which generateVariants shares
    // with the other); the private twin needs its own spelling, so its own.
    const called = calledWith(regenerate, seeded);
    expect(called).toHaveLength(2);
    expect(called).toContain(privateTwin.id);
    expect([first.id, twin.id].filter((id) => called.includes(id))).toHaveLength(1);
    expect(s3.fileExists).toHaveBeenCalledWith(originless.original);
    expect(s3.fileExists).not.toHaveBeenCalledWith(deleted.playlist);
  });

  it('encodes nothing on a dry run', async () => {
    const video = await insertVideo(sha());
    const regenerate = jest.fn(() => Promise.resolve());

    const result = await regenerateLostHls({
      s3: fakeS3([video.original]),
      regenerate,
      dryRun: true,
    });

    expect(regenerate).not.toHaveBeenCalled();
    expect(result.regenerated).toBeGreaterThanOrEqual(1);
  });

  it('counts a failed encode and carries on with the next', async () => {
    const broken = await insertVideo(sha());
    const next = await insertVideo(sha());
    const regenerate = jest.fn((id: string) =>
      id === broken.id ? Promise.reject(new Error('ffmpeg exited 1')) : Promise.resolve(),
    );

    const result = await regenerateLostHls({
      s3: fakeS3([broken.original, next.original]),
      regenerate,
    });

    expect(calledWith(regenerate, [broken.id, next.id])).toEqual([broken.id, next.id].sort());
    expect(result.failed).toBeGreaterThanOrEqual(1);
  });
});
