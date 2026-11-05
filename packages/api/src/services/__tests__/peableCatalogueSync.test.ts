import type { Peable } from '@peable.to/sdk';
import {
  EMPTY_PRODUCT_BILLING_CATALOGUE,
  productBillingCatalogueSchema,
} from '../productBillingCatalogue.service';
import { syncPeableCatalogue } from '../peableCatalogueSync.service';

/** The shape of the approved Mention Plus publication (oxy-infra#412). */
const catalogue = productBillingCatalogueSchema.parse({
  ...EMPTY_PRODUCT_BILLING_CATALOGUE,
  products: [
    { schemaVersion: 1, id: 'mention', ownerAccountId: 'owner', applicationId: 'mention-app' },
  ],
  offers: ['mention_plus_monthly', 'mention_plus_annual'].map((id) => ({
    schemaVersion: 1,
    id,
    version: 1,
    kind: 'individual',
    benefits: [
      { kind: 'capability', productId: 'mention', key: 'plus' },
      { kind: 'capability', productId: 'mention', key: 'mono_theme' },
    ],
  })),
  productPlans: [
    ['mention_plus_monthly', 599, 'month'],
    ['mention_plus_annual', 5750, 'year'],
  ].map(([offerId, amountMinorUnits, interval]) => ({
    productId: 'mention',
    offerId,
    offerVersion: 1,
    displayName: 'Mention Plus',
    price: {
      currency: 'USD',
      amountMinorUnits,
      interval,
      trial: 'none',
      taxTreatment: 'inclusive',
      merchantTotal: 'final',
    },
  })),
  displayNames: { products: { mention: 'Mention' }, offers: {} },
});
const target = {
  merchantId: 'merch_oxy',
  applicationId: 'billing-app',
  namespace: { mode: 'live' as const, environment: 'production' as const },
};

function orbit() {
  let counter = 0;
  const id = (prefix: string) => `${prefix}_${++counter}`;
  const products: Record<string, unknown>[] = [];
  const prices: Record<string, unknown>[] = [];
  const features: Record<string, unknown>[] = [];
  const attached: { product: string; feature: Record<string, unknown> }[] = [];
  const list = (data: unknown[]) => ({ object: 'list', data, has_more: false });
  const client = {
    merchants: {
      retrieve: jest.fn(async () => ({
        id: target.merchantId,
        oxy_app_id: target.applicationId,
        environment: 'production',
      })),
    },
    products: {
      search: jest.fn(async ({ query }: { query: string }) => {
        const offer = /'([^']+)'$/.exec(query)?.[1];
        return list(
          products.filter((p) => (p.metadata as Record<string, string>).oxy_offer === offer),
        );
      }),
      create: jest.fn(async (params: Record<string, unknown>) => {
        const row = { id: id('prod'), ...params };
        products.push(row);
        return row;
      }),
    },
    prices: {
      list: jest.fn(async ({ lookup_keys }: { lookup_keys: string[] }) =>
        list(prices.filter((p) => lookup_keys.includes(p.lookup_key as string))),
      ),
      create: jest.fn(async (params: Record<string, unknown>) => {
        const row = {
          id: id('price'),
          object: 'price',
          livemode: true,
          active: true,
          type: 'recurring',
          created: 1_790_000_000,
          ...params,
          recurring: { ...(params.recurring as object), interval_count: 1, usage_type: 'licensed' },
        };
        prices.push(row);
        return row;
      }),
    },
    entitlements: {
      features: {
        list: jest.fn(async ({ lookup_key }: { lookup_key: string }) =>
          list(features.filter((f) => f.lookup_key === lookup_key)),
        ),
        create: jest.fn(async (params: Record<string, unknown>) => {
          const row = { id: id('feat'), ...params };
          features.push(row);
          return row;
        }),
      },
      productFeatures: {
        list: jest.fn(async (product: string) =>
          list(
            attached
              .filter((a) => a.product === product)
              .map((a) => ({ entitlement_feature: a.feature })),
          ),
        ),
        attach: jest.fn(async (product: string, params: { entitlement_feature: string }) => {
          const feature = features.find((f) => f.id === params.entitlement_feature);
          if (!feature) throw new Error('no feature');
          attached.push({ product, feature });
          return {};
        }),
      },
    },
  };
  return {
    client: client as unknown as Pick<Peable, 'merchants' | 'products' | 'prices' | 'entitlements'>,
    raw: client,
    products,
    prices,
    features,
    attached,
  };
}

it('plans without writing on a dry run', async () => {
  const o = orbit();
  const result = await syncPeableCatalogue(o.client, catalogue, target, { apply: false });
  expect(result.actions).toEqual([
    'create product mention_plus_monthly@1',
    'create feature mention:plus',
    'attach mention:plus to mention_plus_monthly@1',
    'create feature mention:mono_theme',
    'attach mention:mono_theme to mention_plus_monthly@1',
    'create price mention_plus_monthly_v1 599 USD/month inclusive',
    'create product mention_plus_annual@1',
    'attach mention:plus to mention_plus_annual@1',
    'attach mention:mono_theme to mention_plus_annual@1',
    'create price mention_plus_annual_v1 5750 USD/year inclusive',
  ]);
  expect(result.prices).toEqual([]);
  for (const create of [
    o.raw.products.create,
    o.raw.prices.create,
    o.raw.entitlements.features.create,
    o.raw.entitlements.productFeatures.attach,
  ])
    expect(create).not.toHaveBeenCalled();
});

it('creates the approved rows once, shares each benefit feature, and binds them', async () => {
  const o = orbit();
  const first = await syncPeableCatalogue(o.client, catalogue, target, { apply: true });
  expect(o.products).toHaveLength(2);
  expect(o.features.map((f) => f.lookup_key)).toEqual(['mention:plus', 'mention:mono_theme']);
  expect(o.attached).toHaveLength(4);
  expect(o.prices.map((p) => [p.lookup_key, p.unit_amount, p.currency, p.tax_behavior])).toEqual([
    ['mention_plus_monthly_v1', '599', 'USD', 'inclusive'],
    ['mention_plus_annual_v1', '5750', 'USD', 'inclusive'],
  ]);
  expect(first.prices).toEqual([
    expect.objectContaining({
      provider: 'peable',
      providerAccountId: 'merch_oxy',
      offerId: 'mention_plus_monthly',
      amountMinorUnits: 599,
      currency: 'usd',
      interval: 'month',
      offerKind: 'individual',
      kind: 'existing_product',
      mode: 'live',
      environment: 'production',
    }),
    expect.objectContaining({
      offerId: 'mention_plus_annual',
      amountMinorUnits: 5750,
      interval: 'year',
    }),
  ]);
  expect(first.offers.map((offer) => offer.providerPriceId)).toEqual(
    o.prices.map((price) => price.id),
  );
  const again = await syncPeableCatalogue(o.client, catalogue, target, { apply: true });
  expect(again.actions).toEqual([]);
  expect(again.prices).toEqual(first.prices);
  expect(o.products).toHaveLength(2);
  expect(o.prices).toHaveLength(2);
});

it('refuses an existing price that differs from the approved terms', async () => {
  const o = orbit();
  await syncPeableCatalogue(o.client, catalogue, target, { apply: true });
  o.prices[0].unit_amount = '699';
  await expect(syncPeableCatalogue(o.client, catalogue, target, { apply: true })).rejects.toThrow(
    'differs from the approved offer',
  );
});

it('skips an unpriced plan and refuses another merchant', async () => {
  const o = orbit();
  const unpriced = productBillingCatalogueSchema.parse({ ...catalogue, productPlans: [] });
  expect(await syncPeableCatalogue(o.client, unpriced, target, { apply: true })).toEqual({
    actions: [],
    prices: [],
    offers: [],
  });
  o.raw.merchants.retrieve.mockResolvedValueOnce({
    id: 'merch_other',
    oxy_app_id: target.applicationId,
    environment: 'production',
  });
  await expect(syncPeableCatalogue(o.client, catalogue, target, { apply: false })).rejects.toThrow(
    'credential owner differs',
  );
});
