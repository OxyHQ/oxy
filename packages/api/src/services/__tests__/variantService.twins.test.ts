/**
 * Renditions shared between owners' rows for the same bytes, against a REAL
 * Postgres.
 *
 * Rows are per owner and share content-addressed storage, so a second owner's
 * row should reuse the renditions another live row already has instead of
 * encoding the same bytes again — but only:
 *
 *  - from a LIVE row: a tombstone's renditions are owed a purge;
 *  - in the key spelling this row's visibility needs: a private row pointed at
 *    `public/` renditions would keep them on the CDN after every public owner
 *    deleted theirs;
 *  - with INTRINSIC metadata only: the source is another owner's row, and its
 *    application metadata (`source`, `serviceAppId`) is what the federated
 *    delete route authorizes by.
 *
 * Generation itself never runs here: the fixtures' mime has no renderer, so a
 * row that finds no usable twin simply ends with no renditions.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { fileVariants, files, users } from '../../db/schema';
import { VariantService } from '../variantService';
import { findFileById } from '../fileRepository';
import type { S3Service } from '../s3Service';
import type { FileRecord, FileVisibility } from '../../types/file.types';

const s3 = {
  downloadBuffer: jest.fn(() => Promise.reject(new Error('generation must not run'))),
  fileExists: jest.fn(() => Promise.resolve(true)),
} as unknown as S3Service;

const sha = () => randomBytes(32).toString('hex');

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function insertRow(
  sha256: string,
  options: {
    visibility?: FileVisibility;
    status?: 'active' | 'trash' | 'deleted';
    variantKeys?: string[];
    metadata?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const visibility = options.visibility ?? 'public';
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256,
      size: 10,
      // No renderer for this mime: a row with no usable twin generates nothing.
      mime: 'application/octet-stream',
      ext: '',
      storageKey: `${visibility === 'public' ? 'public/' : ''}content/2026/09/${sha256.slice(0, 2)}/${sha256}`,
      ownerUserId: await insertUser(),
      visibility,
      status: options.status ?? 'active',
      metadata: options.metadata ?? {},
    })
    .returning({ id: files.id });
  for (const key of options.variantKeys ?? []) {
    await getDb().insert(fileVariants).values({ fileId: row.id, type: key.split('/').pop() ?? 'thumb', key, readyAt: new Date() });
  }
  return row.id;
}

const variantDir = (sha256: string, spelling: 'public' | 'bare') =>
  `${spelling === 'public' ? 'public/' : ''}variants/2026/09/${sha256.slice(0, 2)}/${sha256}/`;

async function variantKeysOf(fileId: string): Promise<string[]> {
  const rows = await getDb().select({ key: fileVariants.key }).from(fileVariants).where(eq(fileVariants.fileId, fileId));
  return rows.map((row) => row.key).sort();
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('generateVariants reuses a twin\'s renditions', () => {
  it('copies a live same-spelling twin\'s set onto the new row: same objects, nothing encoded', async () => {
    const sha256 = sha();
    const keys = [`${variantDir(sha256, 'public')}thumb.webp`, `${variantDir(sha256, 'public')}w320.webp`];
    await insertRow(sha256, { variantKeys: keys, metadata: { media: { width: 10, height: 20 } } });
    const mine = await insertRow(sha256);

    await new VariantService(s3).generateVariants(mine);

    expect(await variantKeysOf(mine)).toEqual([...keys].sort());
    expect((await findFileById(mine))?.metadata).toMatchObject({ media: { width: 10, height: 20 } });
  });

  it('never copies from a TOMBSTONED twin', async () => {
    const sha256 = sha();
    await insertRow(sha256, { status: 'deleted', variantKeys: [`${variantDir(sha256, 'public')}thumb.webp`] });
    const mine = await insertRow(sha256);

    await new VariantService(s3).generateVariants(mine);

    expect(await variantKeysOf(mine)).toEqual([]);
  });

  it('never gives a PRIVATE row a public twin\'s `public/` renditions', async () => {
    const sha256 = sha();
    await insertRow(sha256, { visibility: 'public', variantKeys: [`${variantDir(sha256, 'public')}thumb.webp`] });
    const mine = await insertRow(sha256, { visibility: 'private' });

    await new VariantService(s3).generateVariants(mine);

    expect(await variantKeysOf(mine)).toEqual([]);
  });

  it('carries INTRINSIC metadata only — never the twin\'s application or authorization metadata', async () => {
    const sha256 = sha();
    await insertRow(sha256, {
      variantKeys: [`${variantDir(sha256, 'public')}thumb.webp`],
      metadata: {
        media: { width: 1, height: 2 },
        image: { width: 1, height: 2 },
        source: 'federation',
        serviceAppId: 'app-other',
      },
    });
    const mine = await insertRow(sha256, { metadata: { source: 'federation', serviceAppId: 'app-mine' } });

    await new VariantService(s3).generateVariants(mine);

    expect((await findFileById(mine))?.metadata).toEqual({
      source: 'federation',
      serviceAppId: 'app-mine',
      media: { width: 1, height: 2 },
      image: { width: 1, height: 2 },
    });
  });
});

describe('a re-encode never reuses a twin\'s renditions', () => {
  it('encodes from the original even when a live same-spelling twin has a set', async () => {
    const sha256 = sha();
    await insertRow(sha256, { variantKeys: [`${variantDir(sha256, 'public')}thumb.webp`] });
    const mine = await insertRow(sha256);

    await new VariantService(s3).generateVariants(mine, { reencode: true });

    // Nothing copied: the twin names the same content-addressed objects, so its
    // set is lost exactly when this row's is. (No renderer for the fixture mime.)
    expect(await variantKeysOf(mine)).toEqual([]);
  });
});

describe('a finished generation is shared with twins still waiting', () => {
  it('hands its set to live same-spelling rows with none — and to nobody else', async () => {
    const sha256 = sha();
    const keys = [`${variantDir(sha256, 'public')}thumb.webp`];
    const generated = await insertRow(sha256, { variantKeys: keys });
    const waiting = await insertRow(sha256);
    const privateTwin = await insertRow(sha256, { visibility: 'private' });
    const tombstone = await insertRow(sha256, { status: 'deleted' });

    const service = new VariantService(s3);
    const share: unknown = Reflect.get(service, 'shareVariantsWithTwins');
    if (typeof share !== 'function') throw new Error('shareVariantsWithTwins is gone');
    const record = await findFileById(generated);
    await (share as Share).call(service, record, { variantless: true });

    expect(await variantKeysOf(waiting)).toEqual(keys);
    expect(await variantKeysOf(privateTwin)).toEqual([]);
    expect(await variantKeysOf(tombstone)).toEqual([]);
  });

  it('after a re-encode, replaces the set of every live same-spelling twin — and of nobody else', async () => {
    const sha256 = sha();
    const fresh = [`${variantDir(sha256, 'public')}thumb.webp`];
    const lost = [`public/variants/2026/07/${sha256.slice(0, 2)}/${sha256}/thumb.webp`];
    const generated = await insertRow(sha256, { variantKeys: fresh });
    const brokenTwin = await insertRow(sha256, { variantKeys: lost });
    const privateTwin = await insertRow(sha256, { visibility: 'private', variantKeys: [`${variantDir(sha256, 'bare')}thumb`] });
    const tombstone = await insertRow(sha256, { status: 'deleted', variantKeys: lost });

    const service = new VariantService(s3);
    const share: unknown = Reflect.get(service, 'shareVariantsWithTwins');
    if (typeof share !== 'function') throw new Error('shareVariantsWithTwins is gone');
    const record = await findFileById(generated);
    await (share as Share).call(service, record, { variantless: false });

    expect(await variantKeysOf(brokenTwin)).toEqual(fresh);
    expect(await variantKeysOf(privateTwin)).toEqual([`${variantDir(sha256, 'bare')}thumb`]);
    expect(await variantKeysOf(tombstone)).toEqual(lost);
  });
});

type Share = (file: FileRecord | null, twins: { variantless: boolean }) => Promise<void>;
