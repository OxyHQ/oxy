import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { files } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import { EMPTY_PRODUCT_BILLING_CATALOGUE, type ProductBillingCatalogue } from '../productBillingCatalogue.service';
import { insertFile, updateFile, upsertVariant } from '../fileRepository';
import { storageCapacity, reservedStorageBytes, legacyStorageLimit } from '../storageQuota.service';
let mockCatalogue: ProductBillingCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
jest.mock('../productBillingCatalogue.service', () => ({
  ...jest.requireActual('../productBillingCatalogue.service'),
  loadProductBillingCatalogue: () => Promise.resolve(mockCatalogue),
}));
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
