/**
 * A file whose bytes are gone for good becomes `lost` (ADR 0043 D13), against a
 * REAL Postgres and an in-memory bucket behind the real `S3Service`:
 *
 *  1. Only when the object is absent in EVERY spelling: a row whose bytes sit
 *     at the other spelling (bare vs `public/`) is `present` and unchanged.
 *  2. The row is kept — name, metadata, references — and moves to `lost`, out
 *     of trash too; `file.lost` reaches every application using it, carrying
 *     status `lost`.
 *  3. A lost file is not served, is listed in its owner's library, holds no
 *     claim on its content hash (a new upload of the bytes is a new file), and
 *     its owner deletes it with a plain delete.
 *  4. A federation cache entry is refused (its using service evicts it), and a
 *     row that is not live is `not_live`.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';

jest.mock('../variantService', () => ({
  VariantService: class {
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));
jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { isServableStatus } from '../../config/cdn';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, fileEventDeliveries, files, users } from '../../db/schema';
import { AssetService } from '../assetService';
import { sealFileWebhookSecret } from '../fileEvents.service';
import {
  addFileReferences,
  findLiveFileBySha256ForOwner,
  listFilesByOwner,
} from '../fileRepository';
import { S3Service } from '../s3Service';

jest.setTimeout(60_000);

class MemoryBucket {
  readonly objects = new Map<string, Buffer>();
  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const key = String(command.input.Key ?? '');
    switch (command.constructor.name) {
      case 'HeadObjectCommand':
        if (!this.objects.has(key))
          throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return { ContentLength: this.objects.get(key)?.length };
      case 'DeleteObjectCommand':
        this.objects.delete(key);
        return {};
      case 'ListObjectsV2Command':
        return { Contents: [] };
      default:
        throw new Error(`MemoryBucket: unexpected ${command.constructor.name}`);
    }
  }
}

function harness() {
  const bucket = new MemoryBucket();
  const purged: string[] = [];
  const s3 = new S3Service(
    { accessKeyId: 'test', secretAccessKey: 'test', bucketName: 'media', region: 'us-east-1' },
    { enqueueDeletedKey: (key: string) => purged.push(key) },
  );
  const client: unknown = Reflect.get(s3, 's3Client');
  Reflect.set(client as object, 'send', (command: Parameters<MemoryBucket['send']>[0]) =>
    bucket.send(command),
  );
  return { bucket, service: new AssetService(s3) };
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function applicationWithEndpoint(): Promise<string> {
  const id = randomBytes(12).toString('hex');
  await getDb()
    .insert(applications)
    .values({
      id,
      name: `app-${id.slice(0, 6)}`,
      type: 'first_party',
      ownerAccountId: await account(),
      filesWebhookUrl: `https://${id}.receiver.example/files`,
      filesWebhookSecretCiphertext: sealFileWebhookSecret(id, 'whsec_lost'),
      filesWebhookVerifiedAt: new Date(),
    });
  return id;
}

async function file(
  values: Partial<typeof files.$inferInsert> & { ownerUserId?: string | null } = {},
) {
  const sha = randomBytes(32).toString('hex');
  const [row] = await getDb()
    .insert(files)
    .values({
      sha256: sha,
      size: 6,
      mime: 'image/png',
      ext: '.png',
      visibility: 'public',
      storageKey: `content/2026/02/${sha.slice(0, 2)}/${sha}.png`,
      originalName: 'kept-name.png',
      metadata: { media: { width: 2048, height: 2048 } },
      ...values,
    })
    .returning();
  return row;
}

async function statusOf(fileId: string) {
  const [row] = await getDb().select().from(files).where(eq(files.id, fileId));
  return row;
}

beforeAll(async () => {
  process.env.DEVICE_ID_SALT ??= 'test-device-id-salt-that-is-long-enough-000';
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('assetService.markFileLost', () => {
  it('leaves a file whose object is at either spelling alone', async () => {
    const { bucket, service } = harness();
    const owner = await account();
    const bare = await file({ ownerUserId: owner });
    bucket.objects.set(`public/${bare.storageKey}`, Buffer.from('bytes!'));

    expect(await service.markFileLost(bare.id)).toBe('present');
    expect((await statusOf(bare.id)).status).toBe('active');
  });

  it('keeps the row and tells every using application, out of trash too', async () => {
    const { service } = harness();
    const owner = await account();
    const user = await applicationWithEndpoint();
    const gone = await file({ ownerUserId: owner });
    await addFileReferences([
      { fileId: gone.id, applicationId: user, entityType: 'post', entityId: 'p1' },
    ]);
    // In trash (a reference added to a trashed file would bring it back).
    await getDb()
      .update(files)
      .set({ status: 'trash', trashedAt: new Date() })
      .where(eq(files.id, gone.id));

    expect(await service.markFileLost(gone.id)).toBe('lost');

    const row = await statusOf(gone.id);
    expect(row).toMatchObject({
      status: 'lost',
      trashedAt: null,
      originalName: 'kept-name.png',
      metadata: { media: { width: 2048, height: 2048 } },
      ownerUserId: owner,
    });
    const deliveries = await getDb()
      .select()
      .from(fileEventDeliveries)
      .where(eq(fileEventDeliveries.fileId, gone.id));
    expect(deliveries.map((delivery) => [delivery.applicationId, delivery.type])).toEqual([
      [user, 'file.lost'],
    ]);
    expect(deliveries[0].payload).toMatchObject({
      type: 'file.lost',
      file: { id: gone.id, status: 'lost' },
      references: [{ entityType: 'post', entityId: 'p1' }],
    });
    // Once lost, it is lost: nothing more to do.
    expect(await service.markFileLost(gone.id)).toBe('not_live');
  });

  it('is never served, is listed as lost, holds no claim on its bytes, and is deletable', async () => {
    const { service } = harness();
    const owner = await account();
    const lost = await file({ ownerUserId: owner });
    expect(await service.markFileLost(lost.id)).toBe('lost');
    const row = await statusOf(lost.id);

    expect(isServableStatus(row)).toBe(false);
    const library = await listFilesByOwner(owner, 50, 0);
    expect(library.files.map((listed) => [listed.id, listed.status])).toEqual([[lost.id, 'lost']]);
    // No claim on the content hash: the owner's same bytes are a new file.
    expect(await findLiveFileBySha256ForOwner(row.sha256, { ownerUserId: owner })).toBeNull();
    const again = await file({ ownerUserId: owner, sha256: row.sha256 });
    expect(again.status).toBe('active');

    await service.deleteFile(lost.id, false, owner);
    expect((await statusOf(lost.id)).status).toBe('deleted');
  });

  it('refuses a federation cache entry and answers not_live for a tombstone', async () => {
    const { service } = harness();
    const cached = await file({
      ownerUserId: null,
      systemOwner: '__federation_media_cache__',
      purpose: 'federation-media-cache',
      storageKey: `public/content/2026/06/aa/${randomBytes(32).toString('hex')}.jpg`,
    });
    expect(await service.markFileLost(cached.id)).toBe('federation_cache');
    expect((await statusOf(cached.id)).status).toBe('active');

    const tombstone = await file({ ownerUserId: await account(), status: 'deleted' });
    expect(await service.markFileLost(tombstone.id)).toBe('not_live');
    expect(await service.markFileLost('no-such-file')).toBe('not_live');
  });
});
