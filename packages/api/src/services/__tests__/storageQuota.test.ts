import { reserveStorageBytes, recoverStorageByteReservations } from '../storageByteReservation.service';
import { storageByteReservations } from '../../db/schema';
import { Readable } from 'stream';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { EMPTY_PRODUCT_BILLING_CATALOGUE, type ProductBillingCatalogue } from '../productBillingCatalogue.service';
import { insertFile, updateFile, upsertVariant } from '../fileRepository';
import { storageCapacity, reservedStorageBytes, legacyStorageLimit, uploadAdmittedVariant, assertPhysicalStoragePathSupported } from '../storageQuota.service';
let mockCatalogue: ProductBillingCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
jest.mock('../productBillingCatalogue.service', () => ({
  ...jest.requireActual('../productBillingCatalogue.service'),
  loadProductBillingCatalogue: () => Promise.resolve(mockCatalogue),
}));
jest.mock('../../queue/assetVariants.queue', () => ({ enqueueAssetVariantGeneration: jest.fn(async () => undefined) }));
let owner: string;
beforeAll(async () => { await connectPostgres(); });
afterAll(async () => { await closePostgres(); });
beforeEach(async () => {
  const f = await productAccessFixture(); owner = f.payer;
  mockCatalogue = { ...EMPTY_PRODUCT_BILLING_CATALOGUE, products: f.products,
    storageAdapter: { productId: f.products[0].id, quotaKey: 'storage_bytes', unit: 'byte', legacyCombination: 'maximum' } };
});
function original(size: number, ownerUserId = owner) {
  return { sha256: randomUUID().replaceAll('-', '').padEnd(64, 'a'), size, mime: 'text/plain', ext: 'txt',
    ownerUserId, status: 'active' as const, storageKey: 'synthetic/' + randomUUID(), originalName: 'fixture.txt' };
}
it('serializes concurrent uploads and rolls back the losing reservation', async () => {
  const capacity = legacyStorageLimit('basic');
  const results = await Promise.allSettled([insertFile(original(capacity)), insertFile(original(capacity))]);
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(value => value.status === 'rejected')).toHaveLength(1);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(capacity));
  expect(await getDb().select().from(files).where(eq(files.ownerUserId, owner))).toHaveLength(1);
});
it('counts originals and variants and rolls back oversized size corrections', async () => {
  const file = await insertFile(original(legacyStorageLimit('basic') - 3));
  await upsertVariant(file.id, { type: 'thumbnail', key: 'synthetic/thumb', size: 3 });
  expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(legacyStorageLimit('basic')));
  await expect(upsertVariant(file.id, { type: 'thumbnail', key: 'synthetic/large', size: 4 })).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
  await expect(updateFile(file.id, { size: legacyStorageLimit('basic') })).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
  expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(legacyStorageLimit('basic')));
});
it('isolates accounts, keeps trash reserved and releases deleted metadata', async () => {
  const file = await insertFile(original(legacyStorageLimit('basic')));
  await updateFile(file.id, { status: 'trash' });
  await expect(insertFile(original(1))).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
  const other = (await productAccessFixture()).payer;
  await expect(insertFile(original(1, other))).resolves.toBeDefined();
  await updateFile(file.id, { status: 'deleted' });
  await expect(insertFile(original(1))).resolves.toBeDefined();
});
it('is inert until configured and creates no default bundle rights', async () => {
  mockCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
  await expect(insertFile(original(legacyStorageLimit('basic') + 1))).resolves.toBeDefined();
  expect(await storageCapacity(getDb(), owner, mockCatalogue)).toBe(legacyStorageLimit('basic'));
});
it('uses immutable bundle and individual grants without dropping the legacy floor', async () => {
  const { registerProductAccessConfiguration, recordProductAccessPeriod, updateProductAccessSourceState } = await import('../productAccessPersistence.service');
  const f = await productAccessFixture(); owner = f.beneficiary;
  const cap = legacyStorageLimit('basic');
  const bundle = { ...f.offers[0], id: randomUUID(), benefits: [{ kind: 'quota' as const,
    productId: f.products[0].id, key: 'storage_bytes', unit: 'byte', included: cap + 5, combination: 'maximum' as const }] };
  const individual = { ...f.offers[1], id: randomUUID(), benefits: [{ ...bundle.benefits[0], included: cap + 10 }] };
  await registerProductAccessConfiguration({ products: f.products, offers: [bundle, individual] });
  mockCatalogue = { ...EMPTY_PRODUCT_BILLING_CATALOGUE, products: f.products, offers: [bundle, individual],
    storageAdapter: { productId: f.products[0].id, quotaKey: 'storage_bytes', unit: 'byte', legacyCombination: 'maximum' } };
  const bundleInput = f.input(bundle); const individualInput = f.input(individual);
  await recordProductAccessPeriod(bundleInput); await recordProductAccessPeriod(individualInput);
  expect(await storageCapacity(getDb(), owner, mockCatalogue)).toBe(cap + 10);
  await updateProductAccessSourceState({ sourceId: bundleInput.source.id, productId: f.products[0].id, status: 'canceled',
    period: bundleInput.source.period, cancelAtPeriodEnd: false, providerObservedAt: new Date(f.now.getTime() + 1000), providerBinding: f.providerBinding });
  expect(await storageCapacity(getDb(), owner, mockCatalogue)).toBe(cap + 10);
  const file = await insertFile(original(cap + 10));
  await updateProductAccessSourceState({ sourceId: individualInput.source.id, productId: f.products[0].id,
    status: 'canceled', period: individualInput.source.period, cancelAtPeriodEnd: false,
    providerObservedAt: new Date(f.now.getTime() + 1000), providerBinding: f.providerBinding });
  expect(await storageCapacity(getDb(), owner, mockCatalogue)).toBe(cap);
  await expect(updateFile(file.id, { originalName: 'renamed.txt' })).resolves.toBeDefined();
  await expect(updateFile(file.id, { size: cap + 9 })).resolves.toBeDefined();
  await expect(insertFile(original(1))).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
});

it('applies the approved detached personal composition as exactly 100 GB decimal',async()=>{
  const {registerProductAccessConfiguration,recordProductAccessPeriod}=await import('../productAccessPersistence.service');
  const f=await productAccessFixture();owner=f.beneficiary;
  const bundle={...f.offers[0],id:randomUUID(),benefits:[{kind:'quota' as const,productId:f.products[0].id,key:'storage_bytes',unit:'byte',included:100_000_000_000,combination:'maximum' as const}]};
  await registerProductAccessConfiguration({products:f.products,offers:[bundle]});
  await recordProductAccessPeriod(f.input(bundle));
  mockCatalogue={...EMPTY_PRODUCT_BILLING_CATALOGUE,products:f.products,offers:[bundle],storageAdapter:{productId:f.products[0].id,quotaKey:'storage_bytes',unit:'byte',legacyCombination:'maximum'}};
  expect(await storageCapacity(getDb(),owner,mockCatalogue)).toBe(100_000_000_000);
  await insertFile(original(100_000_000_000));
  await expect(insertFile(original(1))).rejects.toMatchObject({code:'STORAGE_QUOTA_EXCEEDED'});
});

it('admits actual buffered variant bytes before physical PUT and rolls back rejected writes', async () => {
  const file = await insertFile(original(legacyStorageLimit('basic') - 2));
  const put = jest.fn(async () => undefined), remove = jest.fn(async () => undefined);
  await expect(uploadAdmittedVariant(file, { type: 'large', key: 'synthetic/large', size: 3 }, put, remove)).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
  expect(put).not.toHaveBeenCalled();
  const admitted = await uploadAdmittedVariant(file, { type: 'small', key: 'synthetic/small', size: 2 }, put, remove);
  expect(admitted.key).not.toBe('synthetic/small');
  expect(put).toHaveBeenCalledWith(admitted.key);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(legacyStorageLimit('basic')));
});
it('cleans the unique failed variant object and releases its rolled-back admission', async () => {
  const file = await insertFile(original(1));
  const put = jest.fn(async (_key: string) => { throw new Error('synthetic PUT failure'); });
  const remove = jest.fn(async () => undefined);
  await expect(uploadAdmittedVariant(file, { type: 'failed', key: 'synthetic/failed', size: 2 }, put, remove)).rejects.toThrow('synthetic PUT failure');
  expect(remove).toHaveBeenCalledWith(put.mock.calls[0][0]);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(3n); // durable pending bytes survive failure
  await recoverStorageByteReservations(remove, async () => true, 100, new Date(Date.now() + 3600_000));
  expect(await reservedStorageBytes(getDb(), owner)).toBe(1n);
});
it('does not replace or orphan an existing admitted variant', async () => {
  const file = await insertFile(original(1));
  await upsertVariant(file.id, { type: 'existing', key: 'synthetic/shared', size: 2 });
  const put = jest.fn(async () => undefined);
  await expect(uploadAdmittedVariant(file, { type: 'existing', key: 'synthetic/new', size: 2 }, put, async () => undefined)).rejects.toMatchObject({ code: 'STORAGE_VARIANT_EXISTS' });
  expect(put).not.toHaveBeenCalled();
  await recoverStorageByteReservations(async () => undefined, async () => true, 100, new Date(Date.now() + 3600_000));
  expect(await reservedStorageBytes(getDb(), owner)).toBe(3n);
});
it('blocks unsupported owner writers while preserving system caches and legacy mode', async () => {
  await expect(assertPhysicalStoragePathSupported(owner, 'HLS')).rejects.toMatchObject({ code: 'STORAGE_PHYSICAL_PATH_UNAVAILABLE' });
  await expect(assertPhysicalStoragePathSupported(null, 'system cache')).resolves.toBeUndefined();
  mockCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
  await expect(assertPhysicalStoragePathSupported(owner, 'legacy multipart')).resolves.toBeUndefined();
});

it('real lazy image rendition uses admitted bytes and reuses its existing object', async () => {
  const { VariantService } = await import('../variantService');
  const sharp = (await import('sharp')).default;
  const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer();
  const file = await insertFile({ ...original(buffer.length), mime: 'image/png', ext: 'png' });
  const bucket = new Map<string, Buffer>();
  const s3 = {
    downloadBuffer: jest.fn(async () => buffer),
    uploadBuffer: jest.fn(async (key: string, value: Buffer) => { bucket.set(key, value); }),
    deleteFile: jest.fn(async (key: string) => { bucket.delete(key); }),
    fileExists: jest.fn(async (key: string) => bucket.has(key)),
  };
  const service = new VariantService(s3 as unknown as import('../s3Service').S3Service);
  const variant = await service.ensureImageVariant(file, 'w96');
  expect(variant.size).toBe(bucket.get(variant.key)?.length);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(buffer.length + (variant.size ?? 0)));
  await service.ensureImageVariant(file, 'w96');
  expect(s3.uploadBuffer).toHaveBeenCalledTimes(1);
});

it('owner multipart stages locally and rejects account quota before bucket upload', async () => {
  const { AssetService } = await import('../assetService');
  await insertFile(original(legacyStorageLimit('basic')));
  const s3 = { uploadStream: jest.fn(async () => undefined), deleteFile: jest.fn(async () => undefined) };
  const service = new AssetService(s3 as unknown as import('../s3Service').S3Service);
  await expect(service.uploadUserMediaStream(Readable.from(Buffer.from('stream')), 'text/plain', 'stream.txt', 6, owner))
    .rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
  expect(s3.uploadStream).not.toHaveBeenCalled();
  await expect(service.uploadUserMediaStream(Readable.from(Buffer.from('stream')), 'text/plain', 'stream.txt', 2, owner))
    .rejects.toMatchObject({ code: 'STORAGE_STREAM_TOO_LARGE' });
  expect(s3.uploadStream).not.toHaveBeenCalled();
});
it('owner multipart charges actual bytes and cleans failed unique objects', async () => {
  const { AssetService } = await import('../assetService');
  const bucket = new Map<string, Buffer>();
  let fail = true;
  const s3 = {
    uploadStream: jest.fn(async (key: string, source: Readable) => {
      const chunks: Buffer[] = []; for await (const chunk of source) chunks.push(Buffer.from(chunk));
      bucket.set(key, Buffer.concat(chunks));
      if (fail) throw new Error('synthetic multipart failure');
    }),
    deleteFile: jest.fn(async (key: string) => { bucket.delete(key); }),
    fileExists: jest.fn(async (key: string) => bucket.has(key)),
  };
  const service = new AssetService(s3 as unknown as import('../s3Service').S3Service);
  await expect(service.uploadUserMediaStream(Readable.from(Buffer.from('stream')), 'text/plain', 'stream.txt', 100, owner)).rejects.toThrow('synthetic multipart failure');
  expect(bucket.size).toBe(0);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(6n);
  await recoverStorageByteReservations(async key => { await s3.deleteFile(key); expect(bucket.has(key)).toBe(false); }, async () => true,
    100, new Date(Date.now() + 3600_000));
  expect(await reservedStorageBytes(getDb(), owner)).toBe(0n);
  fail = false;
  const file = await service.uploadUserMediaStream(Readable.from(Buffer.from('stream')), 'text/plain', 'stream.txt', 100, owner);
  expect(file.size).toBe(6);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(6n);
  expect(bucket.get(file.storageKey)?.toString()).toBe('stream');
});

it('stale owner and deleted files cannot create physical variants', async () => {
  const file = await insertFile(original(1));
  const other = (await productAccessFixture()).payer;
  await updateFile(file.id, { ownerUserId: other });
  const put = jest.fn(async () => undefined);
  await expect(uploadAdmittedVariant(file, { type: 'stale', key: 'synthetic/stale', size: 1 }, put, async () => undefined)).rejects.toMatchObject({ code: 'STORAGE_FILE_CHANGED' });
  const own = await insertFile(original(1));
  await updateFile(own.id, { status: 'deleted' });
  await expect(uploadAdmittedVariant(own, { type: 'deleted', key: 'synthetic/deleted', size: 1 }, put, async () => undefined)).rejects.toMatchObject({ code: 'STORAGE_FILE_CHANGED' });
  expect(put).not.toHaveBeenCalled();
});

it('durably counts a simulated crash after PUT until quiescent verified cleanup', async () => {
  const key = 'synthetic/crash/' + randomUUID();
  const reservation = await reserveStorageBytes({ accountId: owner, sha256: 'a'.repeat(64), objectKey: key, size: 7,
    kind: 'server' });
  const recoveryTime = new Date(Date.now() + 3600_000);
  const bucket = new Set([key]); // process died after PUT, before file/variant commit
  expect(await reservedStorageBytes(getDb(), owner)).toBe(7n);
  await recoverStorageByteReservations(async key => { bucket.delete(key); }, async () => false, 100, recoveryTime);
  expect(bucket.has(key)).toBe(true);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(7n);
  const failed = await recoverStorageByteReservations(async () => { throw new Error('cleanup unavailable'); }, async () => true,
    100, new Date(recoveryTime.getTime() + 5 * 60_000));
  expect(failed.failed).toBeGreaterThan(0);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(7n);
  await recoverStorageByteReservations(async key => { bucket.delete(key); expect(bucket.has(key)).toBe(false); }, async () => true, 100, new Date(recoveryTime.getTime() + 10 * 60_000));
  expect(await reservedStorageBytes(getDb(), owner)).toBe(0n);
  const [row] = await getDb().select().from(storageByteReservations).where(eq(storageByteReservations.id, reservation.id));
  expect(row.cleanedAt).not.toBeNull();
});
it('live exact claims count once and tombstones retain pending physical bytes', async () => {
  const row = original(4);
  await reserveStorageBytes({ accountId: owner, sha256: row.sha256, objectKey: row.storageKey, size: 4, kind: 'server' });
  const file = await insertFile(row);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(4n);
  await updateFile(file.id, { status: 'deleted' });
  expect(await reservedStorageBytes(getDb(), owner)).toBe(4n);
});
it('presigned expiry/deletion cannot release bytes while a late PUT may arrive', async () => {
  const row = original(legacyStorageLimit('basic'));
  await reserveStorageBytes({ accountId: owner, sha256: row.sha256, objectKey: row.storageKey,
    size: row.size, kind: 'presigned', recoverAfter: new Date(0) });
  const file = await insertFile(row);
  await updateFile(file.id, { status: 'deleted' });
  await recoverStorageByteReservations(async () => undefined, async () => true, 100, new Date(Date.now() + 86_400_000));
  expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(legacyStorageLimit('basic')));
  await expect(insertFile(original(1))).rejects.toMatchObject({ code: 'STORAGE_QUOTA_EXCEEDED' });
});

it('rechecks presigned promotion after a recovery candidate waits for its hash lock', async () => {
  const reservation = await reserveStorageBytes({ accountId: owner, sha256: 'c'.repeat(64),
    objectKey: 'synthetic/renew/' + randomUUID(), size: 2, kind: 'server', recoverAfter: new Date(0) });
  const remove = jest.fn(async () => undefined);
  let recovery: ReturnType<typeof recoverStorageByteReservations> | undefined;
  await getDb().transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'oxy:files:sha256:' + reservation.sha256}, 0))`);
    recovery = recoverStorageByteReservations(remove, async () => true, 100);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await getDb().execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted limit 1`);
      if (rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    // Even an already elapsed timestamp must not turn a promoted URL into a server-only cleanup target.
    await tx.update(storageByteReservations).set({ kind: 'presigned', recoverAfter: new Date(0) })
      .where(eq(storageByteReservations.id, reservation.id));
  });
  await recovery;
  expect(remove).not.toHaveBeenCalledWith(reservation.objectKey);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(2n);
});

it('configured visibility relocation fails before copy and before changing privacy metadata', async () => {
  const { AssetService } = await import('../assetService');
  const file = await insertFile(original(1));
  const s3 = { copyFile: jest.fn(async () => undefined), fileExists: jest.fn(async () => true) };
  const service = new AssetService(s3 as unknown as import('../s3Service').S3Service);
  await expect(service.updateFileVisibility(file.id, 'public')).rejects.toMatchObject({ code: 'STORAGE_PHYSICAL_PATH_UNAVAILABLE' });
  expect(s3.copyFile).not.toHaveBeenCalled();
  const [unchanged] = await getDb().select().from(files).where(eq(files.id, file.id));
  expect(unchanged.visibility).toBe('private');
});

it('recovers an orphan beyond more than one batch of older live claims', async () => {
  const liveKeys: string[] = [];
  for (let i = 0; i < 26; i++) {
    const row = original(1);
    await reserveStorageBytes({ accountId: owner, sha256: row.sha256, objectKey: row.storageKey,
      size: row.size, kind: 'server', recoverAfter: new Date(0) });
    await insertFile(row);
    liveKeys.push(row.storageKey);
  }
  const orphan = await reserveStorageBytes({ accountId: owner, sha256: 'd'.repeat(64),
    objectKey: 'synthetic/later-orphan/' + randomUUID(), size: 7, kind: 'server', recoverAfter: new Date(1) });
  const bucket = new Set([...liveKeys, orphan.objectKey]);
  const remove = jest.fn(async (key: string) => { bucket.delete(key); expect(bucket.has(key)).toBe(false); });
  const quiescent = jest.fn(async () => true);
  expect(await recoverStorageByteReservations(remove, quiescent, 25, new Date(2))).toEqual({ cleaned: 1, retained: 0, failed: 0, backoffFailed: 0 });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith(orphan.objectKey);
  expect(quiescent).toHaveBeenCalledTimes(1);
  expect(liveKeys.every(key => bucket.has(key))).toBe(true);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(26n);
});

it('concurrent identical owner streams reuse the last four quota bytes without reserving a losing key', async () => {
  const { AssetService } = await import('../assetService');
  let releasePut!: () => void, startedPut!: () => void;
  const blockedPut = new Promise<void>(resolve => { releasePut = resolve; });
  const putStarted = new Promise<void>(resolve => { startedPut = resolve; });
  const bucket = new Map<string, Buffer>();
  const s3 = {
    uploadStream: jest.fn(async (key: string, source: Readable) => {
      const chunks: Buffer[] = []; for await (const chunk of source) chunks.push(Buffer.from(chunk));
      startedPut();
      await blockedPut;
      bucket.set(key, Buffer.concat(chunks));
    }),
    deleteFile: jest.fn(async (key: string) => { bucket.delete(key); }),
    fileExists: jest.fn(async (key: string) => bucket.has(key)),
  };
  const service = new AssetService(s3 as unknown as import('../s3Service').S3Service);
  await insertFile(original(legacyStorageLimit('basic') - 4));
  const first = service.uploadUserMediaStream(Readable.from(Buffer.from('same')), 'text/plain', 'same.txt', 100, owner);
  await putStarted;
  const second = service.uploadUserMediaStream(Readable.from(Buffer.from('same')), 'text/plain', 'same.txt', 100, owner);
  let waiting = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await getDb().execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted limit 1`);
      if (rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { releasePut(); }
  const [firstFile, secondFile] = await Promise.all([first, second]);
  expect(waiting).toBe(true); // second pre-lock read missed the first uncommitted row
  expect(secondFile.id).toBe(firstFile.id);
  expect(s3.uploadStream).toHaveBeenCalledTimes(1);
  expect(s3.deleteFile).not.toHaveBeenCalled();
  expect(bucket.size).toBe(1);
  expect(await getDb().select().from(files).where(eq(files.ownerUserId, owner))).toHaveLength(2);
  const holds = await getDb().select().from(storageByteReservations).where(eq(storageByteReservations.accountId, owner));
  expect(holds.filter(row => !row.cleanedAt)).toHaveLength(1);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(legacyStorageLimit('basic')));
});

it('defers a full batch of unquiescent holds so the next bounded run reaches a safe orphan', async () => {
  const blocked: string[] = [];
  for (let i = 0; i < 2; i++) {
    const row = await reserveStorageBytes({ accountId: owner, sha256: 'e'.repeat(64),
      objectKey: 'synthetic/unquiescent/' + randomUUID(), size: 2, kind: 'server', recoverAfter: new Date(0) });
    blocked.push(row.objectKey);
  }
  const safe = await reserveStorageBytes({ accountId: owner, sha256: 'f'.repeat(64),
    objectKey: 'synthetic/safe/' + randomUUID(), size: 3, kind: 'server', recoverAfter: new Date(1) });
  const remove = jest.fn(async () => undefined);
  const quiescent = jest.fn(async (row: typeof storageByteReservations.$inferSelect) => row.objectKey === safe.objectKey);
  expect(await recoverStorageByteReservations(remove, quiescent, 2, new Date(2)))
    .toEqual({ cleaned: 0, retained: 2, failed: 0, backoffFailed: 0 });
  expect(await recoverStorageByteReservations(remove, quiescent, 2, new Date(2)))
    .toEqual({ cleaned: 1, retained: 0, failed: 0, backoffFailed: 0 });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledWith(safe.objectKey);
  const rows = await getDb().select().from(storageByteReservations).where(eq(storageByteReservations.accountId, owner));
  const deferred = rows.filter(row => blocked.includes(row.objectKey));
  expect(deferred.every(row => !row.cleanedAt && row.retryAfter && row.retryAfter > new Date(2))).toBe(true);
  expect(deferred.every(row => row.recoverAfter.getTime() === 0)).toBe(true); // retry does not revive upload admission
  expect(await reservedStorageBytes(getDb(), owner)).toBe(4n);
});
it.each([5 * 60_000 + 1, 10 * 60_000])(
  'rotates a blocked full batch behind safe holds when the next run advances %i ms', async (elapsed) => {
    for (let i = 0; i < 2; i++) await reserveStorageBytes({ accountId: owner, sha256: '3'.repeat(64),
      objectKey: 'synthetic/cadence-blocked/' + randomUUID(), size: 2, kind: 'server', recoverAfter: new Date(0) });
    const safe = await reserveStorageBytes({ accountId: owner, sha256: '4'.repeat(64),
      objectKey: 'synthetic/cadence-safe/' + randomUUID(), size: 3, kind: 'server', recoverAfter: new Date(1) });
    const remove = jest.fn(async () => undefined);
    const quiescent = jest.fn(async (row: typeof storageByteReservations.$inferSelect) => row.objectKey === safe.objectKey);
    const firstRun = new Date(2), nextRun = new Date(2 + elapsed);
    expect(await recoverStorageByteReservations(remove, quiescent, 2, firstRun))
      .toEqual({ cleaned: 0, retained: 2, failed: 0, backoffFailed: 0 });
    // Both older blocked rows are eligible again; the new order must rotate them,
    // rather than relying on another run before their retry delay expires.
    expect(await recoverStorageByteReservations(remove, quiescent, 2, nextRun))
      .toEqual({ cleaned: 1, retained: 1, failed: 0, backoffFailed: 0 });
    expect(remove).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledWith(safe.objectKey);
    const rows = await getDb().select().from(storageByteReservations).where(eq(storageByteReservations.accountId, owner));
    const blocked = rows.filter(row => row.id !== safe.id);
    expect(blocked.every(row => row.cleanedAt === null && row.recoverAfter.getTime() === 0)).toBe(true);
    expect(await reservedStorageBytes(getDb(), owner)).toBe(4n);
  },
);

it('isolates a failed delete and cleans the later safe candidate without releasing failed bytes', async () => {
  const failed = await reserveStorageBytes({ accountId: owner, sha256: '1'.repeat(64),
    objectKey: 'synthetic/delete-failure/' + randomUUID(), size: 2, kind: 'server', recoverAfter: new Date(3) });
  const safe = await reserveStorageBytes({ accountId: owner, sha256: '2'.repeat(64),
    objectKey: 'synthetic/delete-success/' + randomUUID(), size: 3, kind: 'server', recoverAfter: new Date(4) });
  const remove = jest.fn(async (key: string) => { if (key === failed.objectKey) throw new Error('synthetic delete failure'); });
  expect(await recoverStorageByteReservations(remove, async () => true, 2, new Date(5)))
    .toEqual({ cleaned: 1, retained: 1, failed: 1, backoffFailed: 0 });
  expect(remove).toHaveBeenCalledWith(safe.objectKey);
  const [retained] = await getDb().select().from(storageByteReservations).where(eq(storageByteReservations.id, failed.id));
  expect(retained.cleanedAt).toBeNull();
  expect(retained.retryAfter!.getTime()).toBeGreaterThan(5);
  expect(retained.recoverAfter.getTime()).toBe(3);
  expect(await reservedStorageBytes(getDb(), owner)).toBe(2n);
});

it('coalesces identical last-byte uploads in the committed-reservation gap before PUT lock acquisition', async () => {
  const { AssetService } = await import('../assetService');
  const locks = await import('../contentHashLock');
  const realLock = locks.withContentHashLock;
  const hash = createHash('sha256').update('gap!').digest('hex');
  let releaseGap!: () => void, gapReached!: () => void, pendingSeen!: () => void;
  const gap = new Promise<void>(resolve => { releaseGap = resolve; });
  const reached = new Promise<void>(resolve => { gapReached = resolve; });
  const pending = new Promise<void>(resolve => { pendingSeen = resolve; });
  let calls = 0;
  const spy = jest.spyOn(locks, 'withContentHashLock').mockImplementation(async function<T>(
    sha: string, callback: (tx: import('../../config/postgres').Transaction) => Promise<T>,
  ): Promise<T> {
    const ordinal = sha === hash ? ++calls : 0;
    if (ordinal === 2) { gapReached(); await gap; } // reservation transaction has COMMITTED, PUT transaction not started
    const result = await realLock(sha, callback);
    if (ordinal > 2 && (result as { kind?: string })?.kind === 'pending') pendingSeen();
    return result;
  });
  const bucket = new Map<string, Buffer>();
  const s3 = {
    uploadStream: jest.fn(async (key: string, source: Readable) => {
      const chunks: Buffer[] = []; for await (const chunk of source) chunks.push(Buffer.from(chunk));
      bucket.set(key, Buffer.concat(chunks));
    }),
    deleteFile: jest.fn(async (key: string) => { bucket.delete(key); }),
    fileExists: jest.fn(async (key: string) => bucket.has(key)),
  };
  await insertFile(original(legacyStorageLimit('basic') - 4));
  const service = new AssetService(s3 as unknown as import('../s3Service').S3Service);
  const first = service.uploadUserMediaStream(Readable.from(Buffer.from('gap!')), 'text/plain', 'gap.txt', 100, owner);
  await reached;
  const second = service.uploadUserMediaStream(Readable.from(Buffer.from('gap!')), 'text/plain', 'gap.txt', 100, owner);
  try {
    await Promise.race([pending, second.then(() => { throw new Error('Second upload finished before gap resumed'); })]);
    expect(s3.uploadStream).not.toHaveBeenCalled();
    expect(await getDb().select().from(files).where(eq(files.ownerUserId, owner))).toHaveLength(1);
    expect(await getDb().select().from(storageByteReservations).where(eq(storageByteReservations.accountId, owner))).toHaveLength(1);
    expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(legacyStorageLimit('basic')));
  } finally { releaseGap(); }
  try {
    const [one, two] = await Promise.all([first, second]);
    expect(one.id).toBe(two.id);
    expect(s3.uploadStream).toHaveBeenCalledTimes(1);
    expect(s3.deleteFile).not.toHaveBeenCalled();
    expect(bucket.size).toBe(1);
    expect(await reservedStorageBytes(getDb(), owner)).toBe(BigInt(legacyStorageLimit('basic')));
  } finally { spy.mockRestore(); }
});
