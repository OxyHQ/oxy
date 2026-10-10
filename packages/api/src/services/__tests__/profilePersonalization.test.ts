import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { billingSubscriptions, subscriptions, users } from '../../db/schema';
import { randomUUID } from 'node:crypto';
import {
  EMPTY_PRODUCT_BILLING_CATALOGUE,
  type ProductBillingCatalogue,
} from '../productBillingCatalogue.service';
let mockCatalogue: ProductBillingCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
let mockUnavailable = false;
jest.mock('../productBillingCatalogue.service', () => ({
  ...jest.requireActual('../productBillingCatalogue.service'),
  loadProductBillingCatalogue: () =>
    mockUnavailable
      ? Promise.reject(new Error('Synthetic unavailable configuration'))
      : Promise.resolve(mockCatalogue),
}));
import { productAccessFixture, accessAccount } from '../__fixtures__/productAccessFixtures';
import {
  recordProductAccessPeriod,
  revokeProductAccessGrant,
  readSubjectProductGrantSnapshot,
} from '../productAccessPersistence.service';
import { readProfilePersonalization } from '../profilePersonalization.service';
import { userService } from '../user.service';
beforeAll(connectPostgres);
afterAll(closePostgres);
afterEach(() => {
  mockCatalogue = EMPTY_PRODUCT_BILLING_CATALOGUE;
  mockUnavailable = false;
});
it('free ordinary themes remain available; direct mono/alias/reserved writes cannot bypass gates', async () => {
  const id = await accessAccount();
  await userService.updateUserProfile(id, {
    themePreference: { mode: 'dark', colorPreset: ' Blue ' },
  });
  for (const preset of ['mono', 'monochrome', 'oxy'])
    for (const update of [
      { color: preset },
      { themePreference: { mode: 'dark', colorPreset: preset } },
    ])
      await expect(userService.updateUserProfile(id, update)).rejects.toMatchObject({
        statusCode: 400,
      });
  expect((await readProfilePersonalization(id)).mentionMono.allowed).toBe(false);
});
it('configured capability grants mono only to its subject; revocation/expiry removes permission', async () => {
  const f = await productAccessFixture();
  await recordProductAccessPeriod(f.input());
  mockCatalogue = {
    ...EMPTY_PRODUCT_BILLING_CATALOGUE,
    products: f.products,
    personalizationAdapter: { productId: f.products[0].id, capabilityKey: 'use' },
  };
  expect((await readProfilePersonalization(f.beneficiary)).mentionMono.allowed).toBe(true);
  expect((await readProfilePersonalization(f.payer)).mentionMono.allowed).toBe(false);
  await userService.updateUserProfile(f.beneficiary, {
    color: ' MONO ',
    themePreference: { mode: 'dark', colorPreset: ' MONO ' },
  });
  await expect(
    userService.updateUserProfile(f.beneficiary, {
      themePreference: { mode: 'dark', colorPreset: 'oxy' },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  const snapshot = await readSubjectProductGrantSnapshot(f.beneficiary, f.products[0].id);
  await revokeProductAccessGrant({
    grantId: snapshot.grants[0].id,
    productId: f.products[0].id,
    revokedAt: new Date(),
  });
  expect((await readProfilePersonalization(f.beneficiary)).mentionMono.allowed).toBe(false);
  await expect(
    userService.updateUserProfile(f.beneficiary, {
      themePreference: { mode: 'dark', colorPreset: 'mono' },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
  await recordProductAccessPeriod(f.input());
  expect(
    (await readProfilePersonalization(f.beneficiary, new Date(Date.parse(f.period.end) + 1)))
      .mentionMono.allowed,
  ).toBe(false);
  mockCatalogue = {
    ...mockCatalogue,
    personalizationAdapter: { productId: f.products[1].id, capabilityKey: 'not_granted' },
  };
  expect((await readProfilePersonalization(f.beneficiary)).mentionMono.allowed).toBe(false);
});
it('individual mono allowance expires at its actual period end', async () => {
  const id = await accessAccount(),
    tag = randomUUID();
  await getDb()
    .insert(billingSubscriptions)
    .values({
      userId: id,
      stripeCustomerId: `cus_${tag}`,
      stripeSubscriptionId: `sub_${tag}`,
      stripePriceId: `price_${tag}`,
      status: 'active',
      currentPeriodStart: new Date(Date.now() - 1000),
      currentPeriodEnd: new Date(Date.now() + 60000),
      planName: 'pro',
      planCreditsPerMonth: 1,
      planPriceMinorUnits: 1,
    });
  expect((await readProfilePersonalization(id)).mentionMono.allowed).toBe(true);
  mockUnavailable = true;
  expect((await readProfilePersonalization(id)).mentionMono.allowed).toBe(true);
  mockUnavailable = false;
  await userService.updateUserProfile(id, { color: 'mono' });
  await getDb()
    .update(billingSubscriptions)
    .set({ currentPeriodEnd: new Date(Date.now() - 1) })
    .where(eq(billingSubscriptions.userId, id));
  expect((await readProfilePersonalization(id)).mentionMono.allowed).toBe(false);
  const [stored] = await getDb().select().from(users).where(eq(users.id, id));
  expect(stored.color).toBe('mono');
});

it('future individual billing and legacy periods grant no early mono access', async () => {
  const id = await accessAccount(),
    tag = randomUUID();
  await getDb()
    .insert(billingSubscriptions)
    .values({
      userId: id,
      stripeCustomerId: `cus_${tag}`,
      stripeSubscriptionId: `sub_${tag}`,
      stripePriceId: `price_${tag}`,
      status: 'active',
      currentPeriodStart: new Date(Date.now() + 60000),
      currentPeriodEnd: new Date(Date.now() + 120000),
      planName: 'pro',
      planCreditsPerMonth: 1,
      planPriceMinorUnits: 1,
    });
  expect((await readProfilePersonalization(id)).mentionMono.allowed).toBe(false);
  const other = await accessAccount();
  await getDb()
    .insert(subscriptions)
    .values({
      userId: other,
      plan: 'pro',
      status: 'active',
      startDate: new Date(Date.now() + 60000),
      endDate: new Date(Date.now() + 120000),
    });
  expect((await readProfilePersonalization(other)).mentionMono.allowed).toBe(false);
});
