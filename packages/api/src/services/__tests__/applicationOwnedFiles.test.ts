/**
 * Application-owned files (ADR 0041) in the services, against a REAL Postgres
 * and the REAL `S3Service` over an in-memory bucket.
 *
 *  - Quota (ADR 0041 D2/D3): Oxy's own applications (`first_party`,
 *    `internal`, `system`) are the platform and are metered against no one;
 *    a `third_party` application's bytes count against the account that owns
 *    the APPLICATION — on row admission, in `reservedStorageBytes`, and on the
 *    staged-stream reservation — and move with the application when it is
 *    transferred. `applicationStoredBytes` reports either.
 *  - Deletion: a per-file delete owes its storage under `app:<appId>`; an
 *    account's hard deletion records and removes its applications' files, so
 *    the `RESTRICT` foreign key never makes the cascade fail and no row is
 *    dropped without its purge.
 *  - Cross-application: another application's file is `not_found` and untouched.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, inArray } from 'drizzle-orm';

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

import {
  EMPTY_PRODUCT_BILLING_CATALOGUE,
  type ProductBillingCatalogue,
} from '../productBillingCatalogue.service';
let mockCatalogue: ProductBillingCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
jest.mock('../productBillingCatalogue.service', () => ({
  ...jest.requireActual('../productBillingCatalogue.service'),
  loadProductBillingCatalogue: () => Promise.resolve(mockCatalogue),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  files,
  storageByteReservations,
  storageObjectDeletions,
  users,
} from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { recordAccountStorageDeletion } from '../accountStorageDeletion.service';
import { AssetService } from '../assetService';
import { insertFile } from '../fileRepository';
import { S3Service } from '../s3Service';
import {
  applicationStoredBytes,
  legacyStorageLimit,
  reservedStorageBytes,
  storageAccountForOwner,
} from '../storageQuota.service';

jest.setTimeout(60_000);

const png = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)]);

/** An in-memory bucket behind the real `S3Service`, answered by command class. */
class MemoryBucket {
  readonly objects = new Map<string, Buffer>();

  async send(command: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<unknown> {
    const input = command.input;
    const key = String(input.Key ?? '');
    switch (command.constructor.name) {
      case 'HeadObjectCommand':
        if (!this.objects.has(key))
          throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return { ContentLength: this.objects.get(key)?.length };
      case 'PutObjectCommand': {
        const body = input.Body;
        this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.alloc(0));
        return {};
      }
      case 'CopyObjectCommand': {
        const source = String(input.CopySource).split('/').slice(1).join('/');
        const bytes = this.objects.get(source);
        if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        this.objects.set(key, bytes);
        return {};
      }
      case 'DeleteObjectCommand':
        this.objects.delete(key);
        return {};
      case 'ListObjectsV2Command': {
        const prefix = String(input.Prefix ?? '');
        return {
          Contents: [...this.objects.keys()]
            .filter((k) => k.startsWith(prefix))
            .map((k) => ({ Key: k, Size: this.objects.get(k)?.length ?? 0 })),
        };
      }
      default:
        throw new Error(`MemoryBucket: unexpected ${command.constructor.name}`);
    }
  }
}

function harness() {
  const bucket = new MemoryBucket();
  const s3 = new S3Service(
    { accessKeyId: 'test', secretAccessKey: 'test', bucketName: 'media', region: 'us-east-1' },
    { enqueueDeletedKey: () => undefined },
  );
  const client: unknown = Reflect.get(s3, 's3Client');
  if (typeof client !== 'object' || client === null) throw new Error('S3Service has no client');
  Reflect.set(client, 'send', (command: Parameters<MemoryBucket['send']>[0]) =>
    bucket.send(command),
  );
  return { bucket, service: new AssetService(s3) };
}

function configureQuota(products: { id: string }[]): void {
  mockCatalogue = {
    ...EMPTY_PRODUCT_BILLING_CATALOGUE,
    products: products as ProductBillingCatalogue['products'],
    storageAdapter: {
      productId: products[0].id,
      quotaKey: 'storage_bytes',
      unit: 'byte',
      legacyCombination: 'maximum',
    },
  };
}

async function account(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function applicationOwnedBy(
  ownerAccountId: string,
  type: 'first_party' | 'third_party' | 'internal' | 'system' = 'first_party',
): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `app-${randomBytes(4).toString('hex')}`, ownerAccountId, type })
    .returning({ id: applications.id });
  return row.id;
}

function original(size: number, owner: { ownerUserId?: string; ownerApplicationId?: string }) {
  return {
    sha256: randomBytes(32).toString('hex'),
    size,
    mime: 'image/png',
    ext: '.png',
    ...owner,
    status: 'active' as const,
    visibility: 'public' as const,
    storageKey: `content/synthetic/${randomBytes(8).toString('hex')}`,
  };
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  mockCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
});

describe("quota: Oxy's own applications are not metered (ADR 0041 D2)", () => {
  it.each(['first_party', 'internal', 'system'] as const)(
    'attributes a %s application’s files to no account',
    async (type) => {
      const owner = await account();
      const appId = await applicationOwnedBy(owner, type);

      expect(await storageAccountForOwner(getDb(), { ownerApplicationId: appId })).toBeNull();
      expect(await storageAccountForOwner(getDb(), { ownerUserId: owner })).toBe(owner);
      expect(await storageAccountForOwner(getDb(), {})).toBeNull();
    },
  );

  it("leaves the owning account's quota untouched and never refuses the application at capacity", async () => {
    const f = await productAccessFixture();
    configureQuota(f.products);
    const appId = await applicationOwnedBy(f.payer, 'first_party');
    const capacity = legacyStorageLimit('basic');

    await insertFile(original(capacity, { ownerUserId: f.payer }));
    expect(await reservedStorageBytes(getDb(), f.payer)).toBe(BigInt(capacity));

    // The account is full; Oxy's application is not its tenant.
    await expect(
      insertFile(original(capacity, { ownerApplicationId: appId })),
    ).resolves.toBeDefined();
    expect(await reservedStorageBytes(getDb(), f.payer)).toBe(BigInt(capacity));
    await expect(insertFile(original(1, { ownerUserId: f.payer }))).rejects.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
    });
  });

  it('stages a stream without reserving against any account', async () => {
    const f = await productAccessFixture();
    configureQuota(f.products);
    const appId = await applicationOwnedBy(f.payer, 'first_party');
    const { service } = harness();
    const content = png();
    const sha256 = createHash('sha256').update(content).digest('hex');

    const uploaded = await service.uploadApplicationFileStream(
      Readable.from(content),
      'image/png',
      'tile.png',
      1_000_000,
      appId,
      'public',
    );
    expect(uploaded.file).toMatchObject({ ownerApplicationId: appId, sha256 });
    const reservations = await getDb()
      .select({ accountId: storageByteReservations.accountId })
      .from(storageByteReservations)
      .where(eq(storageByteReservations.sha256, sha256));
    expect(reservations).toEqual([]);
    expect(await reservedStorageBytes(getDb(), f.payer)).toBe(BigInt(0));
  });

  it('is observed instead: applicationStoredBytes reports live rows and bytes, metered against no one', async () => {
    const appId = await applicationOwnedBy(await account(), 'internal');
    await insertFile(original(40, { ownerApplicationId: appId }));
    await insertFile({ ...original(2, { ownerApplicationId: appId }), status: 'trash' });
    await insertFile({ ...original(1000, { ownerApplicationId: appId }), status: 'deleted' });

    expect(await applicationStoredBytes(getDb(), appId)).toEqual({
      applicationId: appId,
      files: 2,
      bytes: 42,
      meteredAccountId: null,
    });
  });
});

describe("quota: a third-party application's bytes count against its developer (ADR 0041 D3)", () => {
  it('resolves the owning account as the billing account', async () => {
    const owner = await account();
    const appId = await applicationOwnedBy(owner, 'third_party');
    expect(await storageAccountForOwner(getDb(), { ownerApplicationId: appId })).toBe(owner);
  });

  it("counts the application's rows in the owner's reserved bytes and refuses the next byte past capacity", async () => {
    const f = await productAccessFixture();
    configureQuota(f.products);
    const appId = await applicationOwnedBy(f.payer, 'third_party');
    const capacity = legacyStorageLimit('basic');

    await insertFile(original(capacity - 10, { ownerApplicationId: appId }));
    expect(await reservedStorageBytes(getDb(), f.payer)).toBe(BigInt(capacity - 10));

    // The account's own upload and the application's next one share the room left.
    await insertFile(original(10, { ownerUserId: f.payer }));
    await expect(insertFile(original(1, { ownerApplicationId: appId }))).rejects.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
    });
    await expect(insertFile(original(1, { ownerUserId: f.payer }))).rejects.toMatchObject({
      code: 'STORAGE_QUOTA_EXCEEDED',
    });

    // Somebody else's quota is untouched by this application's bytes.
    const stranger = (await productAccessFixture()).payer;
    expect(await reservedStorageBytes(getDb(), stranger)).toBe(BigInt(0));
    await expect(insertFile(original(1, { ownerUserId: stranger }))).resolves.toBeDefined();

    expect(await applicationStoredBytes(getDb(), appId)).toEqual({
      applicationId: appId,
      files: 1,
      bytes: capacity - 10,
      meteredAccountId: f.payer,
    });
  });

  it('reserves a staged application stream against the owning account, beside that account sharing the bytes', async () => {
    const f = await productAccessFixture();
    configureQuota(f.products);
    const appId = await applicationOwnedBy(f.payer, 'third_party');
    const { service } = harness();
    const content = png();
    const sha256 = createHash('sha256').update(content).digest('hex');

    // The owning account already stored these bytes itself. Its finished
    // reservation is NOT an upload in progress for the application.
    await service.uploadUserMediaStream(
      Readable.from(content),
      'image/png',
      'mine.png',
      1_000_000,
      f.payer,
    );
    const uploaded = await service.uploadApplicationFileStream(
      Readable.from(content),
      'image/png',
      'tile.png',
      1_000_000,
      appId,
      'public',
    );

    expect(uploaded.deduplicated).toBe(false);
    expect(uploaded.file).toMatchObject({
      ownerUserId: null,
      ownerApplicationId: appId,
      visibility: 'public',
      sha256,
    });
    const reservations = await getDb()
      .select({ accountId: storageByteReservations.accountId })
      .from(storageByteReservations)
      .where(eq(storageByteReservations.sha256, sha256));
    expect(reservations.map((row) => row.accountId)).toEqual([f.payer, f.payer]);
    expect(await reservedStorageBytes(getDb(), f.payer)).toBe(BigInt(2 * content.length));

    // Idempotent per (application, bytes): the same row, visibility unchanged.
    const again = await service.uploadApplicationFileStream(
      Readable.from(content),
      'image/png',
      'tile-again.png',
      1_000_000,
      appId,
      'private',
    );
    expect(again).toMatchObject({ deduplicated: true });
    expect(again.file).toMatchObject({ id: uploaded.file.id, visibility: 'public' });
  });

  it("moves the application's usage with it when it is transferred to another account", async () => {
    const from = await account();
    const to = await account();
    const appId = await applicationOwnedBy(from, 'third_party');
    await insertFile(original(77, { ownerApplicationId: appId }));
    expect(await reservedStorageBytes(getDb(), from)).toBe(BigInt(77));
    expect(await reservedStorageBytes(getDb(), to)).toBe(BigInt(0));

    await getDb()
      .update(applications)
      .set({ ownerAccountId: to })
      .where(eq(applications.id, appId));

    expect(await reservedStorageBytes(getDb(), from)).toBe(BigInt(0));
    expect(await reservedStorageBytes(getDb(), to)).toBe(BigInt(77));
    expect(await storageAccountForOwner(getDb(), { ownerApplicationId: appId })).toBe(to);
  });

  it('stops counting when staff reclassify the application as one of Oxy’s own', async () => {
    const owner = await account();
    const appId = await applicationOwnedBy(owner, 'third_party');
    await insertFile(original(9, { ownerApplicationId: appId }));
    expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(9));

    await getDb()
      .update(applications)
      .set({ type: 'first_party' })
      .where(eq(applications.id, appId));
    expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(0));
  });
});

describe('deletion: storage is always owed, under app:<appId>', () => {
  it("tombstones the application's own file and owes its keys under app:<appId>; another application gets not_found", async () => {
    const { bucket, service } = harness();
    const appId = await applicationOwnedBy(await account());
    const otherAppId = await applicationOwnedBy(await account());
    const content = png();
    const { file } = await service.uploadApplicationFileStream(
      Readable.from(content),
      'image/png',
      'tile.png',
      1_000_000,
      appId,
      'public',
    );
    expect(bucket.objects.has(file.storageKey)).toBe(true);

    expect(await service.deleteApplicationFile(file.id, otherAppId)).toBe('not_found');
    const [untouched] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(untouched.status).toBe('active');

    expect(await service.deleteApplicationFile(file.id, appId)).toBe('deleted');
    const [tombstone] = await getDb().select().from(files).where(eq(files.id, file.id));
    expect(tombstone.status).toBe('deleted');
    const owed = await getDb()
      .select({ accountId: storageObjectDeletions.accountId })
      .from(storageObjectDeletions)
      .where(eq(storageObjectDeletions.sha256, file.sha256));
    expect(owed.length).toBeGreaterThan(0);
    expect(new Set(owed.map((row) => row.accountId))).toEqual(new Set([`app:${appId}`]));
    expect(bucket.objects.has(file.storageKey)).toBe(false);

    // Idempotent: a second delete finds nothing live.
    expect(await service.deleteApplicationFile(file.id, appId)).toBe('not_found');
  });

  it("a hard account deletion records and removes its applications' files, so the RESTRICT cascade succeeds", async () => {
    const owner = await account();
    const appId = await applicationOwnedBy(owner);
    const live = await insertFile(original(5, { ownerApplicationId: appId }));
    const trashed = await insertFile({
      ...original(5, { ownerApplicationId: appId }),
      status: 'deleted',
    });
    const own = await insertFile(original(5, { ownerUserId: owner }));

    // Without the sweep the cascade to `applications` is refused, never silent.
    await expect(
      getDb().transaction(async (tx) => {
        await tx.delete(users).where(eq(users.id, owner));
      }),
    ).rejects.toThrow();

    await getDb().transaction(async (tx) => {
      const recorded = await recordAccountStorageDeletion(tx, owner, { removeAssetRows: false });
      expect(new Set(recorded.fileIds)).toEqual(new Set([live.id, trashed.id, own.id]));
      await tx.delete(users).where(eq(users.id, owner));
    });

    const remaining = await getDb()
      .select({ id: files.id })
      .from(files)
      .where(inArray(files.id, [live.id, trashed.id, own.id]));
    expect(remaining).toEqual([]);
    const ledger = await getDb()
      .select({
        accountId: storageObjectDeletions.accountId,
        sha256: storageObjectDeletions.sha256,
      })
      .from(storageObjectDeletions)
      .where(
        and(
          inArray(storageObjectDeletions.sha256, [live.sha256, trashed.sha256, own.sha256]),
          eq(storageObjectDeletions.reason, 'account.deleted'),
        ),
      );
    expect(ledger.filter((row) => row.sha256 === live.sha256)[0]?.accountId).toBe(`app:${appId}`);
    expect(ledger.filter((row) => row.sha256 === trashed.sha256)[0]?.accountId).toBe(
      `app:${appId}`,
    );
    expect(ledger.filter((row) => row.sha256 === own.sha256)[0]?.accountId).toBe(owner);
  });
});

describe('a reference never changes an application file’s visibility (ADR 0041 D4)', () => {
  it('keeps a private application file private when another application references it for an avatar', async () => {
    const { service } = harness();
    const appId = await applicationOwnedBy(await account());
    const otherAppId = await applicationOwnedBy(await account());
    const file = await insertFile(original(5, { ownerApplicationId: appId }));
    await getDb().update(files).set({ visibility: 'private' }).where(eq(files.id, file.id));

    const { file: linked, created } = await service.linkFile(file.id, {
      applicationId: otherAppId,
      entityType: 'avatar',
      entityId: 'someone',
      createdByUserId: await account(),
    });

    expect(created).toBe(true);
    expect(linked.visibility).toBe('private');
  });

  it('keeps a public application file public when its own application references it as private-sounding content', async () => {
    const { service } = harness();
    const appId = await applicationOwnedBy(await account());
    const file = await insertFile(original(5, { ownerApplicationId: appId }));

    const { file: linked } = await service.linkFile(file.id, {
      applicationId: appId,
      entityType: 'review_media',
      entityId: 'r1',
      createdByUserId: null,
    });

    expect(linked.visibility).toBe('public');
    expect(linked.links).toEqual([
      expect.objectContaining({ applicationId: appId, createdByUserId: null }),
    ]);
  });
});
