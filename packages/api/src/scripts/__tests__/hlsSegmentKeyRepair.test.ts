/**
 * The stored-segment repair, against a REAL Postgres for the variant scan and a
 * fake S3 for the objects.
 *
 * The case is the one measured in production on 2026-10-10: a ladder generated
 * with legacy segment names (`hls_360p_segment_360p_000.ts.ts`) and then made
 * public before relocation copied segments, so the playlist sits under
 * `public/` and its segments only under the private spelling, legacy-named.
 */

import { createHash, randomBytes } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import type { S3Service } from '../../services/s3Service';
import { repairHlsSegmentKeys } from '../hlsSegmentKeyRepair';

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

/** A public ladder whose two segments exist only under their legacy private names. */
async function seedLegacyLadder() {
  const sha256 = createHash('sha256').update(randomBytes(16)).digest('hex');
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [file] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 4,
      mime: 'video/mp4',
      ext: 'mp4',
      ownerUserId: owner.id,
      visibility: 'public',
      status: 'active',
      storageKey: `public/content/2026/10/16/${sha256}.mp4`,
    })
    .returning();
  const dir = `variants/2026/10/16/${sha256}`;
  await getDb()
    .insert(fileVariants)
    .values({
      fileId: file.id,
      type: 'hls_360p',
      key: `public/${dir}/hls_360p.m3u8`,
      readyAt: new Date(),
    });

  const objects = new Map<string, string>([
    [
      `public/${dir}/hls_360p.m3u8`,
      '#EXTM3U\n#EXTINF:10,\nsegment_360p_000.ts\n#EXTINF:4,\nsegment_360p_001.ts\n#EXT-X-ENDLIST\n',
    ],
    [`${dir}/hls_360p_segment_360p_000.ts.ts`, 'seg0'],
    [`${dir}/hls_360p_segment_360p_001.ts.ts`, 'seg1'],
  ]);
  const s3 = {
    downloadBuffer: jest.fn((key: string) =>
      objects.has(key)
        ? Promise.resolve(Buffer.from(objects.get(key)!))
        : Promise.reject(new Error(`no object ${key}`)),
    ),
    fileExists: jest.fn((key: string) => Promise.resolve(objects.has(key))),
    copyFile: jest.fn((from: string, to: string) => {
      objects.set(to, objects.get(from)!);
      return Promise.resolve();
    }),
  };
  return { dir, objects, s3: s3 as typeof s3 & S3Service };
}

describe('repairHlsSegmentKeys', () => {
  it('puts every segment where its playlist points, from the legacy name in the other spelling', async () => {
    const { dir, objects, s3 } = await seedLegacyLadder();

    await repairHlsSegmentKeys({ s3 });

    expect(objects.get(`public/${dir}/segment_360p_000.ts`)).toBe('seg0');
    expect(objects.get(`public/${dir}/segment_360p_001.ts`)).toBe('seg1');
    // Copied, never moved: the legacy keys may back another owner's row.
    expect(objects.has(`${dir}/hls_360p_segment_360p_000.ts.ts`)).toBe(true);
  });

  it('is idempotent: a second pass copies nothing for a repaired ladder', async () => {
    const { dir, s3 } = await seedLegacyLadder();
    await repairHlsSegmentKeys({ s3 });
    s3.copyFile.mockClear();

    await repairHlsSegmentKeys({ s3 });

    expect(s3.copyFile).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining(dir));
  });

  it('writes nothing on a dry run', async () => {
    const { dir, objects, s3 } = await seedLegacyLadder();

    await repairHlsSegmentKeys({ s3, dryRun: true });

    expect(s3.copyFile).not.toHaveBeenCalled();
    expect(objects.has(`public/${dir}/segment_360p_000.ts`)).toBe(false);
  });
});
