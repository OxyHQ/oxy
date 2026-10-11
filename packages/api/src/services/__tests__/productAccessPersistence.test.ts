import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isCheckViolation, isForeignKeyViolation } from '@oxy.so/db';
import { productOfferSchema } from '@oxy.so/contracts';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import {
  applications,
  users,
  accessGrants,
  accessSubscriptionSources,
  accessOfferSegments,
  accessOfferBenefits,
  accessOffers,
} from '../../db/schema';
import {
  recordProductAccessPeriod,
  registerProductAccessConfiguration,
  reconcileProductAccessFinancialState,
  readSubjectProductAccess,
  updateProductAccessSourceState,
  revokeProductAccessGrant,
} from '../productAccessPersistence.service';
import { planProductAccessMapping } from '../productAccessMapping';
import { productAccessFixture as fixture } from '../__fixtures__/productAccessFixtures';

jest.setTimeout(60_000);
beforeAll(connectPostgres);
afterAll(closePostgres);
async function rejected(operation: Promise<unknown>, predicate: (error: unknown) => boolean) {
  try {
    await operation;
    throw new Error('expected rejection');
  } catch (error) {
    expect(predicate(error)).toBe(true);
  }
}
it('persists two products for a bot beneficiary distinct from payer without financial disclosure', async () => {
  const f = await fixture();
  expect((await recordProductAccessPeriod(f.input())).grantIds).toHaveLength(2);
  for (const p of f.products) {
    const answer = await readSubjectProductAccess(f.beneficiary, p.id);
    expect(answer.capabilities).toHaveLength(1);
    expect(JSON.stringify(answer)).not.toMatch(/payer|provider|price|balance/);
    expect((await readSubjectProductAccess(f.payer, p.id)).capabilities).toEqual([]);
  }
});
it('identical concurrent deliveries persist one immutable segment/grant set', async () => {
  const f = await fixture();
  const input = f.input();
  const rows = await Promise.all([
    recordProductAccessPeriod(input),
    recordProductAccessPeriod(input),
  ]);
  expect(rows.map((row) => row.status).sort()).toEqual(['recorded', 'replayed']);
  expect(
    await getDb()
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.sourceSegmentId, input.segment.id)),
  ).toHaveLength(2);
});
it('missing offer config fails before source insertion or award', async () => {
  const f = await fixture();
  const input = f.input();
  input.segment.offerId = randomUUID();
  await expect(recordProductAccessPeriod(input)).rejects.toMatchObject({
    code: 'PRODUCT_ACCESS_NOT_CONFIGURED',
  });
  expect(
    await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(eq(accessSubscriptionSources.id, input.source.id)),
  ).toEqual([]);
});
it('test/staging/missing provider binding cannot create a live source', async () => {
  const f = await fixture();
  const input = f.input();
  for (const binding of [
    { ...f.providerBinding, mode: 'test' },
    { ...f.providerBinding, environment: 'staging' },
    {},
  ]) {
    await expect(
      recordProductAccessPeriod({ ...input, providerBinding: binding as typeof f.providerBinding }),
    ).rejects.toThrow();
  }
  expect(
    await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(eq(accessSubscriptionSources.id, input.source.id)),
  ).toEqual([]);
});
it('replay rejects another provider account binding without replacing source or grants', async () => {
  const f = await fixture();
  const input = f.input();
  await recordProductAccessPeriod(input);
  await expect(
    recordProductAccessPeriod({
      ...input,
      providerBinding: { ...f.providerBinding, providerAccountRef: 'different' },
    }),
  ).rejects.toThrow('replay payload');
  const [source] = await getDb()
    .select()
    .from(accessSubscriptionSources)
    .where(eq(accessSubscriptionSources.id, input.source.id));
  expect(source.providerAccountRef).toBe(f.providerBinding.providerAccountRef);
});
it('canceling a named individual source preserves the bundle and the other product', async () => {
  const f = await fixture();
  const bundle = f.input();
  const individual = f.input(f.offers[1]);
  await recordProductAccessPeriod(bundle);
  await recordProductAccessPeriod(individual);
  const change = {
    sourceId: individual.source.id,
    productId: f.products[0].id,
    status: 'canceled' as const,
    period: f.period,
    cancelAtPeriodEnd: false,
    providerObservedAt: new Date(f.now.getTime() + 1),
    providerBinding: f.providerBinding,
  };
  await expect(
    updateProductAccessSourceState({ ...change, productId: f.products[1].id }),
  ).rejects.toThrow('does not supply');
  await updateProductAccessSourceState(change);
  for (const p of f.products)
    expect(
      (await readSubjectProductAccess(f.beneficiary, p.id)).capabilities[0].grantIds,
    ).toHaveLength(1);
});
it('observation ties replay identical state but reject conflicting state, and older observations are stale', async () => {
  const f = await fixture();
  const input = f.input();
  await recordProductAccessPeriod(input);
  const change = {
    sourceId: input.source.id,
    productId: f.products[0].id,
    status: 'active' as const,
    period: f.period,
    cancelAtPeriodEnd: false,
    providerObservedAt: f.now,
    providerBinding: f.providerBinding,
  };
  expect(await updateProductAccessSourceState(change)).toBe('replayed');
  await expect(updateProductAccessSourceState({ ...change, status: 'canceled' })).rejects.toThrow(
    'replay payload',
  );
  expect(
    await updateProductAccessSourceState({
      ...change,
      providerObservedAt: new Date(f.now.getTime() - 1),
    }),
  ).toBe('stale');
});
it('old segments and replay survive a renewal without rewriting their original period', async () => {
  const f = await fixture();
  const first = f.input();
  await recordProductAccessPeriod(first);
  const later = {
    start: f.period.end,
    end: new Date(Date.parse(f.period.end) + 86_400_000).toISOString(),
  };
  await updateProductAccessSourceState({
    sourceId: first.source.id,
    productId: f.products[0].id,
    status: 'active',
    period: later,
    cancelAtPeriodEnd: false,
    providerObservedAt: new Date(f.now.getTime() + 1),
    providerBinding: f.providerBinding,
  });
  const renewal = {
    ...first,
    source: { ...first.source, period: later },
    segment: { ...first.segment, id: randomUUID(), period: later },
    providerObservedAt: new Date(f.now.getTime() + 1),
  };
  await recordProductAccessPeriod(renewal);
  expect((await recordProductAccessPeriod(first)).status).toBe('replayed');
  const [stored] = await getDb()
    .select()
    .from(accessOfferSegments)
    .where(eq(accessOfferSegments.id, first.segment.id));
  expect(stored.periodStart.toISOString()).toBe(f.period.start);
});
it('PostgreSQL rejects rewriting source parties, frozen segments and grant provenance or deletion', async () => {
  const f = await fixture();
  const input = f.input();
  const result = await recordProductAccessPeriod(input);
  await rejected(
    getDb()
      .update(accessSubscriptionSources)
      .set({ payerAccountId: f.beneficiary, providerObservedAt: new Date(f.now.getTime() + 1) })
      .where(eq(accessSubscriptionSources.id, input.source.id)),
    isCheckViolation,
  );
  await rejected(
    getDb()
      .update(accessOfferSegments)
      .set({ offerVersion: 2 })
      .where(eq(accessOfferSegments.id, input.segment.id)),
    isCheckViolation,
  );
  await rejected(
    getDb()
      .update(accessGrants)
      .set({ beneficiaryAccountId: f.payer })
      .where(eq(accessGrants.id, result.grantIds[0])),
    isCheckViolation,
  );
  await rejected(
    getDb().delete(accessGrants).where(eq(accessGrants.id, result.grantIds[0])),
    isCheckViolation,
  );
});
it('PostgreSQL rejects a grant beyond its segment and a forged beneficiary via composite FK', async () => {
  const f = await fixture();
  const input = f.input();
  await recordProductAccessPeriod(input);
  const values = {
    id: randomUUID(),
    sourceSegmentId: input.segment.id,
    beneficiaryAccountId: f.beneficiary,
    offerId: input.segment.offerId,
    offerVersion: 1,
    origin: 'bundle' as const,
    benefitIndex: 0,
    productId: f.products[0].id,
    periodStart: new Date(f.period.start),
    periodEnd: new Date(Date.parse(f.period.end) + 1),
  };
  await rejected(getDb().insert(accessGrants).values(values), isCheckViolation);
  const [original] = await getDb()
    .select()
    .from(accessOfferSegments)
    .where(eq(accessOfferSegments.id, input.segment.id));
  const emptySegmentId = randomUUID();
  await getDb()
    .insert(accessOfferSegments)
    .values({ ...original, id: emptySegmentId });
  await rejected(
    getDb()
      .insert(accessGrants)
      .values({
        ...values,
        id: randomUUID(),
        sourceSegmentId: emptySegmentId,
        beneficiaryAccountId: f.payer,
        periodEnd: new Date(f.period.end),
      }),
    isForeignKeyViolation,
  );
});
it('one-way revocation reaches only the named product/grant', async () => {
  const f = await fixture();
  const result = await recordProductAccessPeriod(f.input());
  expect(
    await revokeProductAccessGrant({
      grantId: result.grantIds[0],
      productId: f.products[1].id,
      revokedAt: new Date(),
    }),
  ).toBe(false);
  expect(
    await revokeProductAccessGrant({
      grantId: result.grantIds[0],
      productId: f.products[0].id,
      revokedAt: new Date(),
    }),
  ).toBe(true);
  expect((await readSubjectProductAccess(f.beneficiary, f.products[0].id)).capabilities).toEqual(
    [],
  );
  expect(
    (await readSubjectProductAccess(f.beneficiary, f.products[1].id)).capabilities,
  ).toHaveLength(1);
  await rejected(
    getDb()
      .update(accessGrants)
      .set({ revokedAt: null })
      .where(eq(accessGrants.id, result.grantIds[0])),
    isCheckViolation,
  );
});
it('application transfer fails closed without reinterpreting the frozen product', async () => {
  const f = await fixture();
  await recordProductAccessPeriod(f.input());
  await getDb()
    .update(applications)
    .set({ ownerAccountId: f.payer })
    .where(eq(applications.id, f.app.id));
  await expect(readSubjectProductAccess(f.beneficiary, f.products[0].id)).rejects.toMatchObject({
    code: 'PRODUCT_ACCESS_NOT_CONFIGURED',
  });
  await expect(recordProductAccessPeriod(f.input())).rejects.toMatchObject({
    code: 'PRODUCT_ACCESS_NOT_CONFIGURED',
  });
});
it('individual offers reject cross-product append at the database boundary', async () => {
  const f = await fixture();
  const input = f.input(f.offers[1]);
  await recordProductAccessPeriod(input);
  await rejected(
    getDb().insert(accessOfferBenefits).values({
      offerId: f.offers[1].id,
      offerVersion: 1,
      benefitIndex: 1,
      productId: f.products[1].id,
      kind: 'capability',
      key: 'unexpected',
    }),
    isCheckViolation,
  );
  expect(
    (await readSubjectProductAccess(f.beneficiary, f.products[0].id)).capabilities,
  ).toHaveLength(1);
});
it('incomplete sealed configuration cannot admit a source or grant; negative count is rejected', async () => {
  const f = await fixture();
  const input = f.input(f.offers[1]);
  input.segment.offerId = randomUUID();
  await getDb()
    .insert(accessOffers)
    .values({ id: input.segment.offerId, version: 1, kind: 'individual', expectedBenefitCount: 2 });
  await getDb().insert(accessOfferBenefits).values({
    offerId: input.segment.offerId,
    offerVersion: 1,
    benefitIndex: 0,
    productId: f.products[0].id,
    kind: 'capability',
    key: 'use',
  });
  await expect(recordProductAccessPeriod(input)).rejects.toMatchObject({
    code: 'PRODUCT_ACCESS_NOT_CONFIGURED',
  });
  expect(
    await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(eq(accessSubscriptionSources.id, input.source.id)),
  ).toEqual([]);
  await rejected(
    getDb()
      .insert(accessOffers)
      .values({ id: randomUUID(), version: 1, kind: 'bundle', expectedBenefitCount: -1 }),
    isCheckViolation,
  );
});
it('sealed offer rejects same-product append before and after its first segment; replay IDs all exist', async () => {
  const f = await fixture();
  const input = f.input(f.offers[1]);
  const append = () =>
    getDb().insert(accessOfferBenefits).values({
      offerId: input.segment.offerId,
      offerVersion: 1,
      benefitIndex: 1,
      productId: f.products[0].id,
      kind: 'capability',
      key: 'extra',
    });
  await rejected(append(), isCheckViolation);
  const original = await recordProductAccessPeriod(input);
  await rejected(append(), isCheckViolation);
  const replay = await recordProductAccessPeriod(input);
  expect(replay.grantIds).toEqual(original.grantIds);
  const stored = await getDb()
    .select()
    .from(accessGrants)
    .where(eq(accessGrants.sourceSegmentId, input.segment.id));
  expect(replay.grantIds.sort()).toEqual(stored.map((row) => row.id).sort());
  const next = await recordProductAccessPeriod(f.input(f.offers[1]));
  expect(next.grantIds).toHaveLength(1);
  expect(
    (await readSubjectProductAccess(f.beneficiary, f.products[0].id)).capabilities.map(
      (row) => row.key,
    ),
  ).toEqual(['use']);
});
it('dry-run requires exact provider account/price/parties and reports ambiguity without any award', async () => {
  const f = await fixture();
  const row = {
    rowId: randomUUID(),
    provider: 'stripe' as const,
    ...f.providerBinding,
    providerSubscriptionId: 'synthetic-ref',
    providerPriceId: 'price-synthetic',
    beneficiaryAccountId: f.beneficiary,
    payerAccountId: f.payer,
  };
  const mapping = { ...row, offerId: f.offers[0].id, offerVersion: 1 };
  const base = { rows: [row], products: f.products, offers: f.offers };
  expect(planProductAccessMapping({ ...base, mappings: [] })[0].status).toBe('unmapped');
  expect(planProductAccessMapping({ ...base, mappings: [mapping, mapping] })[0].status).toBe(
    'ambiguous',
  );
  expect(
    planProductAccessMapping({
      ...base,
      mappings: [{ ...mapping, payerAccountId: f.beneficiary }],
    })[0].status,
  ).toBe('unmapped');
  expect(
    planProductAccessMapping({
      ...base,
      products: [...f.products, { ...f.products[0], ownerAccountId: f.payer }],
      mappings: [mapping],
    })[0].status,
  ).toBe('invalid_configuration');
  expect(planProductAccessMapping({ ...base, mappings: [mapping] })[0]).toMatchObject({
    status: 'mapped',
    productIds: f.products.map((p) => p.id).sort(),
  });
  expect(
    await getDb()
      .select()
      .from(accessSubscriptionSources)
      .where(eq(accessSubscriptionSources.beneficiaryAccountId, f.beneficiary)),
  ).toEqual([]);
});
it('missing quota rule rejects explicitly rather than choosing a commercial default', async () => {
  const f = await fixture();
  expect(
    productOfferSchema.safeParse({
      ...f.offers[0],
      benefits: [
        { kind: 'quota', productId: f.products[0].id, key: 'quota', unit: 'units', included: 1 },
      ],
    }).success,
  ).toBe(false);
});

it('compares every frozen quota field at the write boundary without changing the generic writer contract', async () => {
  const f = await fixture();
  const offer = productOfferSchema.parse({
    ...f.offers[1],
    id: randomUUID(),
    benefits: [
      {
        kind: 'quota',
        productId: f.products[0].id,
        key: 'storage',
        unit: 'byte',
        included: 100,
        combination: 'maximum',
      },
    ],
  });
  await registerProductAccessConfiguration({ products: [], offers: [offer] });
  for (const change of [{ included: 101 }, { unit: 'gigabyte' }, { combination: 'sum' }]) {
    const input = f.input(offer);
    const expected = productOfferSchema.parse({
      ...offer,
      benefits: [{ ...offer.benefits[0], ...change }],
    });
    await expect(
      recordProductAccessPeriod({
        ...input,
        expectedConfiguration: { products: [f.products[0]], offer: expected },
      }),
    ).rejects.toThrow('differs');
    expect(
      await getDb()
        .select()
        .from(accessSubscriptionSources)
        .where(eq(accessSubscriptionSources.id, input.source.id)),
    ).toEqual([]);
  }
  expect(
    (
      await recordProductAccessPeriod({
        ...f.input(offer),
        expectedConfiguration: { products: [f.products[0]], offer },
      })
    ).grantIds,
  ).toHaveLength(1);
});
it('financial maintenance binds every immutable identity, preserves closure history and ignores older observations', async () => {
  const f = await fixture();
  const input = f.input();
  await recordProductAccessPeriod(input);
  const maintenance = {
    sourceId: input.source.id,
    beneficiaryAccountId: f.beneficiary,
    payerAccountId: f.payer,
    provider: input.source.provider,
    providerSubscriptionId: input.source.providerSubscriptionId,
    providerBinding: input.providerBinding,
    providerObservedAt: new Date(f.now.getTime() + 1000),
    status: input.source.status,
    period: input.source.period,
    cancelAtPeriodEnd: true,
  };
  for (const change of [
    { payerAccountId: f.owner },
    { beneficiaryAccountId: f.owner },
    { providerSubscriptionId: 'other' },
    { providerBinding: { ...input.providerBinding, providerAccountRef: 'other' } },
  ]) {
    await expect(
      reconcileProductAccessFinancialState({ ...maintenance, ...change }),
    ).rejects.toThrow('differs');
  }
  await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, f.payer));
  expect(await reconcileProductAccessFinancialState(maintenance)).toBe('updated');
  expect(
    await reconcileProductAccessFinancialState({
      ...maintenance,
      providerObservedAt: f.now,
      cancelAtPeriodEnd: false,
    }),
  ).toBe('stale');
  const [stored] = await getDb()
    .select()
    .from(accessSubscriptionSources)
    .where(eq(accessSubscriptionSources.id, input.source.id));
  expect(stored.cancelAtPeriodEnd).toBe(true);
  expect(
    await getDb()
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.sourceSegmentId, input.segment.id)),
  ).toHaveLength(2);
});
