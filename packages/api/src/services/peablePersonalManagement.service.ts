import { integerCheck, safeNumberCheck, urlCheck, utf16MinLength } from '@oxy.so/contracts';
import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Peable } from '@peable.to/sdk';
import {
  assertPeableBillingWorkloadConfiguration,
  assertPeableBillingMerchant,
  createPeableBillingClient,
} from './peableBillingWorkload.service';
import {
  billingNamespaceSchema,
  assertPersistedBillingNamespace,
  readPersistedBillingNamespace,
} from '../config/billingNamespace';
import { getDb } from '../config/postgres';
import {
  accessSubscriptionSources,
  accessOfferSegments,
  accessProviderPeriods,
} from '../db/schema';
import { ApiError } from '../utils/error';
import { loadProductBillingCatalogue } from './productBillingCatalogue.service';
import { reconcileProductAccessFinancialState } from './productAccessPersistence.service';
import {
  cancelOwnedPeableSubscription,
  peableInstantToIso,
  readNativeSubscription,
} from './peablePersonalBilling.service';
import { PEABLE_CUSTOMER_ACCOUNT_KEY } from './peablePersonalCheckout.service';
export const peablePersonalManagementConfigurationSchema = z
  .object({
    merchantId: z.string().regex(/^merch_[A-Za-z0-9_]+$/),
    applicationId: z.string().check(utf16MinLength(1)),
    namespace: billingNamespaceSchema,
    offers: z
      .array(
        z
          .object({
            offerId: z.string().check(utf16MinLength(1)),
            offerVersion: z.number().check(integerCheck()).positive(),
            providerPriceId: z.string().regex(/^price_[A-Za-z0-9_]+$/),
            kind: z.enum(['oxy_one', 'existing_product']).optional(),
            amountMinorUnits: z
              .number()
              .check(integerCheck())
              .positive()
              .check(safeNumberCheck())
              .optional(),
            interval: z.enum(['month', 'year']).optional(),
          })
          .strict(),
      )
      .min(1),
    /** Where Peable's customer portal returns the payer. */
    portalReturnUrl: z
      .string()
      .check(urlCheck())
      .refine((value) => new URL(value).protocol === 'https:'),
  })
  .strict();
type PeablePersonalManagement = {
  configuration: z.infer<typeof peablePersonalManagementConfigurationSchema>;
  client: Peable;
};
let fallbackManagement: Promise<PeablePersonalManagement> | undefined;
let fallbackPath: string | undefined;
let disposeFallback: (() => void) | undefined;
export async function loadPeablePersonalManagement(): Promise<
  PeablePersonalManagement | undefined
> {
  const runtime = (await import('./peablePersonalRuntime.service.js')).getPeablePersonalRuntime();
  if (runtime) return runtime.management;
  const path = process.env.OXY_ONE_PEABLE_MANAGEMENT_FILE;
  if (!path) return undefined;
  assertPeableBillingWorkloadConfiguration();
  if (fallbackPath && fallbackPath !== path)
    throw new Error('Peable management configuration changed; restart the billing runtime');
  if (!fallbackManagement) {
    fallbackPath = path;
    const pending = (async () => {
      const configuration = peablePersonalManagementConfigurationSchema.parse(
        JSON.parse(await readFile(path, 'utf8')),
      );
      const owned = createPeableBillingClient();
      try {
        await assertPeableBillingMerchant(owned.client, configuration);
        disposeFallback = owned.dispose;
        return { configuration, client: owned.client };
      } catch (error) {
        owned.dispose();
        throw error;
      }
    })();
    fallbackManagement = pending;
    void pending.catch(() => {
      if (fallbackManagement === pending) {
        fallbackManagement = undefined;
        fallbackPath = undefined;
      }
    });
  }
  return fallbackManagement;
}
export async function stopPeablePersonalManagement(): Promise<void> {
  await fallbackManagement?.catch(() => undefined);
  disposeFallback?.();
  disposeFallback = undefined;
  fallbackManagement = undefined;
  fallbackPath = undefined;
}
/** The named source, owned by this account, bound to the configured merchant
 * namespace, and its native subscription read fresh. */
async function ownedPeableSource(
  management: PeablePersonalManagement,
  accountId: string,
  sourceId: string,
) {
  const { configuration: cfg, client } = management;
  assertPersistedBillingNamespace(await readPersistedBillingNamespace(getDb()), cfg.namespace);
  const [source] = await getDb()
    .select()
    .from(accessSubscriptionSources)
    .where(
      and(
        eq(accessSubscriptionSources.id, sourceId),
        eq(accessSubscriptionSources.payerAccountId, accountId),
      ),
    );
  if (
    source?.provider !== 'peable' ||
    source.beneficiaryAccountId !== accountId ||
    source.providerAccountRef !== cfg.merchantId ||
    source.mode !== cfg.namespace.mode ||
    source.environment !== cfg.namespace.environment
  )
    throw new ApiError(404, 'Named source unavailable', 'SOURCE_UNAVAILABLE');
  const merchant = await client.merchants.retrieve();
  if (
    merchant.id !== cfg.merchantId ||
    merchant.oxy_app_id !== cfg.applicationId ||
    merchant.environment !== cfg.namespace.environment
  )
    throw new ApiError(409, 'Peable credential owner differs', 'SOURCE_CONFLICT');
  const observed = readNativeSubscription(
    await client.subscriptions.retrieve(source.providerSubscriptionId),
  );
  const customer = await client.customers.retrieve(observed.customerId);
  if (
    observed.id !== source.providerSubscriptionId ||
    observed.livemode !== (cfg.namespace.mode === 'live') ||
    'deleted' in customer ||
    customer.metadata[PEABLE_CUSTOMER_ACCOUNT_KEY] !== accountId
  )
    throw new ApiError(409, 'Named source ownership differs', 'SOURCE_CONFLICT');
  return { source, observed };
}

/** Peable's customer portal for the named source's customer: payment methods,
 * invoices and plan management, all through the engine's own rules. */
export async function openPeablePersonalPortal(
  accountId: string,
  sourceId: string,
  dependencies: { management?: Awaited<ReturnType<typeof loadPeablePersonalManagement>> } = {},
) {
  const management = dependencies.management ?? (await loadPeablePersonalManagement());
  if (!management)
    throw new ApiError(503, 'Peable management is unconfigured', 'PEABLE_UNCONFIGURED');
  const { observed } = await ownedPeableSource(management, accountId, sourceId);
  const session = await management.client.billingPortal.sessions.create({
    customer: observed.customerId,
    return_url: management.configuration.portalReturnUrl,
  });
  const url = z
    .string()
    .check(urlCheck())
    .refine((value) => new URL(value).protocol === 'https:')
    .parse(session.url);
  return { url };
}

/** Named-source cancellation. Source and customer ownership remain
 * authoritative at both services; no grants are created. */
export async function cancelStoredPeablePersonalSource(
  accountId: string,
  sourceId: string,
  actionId: string,
  dependencies: {
    management?: Awaited<ReturnType<typeof loadPeablePersonalManagement>>;
    now?: () => Date;
  } = {},
) {
  const management = dependencies.management ?? (await loadPeablePersonalManagement());
  if (!management)
    throw new ApiError(503, 'Peable management is unconfigured', 'PEABLE_UNCONFIGURED');
  const { configuration: cfg, client } = management;
  const { source, observed } = await ownedPeableSource(management, accountId, sourceId);
  const matches = cfg.offers.filter((v) => v.providerPriceId === observed.priceId);
  if (matches.length !== 1)
    throw new ApiError(503, 'Named Peable offer is unconfigured', 'PEABLE_UNCONFIGURED');
  const mapping = matches[0];
  const segments = await getDb()
    .select()
    .from(accessOfferSegments)
    .where(eq(accessOfferSegments.subscriptionId, source.id));
  // A failed renewal has no paid segment for its new period. Historical immutable
  // attribution proves ownership/offer; it never grants the unpaid month.
  const historical = segments
    .filter(
      (v) =>
        v.origin === (mapping.kind === 'existing_product' ? 'individual' : 'bundle') &&
        v.offerId === mapping.offerId &&
        v.offerVersion === mapping.offerVersion &&
        v.periodStart.getTime() <= observed.currentPeriodStart * 1000 &&
        v.periodEnd.getTime() <= observed.currentPeriodEnd * 1000,
    )
    .sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime());
  const segment = historical[0];
  if (!segment) throw new ApiError(409, 'Named offer evidence differs', 'SOURCE_CONFLICT');
  const evidence = await getDb()
    .select()
    .from(accessProviderPeriods)
    .where(
      and(
        eq(accessProviderPeriods.sourceId, source.id),
        eq(accessProviderPeriods.segmentId, segment.id),
        eq(accessProviderPeriods.provider, 'peable'),
        eq(accessProviderPeriods.providerAccountRef, cfg.merchantId),
        eq(accessProviderPeriods.mode, cfg.namespace.mode),
        eq(accessProviderPeriods.environment, cfg.namespace.environment),
        eq(accessProviderPeriods.priceId, mapping.providerPriceId),
        eq(accessProviderPeriods.payerAccountId, accountId),
        eq(accessProviderPeriods.beneficiaryAccountId, accountId),
      ),
    );
  if (evidence.length !== 1)
    throw new ApiError(409, 'Named paid attribution differs', 'SOURCE_CONFLICT');
  const catalogue = await loadProductBillingCatalogue();
  const prices = catalogue.prices.filter(
    (v) =>
      v.provider === 'peable' &&
      v.kind === (mapping.kind ?? 'oxy_one') &&
      v.amountMinorUnits ===
        (mapping.kind === 'existing_product' ? mapping.amountMinorUnits : 2999) &&
      v.providerAccountId === cfg.merchantId &&
      v.mode === cfg.namespace.mode &&
      v.environment === cfg.namespace.environment &&
      v.offerId === segment.offerId &&
      v.offerVersion === segment.offerVersion &&
      v.priceId === mapping.providerPriceId &&
      Date.parse(v.validFrom) <= segment.periodStart.getTime() &&
      (v.validUntil === null || Date.parse(v.validUntil) > segment.periodStart.getTime()),
  );
  if (prices.length !== 1)
    throw new ApiError(503, 'Named price evidence is unconfigured', 'PEABLE_UNCONFIGURED');
  const confirmed = await cancelOwnedPeableSubscription(
    client,
    accountId,
    {
      payerAccountId: accountId,
      providerSubscriptionId: source.providerSubscriptionId,
      providerCustomerId: observed.customerId,
      providerPriceId: mapping.providerPriceId,
      livemode: cfg.namespace.mode === 'live',
    },
    actionId,
  );
  const confirmedObservedAt = (dependencies.now ?? (() => new Date()))();
  try {
    await reconcileProductAccessFinancialState({
      sourceId: source.id,
      beneficiaryAccountId: accountId,
      payerAccountId: accountId,
      provider: 'peable',
      providerSubscriptionId: source.providerSubscriptionId,
      providerBinding: { providerAccountRef: cfg.merchantId, ...cfg.namespace },
      providerObservedAt: confirmedObservedAt,
      status: confirmed.status,
      period: {
        start: peableInstantToIso(confirmed.currentPeriodStart),
        end: peableInstantToIso(confirmed.currentPeriodEnd),
      },
      cancelAtPeriodEnd: true,
    });
    return { sourceId: source.id, cancelAtPeriodEnd: true as const };
  } catch {
    return { sourceId: source.id, reconciliationPending: true as const };
  }
}
