import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Peable } from '@peable.to/sdk';
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
import { cancelOwnedPeableSubscription } from './peablePersonalBilling.service';
const configurationSchema = z
  .object({
    merchantId: z.string().regex(/^merch_[A-Za-z0-9_]+$/),
    applicationId: z.string().min(1),
    namespace: billingNamespaceSchema,
    offers: z
      .array(
        z
          .object({
            offerId: z.string().min(1),
            offerVersion: z.number().int().positive(),
            planId: z.string().min(1),
            providerPriceId: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export async function loadPeablePersonalManagement() {
  const path = process.env.OXY_ONE_PEABLE_MANAGEMENT_FILE;
  if (!path || !process.env.OXY_ONE_PEABLE_PUBLIC_KEY || !process.env.OXY_ONE_PEABLE_SECRET)
    return undefined;
  const configuration = configurationSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const client = new Peable({
    publicKey: process.env.OXY_ONE_PEABLE_PUBLIC_KEY,
    secret: process.env.OXY_ONE_PEABLE_SECRET,
  });
  return { configuration, client };
}
/** Named-source cancellation through Peable's durable action ledger. Source and
 * customer ownership remain authoritative at both services; no grants are created. */
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
    !source ||
    source.provider !== 'peable' ||
    source.beneficiaryAccountId !== accountId ||
    source.providerAccountRef !== cfg.merchantId ||
    source.mode !== cfg.namespace.mode ||
    source.environment !== cfg.namespace.environment
  )
    throw new ApiError(404, 'Named source unavailable', 'SOURCE_UNAVAILABLE');
  const merchant = await client.merchants.retrieve();
  if (
    merchant.id !== cfg.merchantId ||
    merchant.oxyAppId !== cfg.applicationId ||
    merchant.environment !== cfg.namespace.environment
  )
    throw new ApiError(409, 'Peable credential owner differs', 'SOURCE_CONFLICT');
  const observed = await client.billing.retrieveSubscription(source.providerSubscriptionId);
  const matches = cfg.offers.filter(
    (v) => v.providerPriceId === observed.providerPriceId && v.planId === observed.planId,
  );
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
        v.origin === 'bundle' &&
        v.offerId === mapping.offerId &&
        v.offerVersion === mapping.offerVersion &&
        v.periodStart.getTime() <= Date.parse(observed.currentPeriodStart) &&
        v.periodEnd.getTime() <= Date.parse(observed.currentPeriodEnd),
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
      v.kind === 'oxy_one' &&
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
  const owned = {
    payerAccountId: accountId,
    providerSubscriptionId: source.providerSubscriptionId,
    providerCustomerId: observed.providerCustomerId,
    providerPriceId: mapping.providerPriceId,
    storeId: accountId,
    planId: mapping.planId,
    livemode: cfg.namespace.mode === 'live',
  };
  const confirmed = await cancelOwnedPeableSubscription(client, accountId, owned, actionId);
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
      period: { start: confirmed.currentPeriodStart, end: confirmed.currentPeriodEnd },
      cancelAtPeriodEnd: true,
    });
    return { sourceId: source.id, cancelAtPeriodEnd: true as const };
  } catch {
    return { sourceId: source.id, reconciliationPending: true as const };
  }
}
