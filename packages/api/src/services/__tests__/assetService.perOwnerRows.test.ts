/**
 * One live `files` row per OWNER per content hash, sharing content-addressed
 * storage — end to end, against a REAL Postgres and the REAL `S3Service` over an
 * in-memory bucket.
 *
 * The defect this pins (security review of #1441): the upload paths handed the
 * ONE live row for a hash to any other account uploading the same bytes, so
 * owners held and linked each other's files and one owner's delete removed
 * another's media. Now:
 *
 *  - a different owner uploading the same bytes gets its OWN row, pointing at
 *    the same stored object — the bytes are not stored twice;
 *  - deleting one owner's row keeps the bytes for the other;
 *  - deleting the last live row purges the bytes, through `S3Service.deleteFile`,
 *    which is where the CloudFront invalidation is queued;
 *  - a delete racing another owner's upload of the same bytes cannot delete the
 *    object that upload just adopted (the content-hash lock, proven by
 *    `pg_locks` before the race is released).
 *
 * The bucket is a stub of `S3Client.send` keyed by command class, so every
 * `S3Service` method runs as written, including the invalidation hook.
 */

import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'stream';
import { and, eq, ne, sql } from 'drizzle-orm';

jest.mock('../variantService', () => ({
  VariantService: class {
    constructor(_s3: unknown) { /* no-op */ }
    generateVariants = jest.fn(() => Promise.resolve());
  },
}));

jest.mock('../../queue/assetVariants.queue', () => ({
  enqueueAssetVariantGeneration: jest.fn(() => Promise.resolve()),
}));

import { EMPTY_PRODUCT_BILLING_CATALOGUE, type ProductBillingCatalogue } from '../productBillingCatalogue.service';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { legacyStorageLimit } from '../storageQuota.service';
let mockCatalogue: ProductBillingCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
jest.mock('../productBillingCatalogue.service', () => ({
  ...jest.requireActual('../productBillingCatalogue.service'),
  loadProductBillingCatalogue: () => Promise.resolve(mockCatalogue),
}));
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { files, users } from '../../db/schema';
import { AssetService } from '../assetService';
import { S3Service, type DeletedObjectListener } from '../s3Service';
import fileCache from '../../utils/fileCache';

jest.setTimeout(60_000);

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(24)]);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

/**
 * An in-memory bucket behind the real `S3Service`: `send` is answered by
 * command class name. `holdHead` parks the next HEAD of a key until released,
 * which is how a test stops an upload INSIDE the content-hash lock.
 */
class MemoryBucket {
  readonly objects = new Map<string, Buffer>();
  readonly puts: string[] = [];
  readonly copies: Array<[string, string]> = [];
  readonly deletes: string[] = [];
  private held: { key: string; reached: () => void; release: Promise<void> } | null = null;

  holdHead(key: string) {
    const reached = gate();
    const release = gate();
    this.held = { key, reached: reached.open, release: release.opened };
    return { reached: reached.opened, release: release.open };
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    const input = command.input;
    const key = String(input.Key ?? '');
    switch (command.constructor.name) {
      case 'HeadObjectCommand': {
        if (this.held && this.held.key === key) {
          const held = this.held;
          this.held = null;
          held.reached();
          await held.release;
        }
        if (!this.objects.has(key)) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return { ContentLength: this.objects.get(key)?.length };
      }
      case 'PutObjectCommand': {
        const body = input.Body;
        this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.alloc(0));
        this.puts.push(key);
        return {};
      }
      case 'CopyObjectCommand': {
        const source = String(input.CopySource).split('/').slice(1).join('/');
        const bytes = this.objects.get(source);
        if (!bytes) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        this.objects.set(key, bytes);
        this.copies.push([source, key]);
        return {};
      }
      case 'DeleteObjectCommand':
        this.objects.delete(key);
        this.deletes.push(key);
        return {};
      case 'ListObjectsV2Command': {
        const prefix = String(input.Prefix ?? '');
        const max = Number(input.MaxKeys ?? 1000);
        return {
          Contents: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, max)
            .map((k) => ({ Key: k, Size: this.objects.get(k)?.length ?? 0, LastModified: new Date() })),
        };
      }
      default:
        throw new Error(`MemoryBucket: unexpected ${command.constructor.name}`);
    }
  }
}

function harness() {
  const bucket = new MemoryBucket();
  const invalidated: string[] = [];
  const listener: DeletedObjectListener = { enqueueDeletedKey: (key) => { invalidated.push(key); } };
  const s3 = new S3Service(
    { accessKeyId: 'test', secretAccessKey: 'test', bucketName: 'media', region: 'us-east-1' },
    listener,
  );
  const client: unknown = Reflect.get(s3, 's3Client');
  if (typeof client !== 'object' || client === null) throw new Error('S3Service has no client');
  Reflect.set(client, 'send', (command: Parameters<MemoryBucket['send']>[0]) => bucket.send(command));
  return { bucket, invalidated, service: new AssetService(s3) };
}

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function liveRowsFor(sha256: string) {
  return getDb()
    .select({ id: files.id, ownerUserId: files.ownerUserId, storageKey: files.storageKey })
    .from(files)
    .where(and(eq(files.sha256, sha256), ne(files.status, 'deleted')));
}

async function statusOf(id: string) {
  const [row] = await getDb().select({ status: files.status }).from(files).where(eq(files.id, id));
  return row?.status;
}

/** Wait until some session in THIS database waits on an advisory lock; throw if none ever does. */
async function waitForAdvisoryWaiter(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())`);
    if ((row as { n: number } | undefined)?.n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('precondition failed: nothing ever waited on the content-hash lock');
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(() => {
  mockCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
  fileCache.clear();
});

afterAll(async () => {
  await closePostgres();
});

describe('a second owner uploading the same bytes', () => {
  it('gets its OWN row, sharing the stored object — the bytes are stored once', async () => {
    const { bucket, service } = harness();
    const content = png();
    const alice = await insertUser();
    const bob = await insertUser();

    const first = await service.uploadFileDirect(alice, content, 'image/png', 'a.png', 'public');
    const second = await service.uploadFileDirect(bob, content, 'image/png', 'b.png', 'public');

    expect(second.id).not.toBe(first.id);
    expect(first.ownerUserId).toBe(alice);
    expect(second.ownerUserId).toBe(bob);
    expect(second.storageKey).toBe(first.storageKey);
    expect(bucket.puts).toEqual([first.storageKey]);
    expect(await liveRowsFor(first.sha256)).toHaveLength(2);
  });

  it('adopts an existing owner\'s key even when it is not the key this upload would mint', async () => {
    // Keys carry the month they were minted in, so "the same bytes land on the
    // same key anyway" only holds within a month: sharing has to come from the
    // existing row, not from minting the same name.
    const { bucket, service } = harness();
    const content = png();
    const sha256 = createHash('sha256').update(content).digest('hex');
    const oldKey = `public/content/2024/01/${sha256.slice(0, 2)}/${sha256}.png`;
    bucket.objects.set(oldKey, content);
    const [existing] = await getDb().insert(files).values({
      sha256, size: content.length, mime: 'image/png', ext: '.png', ownerUserId: await insertUser(),
      visibility: 'public', storageKey: oldKey,
    }).returning({ id: files.id });

    const mine = await service.uploadFileDirect(await insertUser(), content, 'image/png', 'b.png', 'public');

    expect(mine.id).not.toBe(existing.id);
    expect(mine.storageKey).toBe(oldKey);
    expect(bucket.puts).toEqual([]);
  });

  it('the SAME owner uploading again gets its existing row back, and no second row', async () => {
    const { service } = harness();
    const content = png();
    const alice = await insertUser();

    const first = await service.uploadFileDirect(alice, content, 'image/png', 'a.png', 'public');
    const again = await service.uploadFileDirect(alice, content, 'image/png', 'a-again.png', 'public');

    expect(again.id).toBe(first.id);
    expect(await liveRowsFor(first.sha256)).toHaveLength(1);
  });

  it('keeps the spelling its visibility needs: a private copy beside a public one', async () => {
    const { bucket, service } = harness();
    const content = png();
    const publicRow = await service.uploadFileDirect(await insertUser(), content, 'image/png', 'a.png', 'public');
    const privateRow = await service.uploadFileDirect(await insertUser(), content, 'image/png', 'b.png', 'private');

    expect(publicRow.storageKey.startsWith('public/')).toBe(true);
    expect(privateRow.storageKey).toBe(publicRow.storageKey.slice('public/'.length));
    expect(bucket.objects.has(privateRow.storageKey)).toBe(true);
  });
});

describe('deleting shared bytes', () => {
  it('keeps the bytes for the other owner, and purges + invalidates when the LAST row goes', async () => {
    const { bucket, invalidated, service } = harness();
    const content = png();
    const alice = await insertUser();
    const bob = await insertUser();
    const aliceRow = await service.uploadFileDirect(alice, content, 'image/png', 'a.png', 'public');
    const bobRow = await service.uploadFileDirect(bob, content, 'image/png', 'b.png', 'public');
    const key = aliceRow.storageKey;

    await service.deleteFile(aliceRow.id, false, alice);

    expect(await statusOf(aliceRow.id)).toBe('deleted');
    expect(await statusOf(bobRow.id)).toBe('active');
    expect(bucket.objects.has(key)).toBe(true);
    expect(bucket.deletes).not.toContain(key);
    expect(invalidated).not.toContain(key);

    await service.deleteFile(bobRow.id, false, bob);

    expect(bucket.objects.has(key)).toBe(false);
    expect(bucket.deletes).toContain(key);
    // `S3Service.deleteFile` hands every deleted key to the CDN invalidation queue.
    expect(invalidated).toContain(key);
  });

  it('refuses a delete by anyone but the row\'s owner, even one holding the same bytes', async () => {
    const { bucket, service } = harness();
    const content = png();
    const alice = await insertUser();
    const bob = await insertUser();
    const aliceRow = await service.uploadFileDirect(alice, content, 'image/png', 'a.png', 'public');
    await service.uploadFileDirect(bob, content, 'image/png', 'b.png', 'public');

    await expect(service.deleteFile(aliceRow.id, false, bob)).rejects.toThrow('Unauthorized');
    expect(await statusOf(aliceRow.id)).toBe('active');
    expect(bucket.objects.has(aliceRow.storageKey)).toBe(true);
  });
});

describe('a delete racing another owner\'s upload of the same bytes', () => {
  it('keeps the object the upload adopted while the purge waited on the content-hash lock', async () => {
    const { bucket, service } = harness();
    const content = png();
    const alice = await insertUser();
    const bob = await insertUser();
    const aliceRow = await service.uploadFileDirect(alice, content, 'image/png', 'a.png', 'public');
    const key = aliceRow.storageKey;

    // Bob's streamed upload chooses Alice's key under the lock, then stops on
    // the HEAD of that key — still holding the lock, row not yet inserted.
    const held = bucket.holdHead(key);
    const source = new Readable({ read() { this.push(content); this.push(null); } });
    const bobUpload = service.uploadUserMediaStream(source, 'image/png', 'b.png', 1_000_000, bob);
    await held.reached;

    // Alice deletes: the tombstone commits, the purge queues on the lock.
    const aliceDelete = service.deleteFile(aliceRow.id, false, alice);
    await waitForAdvisoryWaiter();
    expect(bucket.deletes).not.toContain(key);

    held.release();
    const bobRow = await bobUpload;
    await aliceDelete;

    expect(bobRow.storageKey).toBe(key);
    expect(await statusOf(aliceRow.id)).toBe('deleted');
    expect(bucket.objects.has(key)).toBe(true);
    expect(bucket.deletes).not.toContain(key);
    expect((await liveRowsFor(aliceRow.sha256)).map((row) => row.id)).toEqual([bobRow.id]);
  });
});

describe('configured presigned admission', () => {
  it('signs the admitted size and digest for first upload and missing-object repair', async () => {
    const f = await productAccessFixture();
    mockCatalogue = {...EMPTY_PRODUCT_BILLING_CATALOGUE,products:f.products,
      storageAdapter:{productId:f.products[0].id,quotaKey:'storage_bytes',unit:'byte',legacyCombination:'maximum'}};
    const {service}=harness();const content=png();const hash=createHash('sha256').update(content).digest('hex');
    const initial=await service.initUpload(f.payer,hash,content.length,'image/png');
    const repair=await service.initUpload(f.payer,hash,content.length+1,'image/png');
    for(const result of [initial,repair]) {
      expect(result.requiredHeaders).toEqual({'If-None-Match':'*'});
      const url=new URL(result.uploadUrl);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('if-none-match');
      expect(url.searchParams.get('x-amz-checksum-sha256')).toBe(Buffer.from(hash,'hex').toString('base64'));
      expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    }
    expect(initial.fileId).toBe(repair.fileId);
    const [stored]=await getDb().select().from(files).where(eq(files.id,initial.fileId));
    expect(stored.size).toBe(content.length);
  });
});

describe('completeUpload', () => {
  it('refuses to commit metadata to a row the caller does not own', async () => {
    const { service } = harness();
    const content = png();
    const alice = await insertUser();
    const row = await service.uploadFileDirect(alice, content, 'image/png', 'a.png', 'private');

    await expect(service.completeUpload({
      fileId: row.id,
      originalName: 'hijacked.png',
      size: content.length,
      mime: 'image/png',
      visibility: 'public',
    }, await insertUser())).rejects.toMatchObject({ statusCode: 403 });

    const [stored] = await getDb().select().from(files).where(eq(files.id, row.id));
    expect(stored).toMatchObject({ originalName: 'a.png', visibility: 'private' });
  });
  it('admits actual HEAD bytes, ignores client size, and rolls back over-capacity completion', async () => {
    const f = await productAccessFixture();
    mockCatalogue = { ...EMPTY_PRODUCT_BILLING_CATALOGUE, products: f.products,
      storageAdapter: { productId: f.products[0].id, quotaKey: 'storage_bytes', unit: 'byte', legacyCombination: 'maximum' } };
    const { bucket, service } = harness(); const content = png();
    const row = await service.uploadFileDirect(f.payer, content, 'image/png', 'first.png', 'private');
    const completed = await service.completeUpload({ fileId: row.id, originalName: 'first.png', size: 1,
      mime: 'image/png' }, f.payer);
    expect(completed.size).toBe(content.length);
    const [filler] = await getDb().insert(files).values({sha256: randomBytes(32).toString('hex'),
      size: legacyStorageLimit('basic') - content.length, mime: 'text/plain', ext: '.txt',
      ownerUserId: f.payer, status: 'active', visibility: 'private', storageKey: 'synthetic/filler'}).returning();
    bucket.objects.set(completed.storageKey, Buffer.concat([content, Buffer.from([1])]));
    await expect(service.completeUpload({ fileId: row.id, originalName: 'oversized.png', size: 1,
      mime: 'image/png' }, f.payer)).rejects.toMatchObject({code:'STORAGE_QUOTA_EXCEEDED'});
    const [stored] = await getDb().select().from(files).where(eq(files.id,row.id));
    expect(stored.size).toBe(content.length); expect(stored.originalName).toBe('first.png');
    await getDb().delete(files).where(eq(files.id,filler.id));
    bucket.objects.delete(completed.storageKey);
    await expect(service.completeUpload({fileId:row.id,size:1,mime:'image/png',originalName:'absent'},f.payer)).rejects.toThrow('not found');
  });
  it('refuses an unsupported public relocation before persisting the visibility change', async () => {
    const f = await productAccessFixture();
    mockCatalogue = { ...EMPTY_PRODUCT_BILLING_CATALOGUE, products: f.products,
      storageAdapter: { productId: f.products[0].id, quotaKey: 'storage_bytes', unit: 'byte', legacyCombination: 'maximum' } };
    const { service } = harness(); const content = png();
    const row = await service.uploadFileDirect(f.payer, content, 'image/png', 'private.png', 'private');
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(service.completeUpload({ fileId: row.id, originalName: 'public.png', size: content.length,
        mime: 'image/png', visibility: 'public' }, f.payer)).rejects.toMatchObject({ code: 'STORAGE_PHYSICAL_PATH_UNAVAILABLE' });
    const [stored] = await getDb().select().from(files).where(eq(files.id, row.id));
    expect(stored).toMatchObject({ visibility: 'private', storageKey: row.storageKey, originalName: 'private.png' });
    // Completing without a prefix change still works under configured admission.
    expect((await service.completeUpload({ fileId: row.id, originalName: 'kept.png', size: 1, mime: 'image/png' }, f.payer)).visibility).toBe('private');
  });

});
