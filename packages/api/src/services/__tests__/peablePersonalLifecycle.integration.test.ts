import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Peable } from '@peable.to/sdk';
import { cancelStoredPeablePersonalSource } from '../peablePersonalManagement.service';
import { EMPTY_PRODUCT_BILLING_CATALOGUE } from '../productBillingCatalogue.service';
/** Opt-in two-checkout fixture. Set PEABLE_ONE_FIXTURE_RUNNER to Peable's
 * packages/backend/src/__tests__/fixtures/oxyOneLifecycleServer.ts. A separate
 * Bun process owns its throwaway DB and actual SDK; no product dependency override.
 * Synthetic downstream/auth/tax authority, never live provider acceptance. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accessGrants, accessSubscriptionSources, accessProviderRefunds } from '../../db/schema';
import { productAccessFixture } from '../__fixtures__/productAccessFixtures';
import {
  recordProductAccessPeriod,
  readSubjectProductAccess,
} from '../productAccessPersistence.service';
import { cancelOwnedPeableSubscription } from '../peablePersonalBilling.service';
import {
  reconcilePeablePersonalInvoiceState,
  handlePeablePersonalObservation,
  type PeableEvidenceAuthority,
  type PeableInvoiceSource,
} from '../peablePersonalEvidence.service';
const runner = process.env.PEABLE_ONE_FIXTURE_RUNNER;
(runner ? describe : describe.skip)(
  'local Peable SDK → Oxy paid/cancel/refund/lapse fixture',
  () => {
    let child: ChildProcessWithoutNullStreams;
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const rpc = (method: string, args: any[] = [], input?: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, method, args, input }) + '\n');
      });
    beforeAll(async () => {
      for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
        const url = process.env[name];
        if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname))
          throw new Error('Lifecycle fixture requires explicit local PostgreSQL');
      }
      await connectPostgres();
      child = spawn(process.env.BUN_BINARY ?? 'bun', [runner!], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', (error) => {
        for (const p of pending.values()) p.reject(error);
        pending.clear();
      });
      child.on('exit', () => {
        for (const p of pending.values()) p.reject(new Error('Peable fixture process exited'));
        pending.clear();
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (!line.startsWith('OXY_ONE_FIXTURE:')) return;
        const value = JSON.parse(line.slice('OXY_ONE_FIXTURE:'.length));
        const p = pending.get(value.id);
        pending.delete(value.id);
        if (value.error) p?.reject(new Error(value.error));
        else p?.resolve(value.result);
      });
      child.stderr.on('data', () => {});
    });
    afterAll(async () => {
      try {
        if (child?.exitCode === null) await rpc('shutdown');
      } finally {
        child?.kill();
        await closePostgres();
      }
    });
    it('correlates owned checkout, activates once, retains canceled period, revokes only full-refunded bundle and resists delayed paid replay', async () => {
      const f = await productAccessFixture();
      const start = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000).toISOString(),
        end = new Date(Math.floor((Date.now() + 86_400_000) / 1000) * 1000).toISOString();
      const standalone = f.input(f.offers[1]);
      await recordProductAccessPeriod({
        ...standalone,
        source: { ...standalone.source, beneficiaryAccountId: f.payer, period: { start, end } },
        segment: { ...standalone.segment, beneficiaryAccountId: f.payer, period: { start, end } },
      });
      const initialized = await rpc('initialize', [], {
        accountId: f.payer,
        appId: f.app.id,
        planId: 'synthetic-approved',
        periodStart: start,
        periodEnd: end,
      });
      expect(initialized.correlation).toMatchObject({
        id: initialized.checkoutId,
        status: 'complete',
        storeId: f.payer,
        subscription: { providerSubscriptionId: 'sub_fixture' },
      });
      const context = {
        accountId: f.payer,
        appId: f.app.id,
        merchantId: initialized.merchantId,
        customerId: 'cus_fixture',
        subscriptionId: 'sub_fixture',
        priceId: 'price_fixture',
        planId: 'synthetic-approved',
        offerId: f.offers[0].id,
        offerVersion: 1,
        mode: 'live' as const,
        environment: 'production' as const,
      };
      const client = {
        merchants: { retrieve: () => rpc('retrieveMerchant') },
        billing: {
          retrievePaidInvoice: (...args: any[]) => rpc('retrievePaidInvoice', args),
          retrieveInvoiceState: (...args: any[]) => rpc('retrieveInvoiceState', args),
          retrieveSubscription: (...args: any[]) => rpc('retrieveSubscription', args),
          cancelAtPeriodEnd: (...args: any[]) => rpc('cancelAtPeriodEnd', args),
        },
      } as unknown as PeableEvidenceAuthority['client'];
      let authorityStart = start,
        authorityEnd = end;
      let validationNow: Date | undefined;
      const clock = () => validationNow ?? new Date();
      const authority: PeableEvidenceAuthority = {
        client,
        readFinalInvoiceAuthority: async (source: PeableInvoiceSource) => ({
          source,
          invoice: {
            platform: 'peable',
            currency: 'USD',
            grossMinorUnits: 2999,
            netMinorUnits: 2500,
            taxMinorUnits: 499,
            merchantFeeMinorUnits: 0,
            taxTreatment: 'inclusive',
            sellerId: 'synthetic-only',
            invoiceIssuerId: 'synthetic-only',
            taxQuoteId: 'synthetic-only',
            customerLocationEvidenceId: 'synthetic-only',
            taxRateEvidenceId: 'synthetic-only',
            issuedAt: authorityStart,
            expiresAt: authorityEnd,
            context: {
              payerAccountId: f.payer,
              beneficiaryAccountId: f.payer,
              providerSubscriptionId: context.subscriptionId,
              offerId: context.offerId,
              offerVersion: 1,
              periodStart: authorityStart,
              periodEnd: authorityEnd,
              mode: context.mode,
              environment: context.environment,
            },
          },
        }),
      };
      const first = await reconcilePeablePersonalInvoiceState(authority, context, 'in_fixture');
      expect(first.status).toBe('recorded');
      expect(
        (await reconcilePeablePersonalInvoiceState(authority, context, 'in_fixture')).status,
      ).toBe('replayed');
      const active = () => readSubjectProductAccess(f.payer, f.products[1].id);
      expect((await active()).capabilities).toHaveLength(1);
      await expect(
        reconcilePeablePersonalInvoiceState(
          authority,
          { ...context, accountId: f.owner },
          'in_fixture',
        ),
      ).rejects.toThrow('ownership');
      expect(await rpc('relay', [], { enabled: false })).toMatchObject({ kind: 'disabled' });
      expect(await rpc('observe', [], { id: 'evt_fixture_paid', created: 99 })).toMatchObject({
        kind: 'observed',
      });
      expect(await rpc('observe', [], { id: 'evt_fixture_paid' })).toMatchObject({
        kind: 'duplicate',
      });
      expect(await rpc('relay', [], { enabled: true })).toMatchObject({ enqueued: 1 });
      expect(await rpc('relay', [], { enabled: true })).toMatchObject({ enqueued: 0 });
      const deliveries = await rpc('deliveries');
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].event).toMatchObject({
        type: 'billing.observation.updated',
        data: { object: { resourceId: 'in_fixture', resourceKind: 'invoice', revision: 1 } },
      });
      const verify = (body: string, signature: string) => rpc('verifyEvent', [body, signature]);
      await expect(
        handlePeablePersonalObservation(authority, context, deliveries[0].raw, 'bad', verify),
      ).rejects.toThrow();
      expect(
        (
          await handlePeablePersonalObservation(
            authority,
            context,
            deliveries[0].raw,
            deliveries[0].signature,
            verify,
          )
        ).status,
      ).toBe('replayed');
      await cancelOwnedPeableSubscription(
        client,
        f.payer,
        {
          payerAccountId: f.payer,
          providerSubscriptionId: context.subscriptionId,
          providerCustomerId: context.customerId,
          providerPriceId: context.priceId,
          storeId: f.payer,
          planId: context.planId,
          livemode: true,
        },
        'fixture_action',
      );
      await reconcilePeablePersonalInvoiceState(authority, context, 'in_fixture');
      expect((await active()).capabilities).toHaveLength(1);
      const [source] = await getDb()
        .select()
        .from(accessSubscriptionSources)
        .where(eq(accessSubscriptionSources.id, (first as any).sourceId));
      expect(source.cancelAtPeriodEnd).toBe(true);
      expect(
        (await readSubjectProductAccess(f.payer, f.products[1].id, new Date(Date.parse(end) + 1)))
          .capabilities,
      ).toHaveLength(0);
      await rpc('setState', [], { refund: 100 });
      expect(
        (await reconcilePeablePersonalInvoiceState(authority, context, 'in_fixture')).status,
      ).toBe('review_required');
      expect(
        await getDb()
          .select()
          .from(accessProviderRefunds)
          .where(eq(accessProviderRefunds.payerAccountId, f.payer)),
      ).toHaveLength(0);
      await rpc('setState', [], { refund: 2999 });
      expect(
        await rpc('observe', [], { type: 'charge.refunded', id: 'evt_refund', created: 100 }),
      ).toMatchObject({ kind: 'observed' });
      expect(
        (await reconcilePeablePersonalInvoiceState(authority, context, 'in_fixture')).status,
      ).toBe('revoked');
      expect((await active()).capabilities).toHaveLength(0);
      // Original paid wake-up arrives after the refund; fresh read preserves refund.
      expect(
        await rpc('observe', [], { type: 'invoice.paid', id: 'evt_old_paid', created: 1 }),
      ).toMatchObject({ kind: 'unchanged' });
      expect(
        (
          await handlePeablePersonalObservation(
            authority,
            context,
            deliveries[0].raw,
            deliveries[0].signature,
            verify,
          )
        ).status,
      ).toBe('replayed');
      expect((await active()).capabilities).toHaveLength(0);
      expect((await readSubjectProductAccess(f.payer, f.products[0].id)).capabilities).toHaveLength(
        1,
      );
      expect(
        await getDb()
          .select()
          .from(accessGrants)
          .where(eq(accessGrants.beneficiaryAccountId, f.payer)),
      ).toHaveLength(3);
      // A second independently proven paid month is discovered through the existing
      // checkout-owned subscription, with no debit/renewal choice inferred by Oxy.
      authorityStart = end;
      authorityEnd = new Date(Date.parse(end) + 30 * 86_400_000).toISOString();
      const advanced = await rpc('setState', [], {
        renew: { start: authorityStart, end: authorityEnd },
      });
      validationNow = new Date(advanced.now);
      expect(
        await rpc('observe', [], { invoiceId: 'in_renewal', id: 'evt_renewal', created: 101 }),
      ).toMatchObject({ kind: 'observed' });
      expect(await rpc('relay', [], { enabled: true })).toMatchObject({ enqueued: 2 });
      const renewed = await reconcilePeablePersonalInvoiceState(
        authority,
        context,
        'in_renewal',
        clock,
      );
      expect(renewed.status).toBe('recorded');
      expect(
        (await readSubjectProductAccess(f.payer, f.products[1].id, clock())).capabilities,
      ).toHaveLength(1);
      expect(
        (await reconcilePeablePersonalInvoiceState(authority, context, 'in_fixture', clock)).status,
      ).toBe('replayed');
      expect(
        (await readSubjectProductAccess(f.payer, f.products[1].id, clock())).capabilities,
      ).toHaveLength(1);
      expect(
        (
          await readSubjectProductAccess(
            f.payer,
            f.products[1].id,
            new Date(Date.parse(authorityEnd) + 1),
          )
        ).capabilities,
      ).toHaveLength(0);
      const grants = await getDb()
        .select()
        .from(accessGrants)
        .where(eq(accessGrants.beneficiaryAccountId, f.payer));
      expect(grants).toHaveLength(5);
      expect(grants.filter((g) => g.revokedAt !== null)).toHaveLength(2);
      // An unrefunded old paid wake-up after the next renewal is a historical no-op.
      authorityStart = authorityEnd;
      authorityEnd = new Date(Date.parse(authorityStart) + 30 * 86_400_000).toISOString();
      const third = await rpc('setState', [], {
        renew: { start: authorityStart, end: authorityEnd, invoiceId: 'in_third' },
      });
      validationNow = new Date(third.now);
      const thirdPaid = await reconcilePeablePersonalInvoiceState(
        authority,
        context,
        'in_third',
        clock,
      );
      expect(thirdPaid.status).toBe('recorded');
      const [beforeReplay] = await getDb()
        .select()
        .from(accessSubscriptionSources)
        .where(eq(accessSubscriptionSources.id, (thirdPaid as any).sourceId));
      expect(
        (await reconcilePeablePersonalInvoiceState(authority, context, 'in_renewal', clock)).status,
      ).toBe('historical_replayed');
      const [afterReplay] = await getDb()
        .select()
        .from(accessSubscriptionSources)
        .where(eq(accessSubscriptionSources.id, beforeReplay.id));
      expect(afterReplay).toEqual(beforeReplay);
      await rpc('setState', [], { invoiceId: 'in_renewal', refund: 2999 });
      expect(
        (await reconcilePeablePersonalInvoiceState(authority, context, 'in_renewal', clock)).status,
      ).toBe('revoked');
      expect(
        (await readSubjectProductAccess(f.payer, f.products[1].id, clock())).capabilities,
      ).toHaveLength(1);
      // Failed renewal cancellation uses exact historical paid mapping, both before
      // and after Oxy's subscription wake advances the source into an unpaid month.
      const directory = await mkdtemp(join(tmpdir(), 'one-failed-renewal-'));
      const previousCatalogue = process.env.BILLING_PRODUCT_CATALOGUE_FILE;
      const cfg = {
        merchantId: context.merchantId,
        applicationId: context.appId,
        namespace: { mode: 'live' as const, environment: 'production' as const },
        offers: [
          {
            offerId: context.offerId,
            offerVersion: 1,
            planId: context.planId,
            providerPriceId: context.priceId,
          },
        ],
      };
      const path = join(directory, 'catalogue.json');
      await writeFile(
        path,
        JSON.stringify({
          ...EMPTY_PRODUCT_BILLING_CATALOGUE,
          products: f.products,
          offers: f.offers,
          prices: [
            {
              provider: 'peable',
              providerAccountId: context.merchantId,
              priceId: context.priceId,
              mode: 'live',
              environment: 'production',
              offerId: context.offerId,
              offerVersion: 1,
              validFrom: '2000-01-01T00:00:00.000Z',
              validUntil: null,
              currency: 'usd',
              amountMinorUnits: 2999,
              offerKind: 'bundle',
              kind: 'oxy_one',
            },
          ],
        }),
      );
      process.env.BILLING_PRODUCT_CATALOGUE_FILE = path;
      try {
        for (const status of ['past_due', 'unpaid'] as const)
          for (const reconciled of [false, true]) {
            const unpaidStart = authorityEnd,
              unpaidEnd = new Date(Date.parse(unpaidStart) + 30 * 86_400_000).toISOString();
            authorityEnd = unpaidEnd;
            const changed = await rpc('setState', [], {
              period: { start: unpaidStart, end: unpaidEnd },
              status,
              cancelAtPeriodEnd: false,
            });
            validationNow = new Date(changed.now);
            if (reconciled) {
              expect(
                await rpc('observe', [], {
                  type: 'customer.subscription.updated',
                  id: `evt_failed_${status}_${reconciled}`,
                }),
              ).toMatchObject({ kind: 'observed' });
              await rpc('relay', [], { enabled: true });
              const events = await rpc('deliveries');
              const wake = events
                .filter((v: any) => v.event.data.object.resourceKind === 'subscription')
                .at(-1);
              validationNow = new Date(validationNow.getTime() + 1);
              await handlePeablePersonalObservation(
                authority,
                context,
                wake.raw,
                wake.signature,
                verify,
                clock,
              );
            }
            await expect(
              cancelStoredPeablePersonalSource(f.owner, beforeReplay.id, 'wrong_owner', {
                management: { configuration: cfg, client: client as Peable },
                now: clock,
              }),
            ).rejects.toMatchObject({ statusCode: 404 });
            validationNow = new Date(validationNow.getTime() + 1);
            expect(
              await cancelStoredPeablePersonalSource(
                f.payer,
                beforeReplay.id,
                `cancel_${status}_${reconciled}`,
                { management: { configuration: cfg, client: client as Peable }, now: clock },
              ),
            ).toEqual({ sourceId: beforeReplay.id, cancelAtPeriodEnd: true });
            const [state] = await getDb()
              .select()
              .from(accessSubscriptionSources)
              .where(eq(accessSubscriptionSources.id, beforeReplay.id));
            expect(state.status).toBe(status);
            expect(state.cancelAtPeriodEnd).toBe(true);
            expect(state.periodStart.toISOString()).toBe(unpaidStart);
            expect(
              (await readSubjectProductAccess(f.payer, f.products[1].id, clock())).capabilities,
            ).toHaveLength(0);
          }
      } finally {
        if (previousCatalogue === undefined) delete process.env.BILLING_PRODUCT_CATALOGUE_FILE;
        else process.env.BILLING_PRODUCT_CATALOGUE_FILE = previousCatalogue;
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
