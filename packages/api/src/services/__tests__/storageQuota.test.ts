import { Readable } from 'stream';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
  expect(await reservedStorageBytes(getDb(), owner)).toBe(1n);
});
it('does not replace or orphan an existing admitted variant', async () => {
  const file = await insertFile(original(1));
  await upsertVariant(file.id, { type: 'existing', key: 'synthetic/shared', size: 2 });
  const put = jest.fn(async () => undefined);
  await expect(uploadAdmittedVariant(file, { type: 'existing', key: 'synthetic/new', size: 2 }, put, async () => undefined)).rejects.toMatchObject({ code: 'STORAGE_VARIANT_EXISTS' });
  expect(put).not.toHaveBeenCalled();
  expect(await reservedStorageBytes(getDb(), owner)).toBe(3n);
});
it('blocks unreserved owner streams/video while preserving system caches and legacy mode', async () => {
  await expect(assertPhysicalStoragePathSupported(owner, 'multipart')).rejects.toMatchObject({ code: 'STORAGE_PHYSICAL_PATH_UNAVAILABLE' });
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
