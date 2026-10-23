import { randomBytes } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema';
import {
  findFileById,
  insertFile,
  rememberVideoStorageRoot,
  upsertVariant,
  upsertVariantSet,
} from '../fileRepository';
import { VariantService } from '../variantService';
import fileCache from '../../utils/fileCache';
import { VIDEO_RENDITION_PROFILE, hasCurrentVideoRenditions } from '../video-renditions';
import { repairVideoRenditions } from '../../scripts/video-rendition-repair';
import type { S3Service } from '../s3Service';
import type { NewFileVariant, FileVisibility } from '../../types/file.types';

const mockPurge = jest.fn();
jest.mock('../cdnInvalidation', () => ({
  getCdnInvalidationQueue: () => ({ enqueuePath: (...args: unknown[]) => mockPurge(...args) }),
}));

interface EncodingHarness {
  extractVideoMetadataFromUrl(): Promise<{ width: number; height: number; duration: number }>;
  generatePosterFrame(): Promise<NewFileVariant>;
  generateVideoRenditions(): Promise<NewFileVariant[]>;
}

const sha = () => randomBytes(32).toString('hex');
async function file(hash = sha(), visibility: FileVisibility = 'private') {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return insertFile({
    sha256: hash,
    mime: 'video/mp4',
    ext: 'mp4',
    size: 10,
    status: 'active',
    visibility,
    storageKey: `${visibility === 'public' ? 'public/' : ''}content/${hash}`,
    ownerUserId: owner.id,
  });
}
function currentMaster(): NewFileVariant {
  return {
    type: 'hls_master',
    key: `variants/${VIDEO_RENDITION_PROFILE}/${sha()}/hls_master.m3u8`,
    readyAt: new Date(),
    metadata: { encodingProfile: VIDEO_RENDITION_PROFILE },
  };
}
function encoder() {
  const s3 = {
    getPresignedDownloadUrl: jest.fn(async () => 'https://example.com/video.mp4'),
    fileExists: jest.fn(async () => true),
  } as unknown as S3Service;
  const service = new VariantService(s3);
  const harness = service as unknown as EncodingHarness;
  jest
    .spyOn(harness, 'extractVideoMetadataFromUrl')
    .mockResolvedValue({ width: 180, height: 320, duration: 3 });
  jest
    .spyOn(harness, 'generatePosterFrame')
    .mockResolvedValue({ type: 'poster', key: 'new/poster.jpg', readyAt: new Date() });
  const renditions = jest
    .spyOn(harness, 'generateVideoRenditions')
    .mockResolvedValue([
      { type: '360p', key: 'new/360p.mp4', readyAt: new Date() },
      { type: 'hls_360p', key: 'new/hls_360p.m3u8', readyAt: new Date() },
      currentMaster(),
    ]);
  return { service, renditions, s3 };
}

beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(() => mockPurge.mockClear());

it('keeps the original, complete old ladder and metadata when a replacement fails', async () => {
  const original = await file();
  await upsertVariantSet(
    original.id,
    [
      { type: 'hls_master', key: 'old/master.m3u8', readyAt: new Date() },
      { type: 'hls_720p', key: 'old/720p.m3u8', readyAt: new Date() },
    ],
    { metadata: { media: { width: 180, height: 320 } } },
  );
  const before = await findFileById(original.id);
  const { service, renditions } = encoder();
  renditions.mockRejectedValue(new Error('segment upload failed'));
  await expect(service.generateVariants(original.id, { reencode: true })).rejects.toThrow(
    'segment upload failed',
  );
  const after = await findFileById(original.id);
  expect(after?.variants).toEqual(before?.variants);
  expect(after?.metadata?.media).toEqual(before?.metadata?.media);
  expect(after?.storageKey).toBe(original.storageKey);
  expect(mockPurge).not.toHaveBeenCalled();
});

it('atomically removes obsolete video tiers, retains lazy images, updates public twins and purges their resolvers', async () => {
  const original = await file(undefined, 'public');
  const twin = await file(original.sha256, 'public');
  const privateTwin = await file(original.sha256, 'private');
  for (const record of [original, twin, privateTwin]) {
    await upsertVariantSet(record.id, [
      { type: 'hls_master', key: 'old/master.m3u8', readyAt: new Date() },
      { type: 'hls_source', key: 'old/source.m3u8', readyAt: new Date() },
      { type: '1080p', key: 'old/1080p.mp4', readyAt: new Date() },
      { type: 'w320', key: 'existing/w320.webp', readyAt: new Date() },
    ]);
  }
  const { service } = encoder();
  await service.generateVariants(original.id, { reencode: true });
  for (const id of [original.id, twin.id]) {
    const updated = await findFileById(id);
    expect(updated?.variants.map((variant) => variant.type).sort()).toEqual([
      '360p',
      'hls_360p',
      'hls_master',
      'poster',
      'w320',
    ]);
    expect(updated && hasCurrentVideoRenditions(updated)).toBe(true);
    expect(updated?.storageKey).toBe(original.storageKey);
    expect(mockPurge).toHaveBeenCalledWith(`/${id}`);
  }
  expect(
    (await findFileById(privateTwin.id))?.variants.find((variant) => variant.type === 'hls_master')
      ?.key,
  ).toBe('old/master.m3u8');
  expect(mockPurge).not.toHaveBeenCalledWith(`/${privateTwin.id}`);
});

it('never reuses a legacy twin ladder for a new upload', async () => {
  const old = await file();
  await upsertVariant(old.id, {
    type: 'hls_master',
    key: 'legacy/master.m3u8',
    readyAt: new Date(),
  });
  const fresh = await file(old.sha256);
  const { service, renditions } = encoder();
  await service.generateVariants(fresh.id);
  expect(renditions).toHaveBeenCalled();
  expect(
    (await findFileById(fresh.id))?.variants.find((variant) => variant.type === 'hls_master')
      ?.metadata?.encodingProfile,
  ).toBe(VIDEO_RENDITION_PROFILE);
});

it('defaults repairs to dry run, resumes by skipping current files, and reports missing originals', async () => {
  const original = await file();
  const s3 = { fileExists: jest.fn(async () => true) } as unknown as S3Service;
  const regenerate = jest.fn(async (id: string) => {
    await upsertVariant(id, currentMaster());
  });
  expect(await repairVideoRenditions({ fileId: original.id, s3, regenerate })).toMatchObject({
    wouldRegenerate: 1,
    regenerated: 0,
  });
  expect(regenerate).not.toHaveBeenCalled();
  expect(
    await repairVideoRenditions({ fileId: original.id, s3, regenerate, dryRun: false }),
  ).toMatchObject({ regenerated: 1 });
  expect(
    await repairVideoRenditions({ fileId: original.id, s3, regenerate, dryRun: false }),
  ).toMatchObject({ candidates: 0 });
  expect(regenerate).toHaveBeenCalledTimes(1);
  const missing = await file();
  jest.mocked(s3.fileExists).mockResolvedValue(false);
  expect(
    await repairVideoRenditions({ fileId: missing.id, s3, regenerate, dryRun: false }),
  ).toMatchObject({ unrecoverable: 1, regenerated: 0 });
});

it('reports failed repairs without claiming that they completed', async () => {
  const original = await file();
  const { s3 } = encoder();
  const regenerate = jest.fn(async () => {
    throw new Error('encode failed');
  });
  expect(
    await repairVideoRenditions({ fileId: original.id, s3, regenerate, dryRun: false }),
  ).toMatchObject({ failed: 1, regenerated: 0 });
  expect(await repairVideoRenditions({ fileId: original.id, s3, regenerate })).toMatchObject({
    candidates: 1,
  });
  await expect(repairVideoRenditions({ limit: 0 })).rejects.toThrow('limit');
  await expect(repairVideoRenditions({ limit: 1001 })).rejects.toThrow('limit');
});

it('resumes beyond a failed content group without starving later repairs', async () => {
  const first = await file(`${'0'.repeat(63)}1`);
  const next = await file(`${'0'.repeat(63)}2`);
  const { s3 } = encoder();
  const failed = await repairVideoRenditions({
    fileId: first.id,
    s3,
    limit: 1,
    dryRun: false,
    regenerate: async () => {
      throw new Error('failed first group');
    },
  });
  expect(failed.nextCursor).toBe(`${first.sha256}:private`);
  const regenerate = jest.fn(async (id: string) => {
    await upsertVariant(id, currentMaster());
  });
  const resumed = await repairVideoRenditions({
    s3,
    regenerate,
    limit: 1,
    dryRun: false,
    after: failed.nextCursor,
  });
  expect(resumed.regenerated).toBe(1);
  expect(regenerate).toHaveBeenCalledWith(next.id);
  await expect(repairVideoRenditions({ after: 'malformed' })).rejects.toThrow('cursor');
});

it('records historical roots across twin copying and visibility/deletion targets', async () => {
  const { storageTargetsForAsset, recordFileStorageRelocation } = await import(
    '../accountStorageDeletion.service'
  );
  const { storageSpellingsInUse } = await import('../accountStorageDeletion.worker');
  const original = await file(undefined, 'public');
  const twin = await file(original.sha256, 'public');
  const root = `variants/2026/09/${original.sha256.slice(0, 2)}/${original.sha256}/`;
  const olderRoot = `variants/2026/08/${original.sha256.slice(0, 2)}/${original.sha256}/`;
  await upsertVariantSet(original.id, [
    { type: 'hls_master', key: `public/${root}old/hls_master.m3u8`, readyAt: new Date() },
  ]);
  await upsertVariantSet(twin.id, [
    { type: 'hls_master', key: `public/${olderRoot}old/hls_master.m3u8`, readyAt: new Date() },
  ]);
  const { service } = encoder();
  await service.generateVariants(original.id, { reencode: true });
  const repairedTwin = await findFileById(twin.id);
  if (!repairedTwin) throw new Error('Missing repaired twin');
  const targets = storageTargetsForAsset(
    repairedTwin,
    repairedTwin.variants.map((variant) => variant.key),
  );
  expect(
    targets
      .filter((target) => target.kind === 'prefix')
      .map((target) => target.target)
      .sort(),
  ).toEqual([olderRoot, root]);
  const ledger = await getDb().transaction((tx) =>
    recordFileStorageRelocation(
      tx,
      repairedTwin,
      repairedTwin.variants.map((variant) => variant.key),
    ),
  );
  expect(ledger.length).toBeGreaterThan(repairedTwin.variants.length);
  const target = { kind: 'prefix' as const, target: root, sha256: original.sha256 };
  expect(await storageSpellingsInUse(target)).toMatchObject({ public: true });
  // The same roots become inaccessible publicly after the final public owner moves.
  const { updateFile } = await import('../fileRepository');
  for (const record of [original, twin]) {
    await updateFile(record.id, {
      visibility: 'private',
      storageKey: record.storageKey.replace(/^public\//, ''),
    });
    await upsertVariantSet(
      record.id,
      [{ ...currentMaster(), key: `${root}${VIDEO_RENDITION_PROFILE}/current/hls_master.m3u8` }],
      undefined,
      { replaceVideoSet: true },
    );
  }
  expect(await storageSpellingsInUse(target)).toEqual({ public: false, base: true });
});

it('records first-generation ownership before encoding so failed new uploads can be purged', async () => {
  const original = await file(undefined, 'public');
  const { service, renditions } = encoder();
  renditions.mockRejectedValue(new Error('first HLS upload failed'));
  await expect(service.generateVariants(original.id)).rejects.toThrow('first HLS upload failed');
  const failed = await findFileById(original.id);
  if (!failed) throw new Error('File disappeared');
  expect(failed.variants).toEqual([]);
  expect(failed.storageKey).toBe(original.storageKey);
  const { storageTargetsForAsset } = await import('../accountStorageDeletion.service');
  expect(
    storageTargetsForAsset(failed, []).some(
      (target) => target.kind === 'prefix' && target.target.includes(original.sha256),
    ),
  ).toBe(true);
});

it('invalidates cached records after recording a storage root, including repeat calls', async () => {
  const original = await file();
  const root = `variants/2026/10/${original.sha256.slice(0, 2)}/${original.sha256}/`;
  const invalidate = jest.spyOn(fileCache, 'invalidate');
  try {
    fileCache.set(original.id, original);
    await rememberVideoStorageRoot(original.id, root);
    expect(invalidate).toHaveBeenCalledWith(original.id);
    expect(fileCache.get(original.id)).toBeNull();
    const saved = await findFileById(original.id);
    expect(saved?.metadata?.video?.storageRoots).toEqual([root]);

    // An idempotent call must still evict a stale copy from this or another task.
    invalidate.mockClear();
    fileCache.set(original.id, original);
    await rememberVideoStorageRoot(original.id, root);
    expect(invalidate).toHaveBeenCalledWith(original.id);
    expect(fileCache.get(original.id)).toBeNull();
    expect((await findFileById(original.id))?.metadata?.video?.storageRoots).toEqual([root]);
  } finally {
    invalidate.mockRestore();
  }
});

it('skips a completed video encode and upgrades only outdated twins in the same spelling', async () => {
  const source = await file();
  const staleTwin = await file(source.sha256);
  const currentTwin = await file(source.sha256);
  const publicTwin = await file(source.sha256, 'public');
  await upsertVariantSet(source.id, [currentMaster()]);
  await upsertVariantSet(staleTwin.id, [{ type: 'hls_master', key: 'legacy/master.m3u8' }]);
  await upsertVariantSet(currentTwin.id, [currentMaster()]);
  await upsertVariantSet(publicTwin.id, [{ type: 'hls_master', key: 'public/legacy/master.m3u8' }]);
  const beforeSource = await findFileById(source.id);
  const beforeCurrent = await findFileById(currentTwin.id);
  const beforePublic = await findFileById(publicTwin.id);
  const { service, renditions } = encoder();
  await service.generateVariants(source.id);
  expect(renditions).not.toHaveBeenCalled();
  expect((await findFileById(source.id))?.variants).toEqual(beforeSource?.variants);
  expect(hasCurrentVideoRenditions((await findFileById(staleTwin.id)) ?? { variants: [] })).toBe(
    true,
  );
  expect((await findFileById(currentTwin.id))?.variants).toEqual(beforeCurrent?.variants);
  expect((await findFileById(publicTwin.id))?.variants).toEqual(beforePublic?.variants);
});

it('upgrades legacy twins after a normal queued video job and makes its replay a no-op', async () => {
  const source = await file();
  const twin = await file(source.sha256);
  for (const row of [source, twin])
    await upsertVariantSet(row.id, [{ type: 'hls_master', key: 'legacy/master.m3u8' }]);
  const { service, renditions } = encoder();
  await service.generateVariants(source.id);
  expect(renditions).toHaveBeenCalledTimes(1);
  expect(hasCurrentVideoRenditions((await findFileById(twin.id)) ?? { variants: [] })).toBe(true);
  await service.generateVariants(source.id);
  await service.generateVariants(twin.id);
  expect(renditions).toHaveBeenCalledTimes(1);
});

it('honors an explicit re-encode even when the video profile is already current', async () => {
  const source = await file();
  await upsertVariantSet(source.id, [currentMaster()]);
  const { service, renditions } = encoder();
  await service.generateVariants(source.id, { reencode: true });
  expect(renditions).toHaveBeenCalledTimes(1);
});

it('does not render a video that left the active state while its request waited', async () => {
  const source = await file();
  const { updateFile } = await import('../fileRepository');
  await updateFile(source.id, { status: 'trash' });
  const { service, renditions } = encoder();
  await service.generateVariants(source.id);
  expect(renditions).not.toHaveBeenCalled();
});

it('finds a complete current twin beyond older legacy owners without re-encoding', async () => {
  const target = await file();
  for (let i = 0; i < 6; i++) {
    const legacy = await file(target.sha256);
    await upsertVariantSet(legacy.id, [{ type: 'hls_master', key: 'legacy/master.m3u8' }]);
  }
  const current = await file(target.sha256);
  await upsertVariantSet(current.id, [currentMaster()]);
  const { service, renditions } = encoder();
  await service.generateVariants(target.id);
  expect(renditions).not.toHaveBeenCalled();
  expect(hasCurrentVideoRenditions((await findFileById(target.id)) ?? { variants: [] })).toBe(true);
});
