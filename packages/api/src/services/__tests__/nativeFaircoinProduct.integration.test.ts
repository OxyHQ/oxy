/** Explicit local acceptance: actual Peable HTTP SDK + native PG ledger/watcher →
 * Oxy durable checkout/paid evidence → parsed central product allowance snapshots.
 * External tax/FX/identity/chain remain synthetic, never provider acceptance. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Peable } from '@peable.to/sdk';
import { eq } from 'drizzle-orm';
import type { ProductOffer } from '@oxy.so/contracts';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { personalPlanCheckoutIntents, accessGrants } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import {
  registerProductAccessConfiguration,
  readSubjectProductGrantSnapshot,
} from '../productAccessPersistence.service';
import {
  productBillingCatalogueSchema,
  EMPTY_PRODUCT_BILLING_CATALOGUE,
} from '../productBillingCatalogue.service';
import { createPeablePersonalRuntime } from '../peablePersonalRuntime.service';
import {
  startPersonalPlanCheckout,
  startProductPlanCheckout,
} from '../personalPlanCheckout.service';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing native fixture value');
  return value;
}
const runner = process.env.PEABLE_NATIVE_FIXTURE_RUNNER;
const annual = process.env.PEABLE_NATIVE_ANNUAL_FIXTURE === '1';
(runner ? describe : describe.skip)(
  'native Peable SDK → central individual product and bundle',
  () => {
    let child: ChildProcessWithoutNullStreams;
    let sequence = 0;
    const pending = new Map<
      number,
      { resolve(value: unknown): void; reject(error: Error): void }
    >();
    let errors = '';
    const rpc = <T = unknown>(method: string, input?: unknown) =>
      new Promise<T>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve: (value) => resolve(value as T), reject });
        child.stdin.write(`${JSON.stringify({ id, method, input })}\n`);
      });
    beforeAll(async () => {
      await connectPostgres();
      child = spawn('bun', [must(runner)], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', (chunk) => {
        errors = (errors + String(chunk)).slice(-8000);
      });
      child.on('exit', () => {
        for (const item of pending.values()) item.reject(new Error(errors || 'Fixture exited'));
        pending.clear();
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith('NATIVE_FIXTURE:')) return;
        const message = JSON.parse(line.slice('NATIVE_FIXTURE:'.length));
        const item = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) item?.reject(new Error(message.error));
        else item?.resolve(message.result);
      });
    });
    afterAll(async () => {
      if (child?.exitCode === null) {
        await rpc('shutdown');
        child.kill('SIGTERM');
      }
      await closePostgres();
    });
    it('confirms each immutable period once, preserves both sources, and exports only the maximum active allowance', async () => {
      const RealDate = Date;
      const f = await productAccessFixture();
      const productId = f.products[0].id;
      const offers: ProductOffer[] = ['bundle', 'individual'].map((kind, index) => ({
        schemaVersion: 1,
        id: randomUUID(),
        version: 1,
        kind: kind as 'bundle' | 'individual',
        benefits: [
          {
            kind: 'quota',
            productId,
            key: 'credits',
            unit: 'alia_credit',
            included: index ? 10 : 5,
            combination: 'maximum',
          },
        ],
      }));
      await registerProductAccessConfiguration({ products: f.products, offers });
      const configured = offers.map((offer, index) => ({
        planId: index ? 'alia_pro' : 'one',
        offerId: offer.id,
        offerVersion: 1,
        providerPriceId: index ? 'price_aliapro' : 'price_one',
        grossMinorUnits: index ? (annual ? 9590 : 999) : 2999,
        interval: index && annual ? ('year' as const) : ('month' as const),
      }));
      const remote = await rpc<{
        merchantId: string;
        baseURL: string;
        publicKey: string;
        now: string;
      }>('initialize', {
        appId: f.app.id,
        accountId: f.payer,
        offers: configured,
      });
      const client = new Peable({
        baseURL: remote.baseURL,
        oxyApiUrl: remote.baseURL,
        publicKey: 'synthetic',
        secret: 'synthetic',
        invoiceAuthorityKeys: { fixture: remote.publicKey },
        taxQuoteAuthorityKeys: { fixture: remote.publicKey },
      });
      const display = (amountMinorUnits: number, interval: 'month' | 'year' = 'month') => ({
        amountMinorUnits,
        currency: 'USD',
        interval,
        trial: 'none',
        taxTreatment: 'inclusive',
        merchantTotal: 'final',
      });
      const catalogue = productBillingCatalogueSchema.parse({
        ...EMPTY_PRODUCT_BILLING_CATALOGUE,
        products: f.products,
        offers,
        personalPlans: [
          {
            offerId: offers[0].id,
            offerVersion: 1,
            kind: 'oxy_one',
            audience: 'personal',
            displayName: 'Synthetic One',
            benefitNames: ['Allowance'],
            price: display(2999),
          },
        ],
        productPlans: [
          {
            productId,
            offerId: offers[1].id,
            offerVersion: 1,
            displayName: 'Synthetic Alia Pro',
            price: display(annual ? 9590 : 999, annual ? 'year' : 'month'),
          },
        ],
        prices: configured.map((offer, index) => ({
          priceId: offer.providerPriceId,
          provider: 'peable',
          providerAccountId: remote.merchantId,
          mode: 'live',
          environment: 'production',
          offerId: offer.offerId,
          offerVersion: 1,
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: null,
          currency: 'usd',
          amountMinorUnits: offer.grossMinorUnits,
          interval: offer.interval,
          offerKind: index ? 'individual' : 'bundle',
          kind: index ? 'existing_product' : 'oxy_one',
        })),
      });
      const directory = await mkdtemp(join(tmpdir(), 'native-billing-'));
      const path = join(directory, 'catalogue.json');
      await writeFile(path, JSON.stringify(catalogue));
      const prior = process.env.BILLING_PRODUCT_CATALOGUE_FILE;
      process.env.BILLING_PRODUCT_CATALOGUE_FILE = path;
      try {
        const runtime = createPeablePersonalRuntime(client, {
          merchantId: remote.merchantId,
          applicationId: f.app.id,
          namespace: { mode: 'live', environment: 'production' },
          offers: configured.map((offer, index) => ({
            offerId: offer.offerId,
            offerVersion: 1,
            planId: offer.planId,
            providerPriceId: offer.providerPriceId,
            kind: index ? ('existing_product' as const) : ('oxy_one' as const),
            amountMinorUnits: offer.grossMinorUnits,
            interval: offer.interval,
          })),
          invoiceIssuer: { legalName: 'Oxy Platforms, Inc.', id: 'issuer_fixture' },
          sellerId: 'seller_fixture',
          invoiceAuthorityKeys: { fixture: remote.publicKey },
          taxQuoteAuthorityKeys: { fixture: remote.publicKey },
          purchasesEnabled: true,
          checkout: {
            returnUrl: 'https://example.invalid/return',
            taxRemitterId: 'remitter_fixture',
            customerLocationEvidence: { [f.payer]: 'location_fixture' },
          },
          observationsEnabled: false,
          recoveryEnabled: true,
          recoveryIntervalMilliseconds: 60000,
        });
        const sourceIds: string[] = [];
        for (let index = 0; index < offers.length; index++) {
          const request = {
            expectedSubjectAccountId: f.payer,
            offerId: offers[index].id,
            offerVersion: 1,
            idempotencyKey: randomUUID(),
          };
          const deps = { catalogue, provider: runtime.checkoutProvider };
          const result = index
            ? await startProductPlanCheckout(f.payer, { ...request, productId }, deps)
            : await startPersonalPlanCheckout(f.payer, request, deps);
          if (result.state !== 'pending') throw new Error('Expected actual checkout');
          const [intent] = await getDb()
            .select()
            .from(personalPlanCheckoutIntents)
            .where(eq(personalPlanCheckoutIntents.id, result.intentId));
          expect(await runtime.recoverCheckout(intent.id)).toMatchObject({
            status: 'checkout_pending',
          });
          await rpc('settle', intent.providerSessionId);
          const observed = await runtime.recoverCheckout(intent.id);
          expect(observed).toMatchObject({ status: 'recorded' });
          sourceIds.push((observed as { sourceId: string }).sourceId);
          expect(await runtime.recoverCheckout(intent.id)).toMatchObject({ status: 'no_invoice' });
        }
        const initial = await readSubjectProductGrantSnapshot(f.payer, productId, new Date());
        expect(initial.grants).toHaveLength(2);
        expect(initial.access.quotas[0].included).toBe(10);
        // Move both isolated application clocks into the last week, without a real wait.
        const [firstIntent] = await getDb()
          .select()
          .from(personalPlanCheckoutIntents)
          .where(eq(personalPlanCheckoutIntents.fulfilledSourceId, sourceIds[1]));
        const firstCheckout = await client.billing.retrieveCheckout(
          must(firstIntent.providerSessionId),
        );
        const future =
          Date.parse(must(firstCheckout.subscription).currentPeriodEnd) - 3 * 86_400_000;
        const offset = future - RealDate.now();
        class FixtureDate extends RealDate {
          constructor(value?: string | number) {
            super(value === undefined ? RealDate.now() + offset : value);
          }
          static now() {
            return RealDate.now() + offset;
          }
        }
        globalThis.Date = FixtureDate as DateConstructor;
        await rpc('clock', new Date(Date.now() - 500).toISOString());
        const renewal = await runtime.renew(f.payer, sourceIds[1], 'manual_renewal');
        if (renewal.state !== 'pending') throw new Error('Expected explicit renewal');
        const [renewIntent] = await getDb()
          .select()
          .from(personalPlanCheckoutIntents)
          .where(eq(personalPlanCheckoutIntents.id, renewal.intentId));
        expect(await runtime.renew(f.payer, sourceIds[1], 'manual_renewal')).toEqual(renewal);
        await rpc('settle', renewIntent.providerSessionId);
        expect(await runtime.recoverCheckout(renewIntent.id)).toMatchObject({ status: 'recorded' });
        expect(await runtime.recoverCheckout(renewIntent.id)).toMatchObject({
          status: 'no_invoice',
        });
        const now = new Date();
        const active = await readSubjectProductGrantSnapshot(f.payer, productId, now);
        expect(active.grants).toHaveLength(annual ? 1 : 2);
        expect(active.access.quotas[0].included).toBe(10);
        expect(
          await getDb()
            .select()
            .from(accessGrants)
            .where(eq(accessGrants.beneficiaryAccountId, f.payer)),
        ).toHaveLength(annual ? 25 : 3);
        const individual = must(
          (annual ? initial : active).grants.find((g) => g.origin === 'individual'),
        );
        const bundle = must((annual ? initial : active).grants.find((g) => g.origin === 'bundle'));
        expect(Date.parse(individual.period.end)).toBeGreaterThan(Date.parse(bundle.period.end));
        const afterBundleExpiry = new Date(
          Math.max(Date.parse(individual.period.end), Date.parse(bundle.period.end)) + 1000,
        );
        const remaining = await readSubjectProductGrantSnapshot(
          f.payer,
          productId,
          afterBundleExpiry,
        );
        expect(remaining.grants.map((g) => g.origin)).toEqual(['individual']);
        expect(remaining.access.quotas[0].included).toBe(10);
        // Already paid access is retained on cancellation; it does not erase the other source.
        const [individualIntent] = await getDb()
          .select()
          .from(personalPlanCheckoutIntents)
          .where(eq(personalPlanCheckoutIntents.fulfilledSourceId, sourceIds[1]));
        const checkout = await client.billing.retrieveCheckout(
          must(individualIntent.providerSessionId),
        );
        await client.billing.cancelAtPeriodEnd(must(checkout.subscription).providerSubscriptionId, {
          idempotencyKey: 'cancel_individual',
        });
        await runtime.recover(sourceIds[1]);
        expect(
          (await readSubjectProductGrantSnapshot(f.payer, productId, new Date())).grants,
        ).toHaveLength(annual ? 1 : 2);
        if (process.env.ALIA_OXY_FIXTURE_SNAPSHOT_FILE)
          await writeFile(
            process.env.ALIA_OXY_FIXTURE_SNAPSHOT_FILE,
            JSON.stringify({
              accountId: f.payer,
              adapter: {
                productId,
                quotaKey: 'credits',
                unit: 'alia_credit',
                combination: 'maximum',
                planId: 'go',
                individualOffers: [{ offerId: offers[1].id, offerVersion: 1, planId: 'pro' }],
              },
              active: annual ? initial : active,
              afterBundleExpiry: remaining,
            }),
          );
      } finally {
        globalThis.Date = RealDate;
        if (prior === undefined) delete process.env.BILLING_PRODUCT_CATALOGUE_FILE;
        else process.env.BILLING_PRODUCT_CATALOGUE_FILE = prior;
        await rm(directory, { recursive: true, force: true });
      }
    });
  },
);
