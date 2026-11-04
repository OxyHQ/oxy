import type { Peable } from '@peable.to/sdk';
import type { BillingNamespace } from '../config/billingNamespace';
import type { ProductBillingCatalogue } from './productBillingCatalogue.service';

/**
 * Orbit catalog rows for Oxy's PUBLISHED plans, derived from the reviewed
 * product billing catalogue and nothing else (ADR 0046): a plan with an approved
 * display price becomes one Orbit product (its offer), one recurring
 * tax-inclusive price at exactly that amount and cadence, and one entitlement
 * feature per capability or quota it grants, attached to that product. Two
 * plans granting the same benefit share its feature, so Peable's active
 * entitlements answer "has Mention Plus" the same way whichever plan granted it.
 *
 * Idempotent: every row is found by its stable key before anything is created
 * (`metadata['oxy_offer']` for a product, a lookup key for a price and a
 * feature), and an existing price that differs from the approved terms is a
 * refusal — Orbit prices never change what they charge, so a new amount is a new
 * offer version. A dry run reads only. The answer is the binding the catalogue's
 * `prices[]` and the runtime's `offers[]` need; writing those is a reviewed
 * deployment change, never this function's.
 */
export type CatalogueSyncClient = Pick<
  Peable,
  'merchants' | 'products' | 'prices' | 'entitlements'
>;

type PeableCurrency = Parameters<CatalogueSyncClient['prices']['create']>[0]['currency'];

export interface CatalogueSyncTarget {
  merchantId: string;
  applicationId: string;
  namespace: BillingNamespace;
}

interface PlannedPlan {
  offerId: string;
  offerVersion: number;
  offerKind: 'individual' | 'bundle';
  kind: 'existing_product' | 'oxy_one';
  displayName: string;
  amountMinorUnits: number;
  currency: string;
  interval: 'month' | 'year';
  features: { lookupKey: string; name: string }[];
}

export interface CatalogueSyncResult {
  actions: string[];
  /** Entries for the catalogue's `prices[]`, once every row exists. */
  prices: {
    priceId: string;
    provider: 'peable';
    providerAccountId: string;
    mode: BillingNamespace['mode'];
    environment: BillingNamespace['environment'];
    offerId: string;
    offerVersion: number;
    validFrom: string;
    validUntil: null;
    currency: string;
    amountMinorUnits: number;
    offerKind: 'individual' | 'bundle';
    interval: 'month' | 'year';
    kind: 'existing_product' | 'oxy_one';
  }[];
  /** Entries for the personal-plan runtime's `offers[]`. */
  offers: {
    offerId: string;
    offerVersion: number;
    providerPriceId: string;
    kind: 'existing_product' | 'oxy_one';
    amountMinorUnits: number;
    interval: 'month' | 'year';
  }[];
}

export const peablePriceLookupKey = (offerId: string, offerVersion: number) =>
  `${offerId}_v${offerVersion}`;
export const peableFeatureLookupKey = (productId: string, key: string) => `${productId}:${key}`;

/** Every published plan that carries an approved price, with its benefits. */
export function plannedPeablePlans(catalogue: ProductBillingCatalogue): PlannedPlan[] {
  const offerOf = (id: string, version: number) => {
    const offer = catalogue.offers.find((value) => value.id === id && value.version === version);
    if (!offer) throw new Error(`Published plan ${id}@${version} names no registered offer`);
    return offer;
  };
  const featuresOf = (offer: ReturnType<typeof offerOf>) =>
    offer.benefits.map((benefit) => ({
      lookupKey: peableFeatureLookupKey(benefit.productId, benefit.key),
      name: `${catalogue.displayNames.products[benefit.productId] ?? benefit.productId} ${benefit.key}`,
    }));
  const plans: PlannedPlan[] = [];
  for (const plan of catalogue.productPlans) {
    const offer = offerOf(plan.offerId, plan.offerVersion);
    plans.push({
      offerId: plan.offerId,
      offerVersion: plan.offerVersion,
      offerKind: 'individual',
      kind: 'existing_product',
      displayName: plan.displayName,
      amountMinorUnits: plan.price.amountMinorUnits,
      currency: plan.price.currency,
      interval: plan.price.interval,
      features: featuresOf(offer),
    });
  }
  for (const plan of catalogue.personalPlans) {
    if (!plan.price) continue;
    const offer = offerOf(plan.offerId, plan.offerVersion);
    plans.push({
      offerId: plan.offerId,
      offerVersion: plan.offerVersion,
      offerKind: 'bundle',
      kind: 'oxy_one',
      displayName: plan.displayName,
      amountMinorUnits: plan.price.amountMinorUnits,
      currency: plan.price.currency,
      interval: plan.price.interval,
      features: featuresOf(offer),
    });
  }
  return plans;
}

export async function syncPeableCatalogue(
  client: CatalogueSyncClient,
  catalogue: ProductBillingCatalogue,
  target: CatalogueSyncTarget,
  options: { apply: boolean },
): Promise<CatalogueSyncResult> {
  const merchant = await client.merchants.retrieve();
  if (
    merchant.id !== target.merchantId ||
    merchant.oxy_app_id !== target.applicationId ||
    merchant.environment !== target.namespace.environment
  )
    throw new Error('Peable catalogue credential owner differs');
  const livemode = target.namespace.mode === 'live';
  const result: CatalogueSyncResult = { actions: [], prices: [], offers: [] };
  const featureIds = new Map<string, string | undefined>();

  const ensureFeature = async (feature: { lookupKey: string; name: string }) => {
    if (featureIds.has(feature.lookupKey)) return featureIds.get(feature.lookupKey);
    const found = await client.entitlements.features.list({ lookup_key: feature.lookupKey });
    let id = found.data.find((value) => value.lookup_key === feature.lookupKey)?.id;
    if (!id) {
      result.actions.push(`create feature ${feature.lookupKey}`);
      if (options.apply)
        id = (
          await client.entitlements.features.create(
            { lookup_key: feature.lookupKey, name: feature.name },
            { idempotencyKey: `oxy-catalogue-feature:${feature.lookupKey}` },
          )
        ).id;
    }
    featureIds.set(feature.lookupKey, id);
    return id;
  };

  for (const plan of plannedPeablePlans(catalogue)) {
    const offerKey = `${plan.offerId}@${plan.offerVersion}`;
    const products = await client.products.search({
      query: `metadata['oxy_offer']:'${offerKey}'`,
      limit: 2,
    });
    if (products.data.length > 1) throw new Error(`Orbit product for ${offerKey} is ambiguous`);
    let productId = products.data[0]?.id;
    if (!productId) {
      result.actions.push(`create product ${offerKey}`);
      if (options.apply)
        productId = (
          await client.products.create(
            {
              name: plan.displayName,
              metadata: { oxy_offer: offerKey, oxy_offer_kind: plan.offerKind },
            },
            { idempotencyKey: `oxy-catalogue-product:${offerKey}` },
          )
        ).id;
    }

    const attached = productId
      ? new Set(
          (await client.entitlements.productFeatures.list(productId)).data.map(
            (value) => value.entitlement_feature.id,
          ),
        )
      : new Set<string>();
    for (const feature of plan.features) {
      const featureId = await ensureFeature(feature);
      if (featureId && attached.has(featureId)) continue;
      result.actions.push(`attach ${feature.lookupKey} to ${offerKey}`);
      if (options.apply && productId && featureId)
        await client.entitlements.productFeatures.attach(
          productId,
          { entitlement_feature: featureId },
          { idempotencyKey: `oxy-catalogue-attach:${offerKey}:${feature.lookupKey}` },
        );
    }

    const lookupKey = peablePriceLookupKey(plan.offerId, plan.offerVersion);
    const prices = await client.prices.list({ lookup_keys: [lookupKey] });
    let price = prices.data.find((value) => value.lookup_key === lookupKey);
    if (price) {
      if (
        !price.active ||
        price.livemode !== livemode ||
        price.type !== 'recurring' ||
        price.unit_amount !== String(plan.amountMinorUnits) ||
        price.currency.toUpperCase() !== plan.currency ||
        price.recurring?.interval !== plan.interval ||
        price.recurring.interval_count !== 1 ||
        price.tax_behavior !== 'inclusive' ||
        (productId !== undefined &&
          (typeof price.product === 'string' ? price.product : price.product.id) !== productId)
      )
        throw new Error(`Orbit price ${lookupKey} differs from the approved offer`);
    } else {
      result.actions.push(
        `create price ${lookupKey} ${plan.amountMinorUnits} ${plan.currency}/${plan.interval} inclusive`,
      );
      if (options.apply && productId)
        price = await client.prices.create(
          {
            product: productId,
            // The catalogue's ISO code; Orbit refuses one it does not take.
            currency: plan.currency as PeableCurrency,
            unit_amount: String(plan.amountMinorUnits),
            recurring: { interval: plan.interval },
            tax_behavior: 'inclusive',
            lookup_key: lookupKey,
            nickname: plan.displayName,
            metadata: { oxy_offer: offerKey },
          },
          { idempotencyKey: `oxy-catalogue-price:${lookupKey}` },
        );
    }
    if (!price) continue;
    result.prices.push({
      priceId: price.id,
      provider: 'peable',
      providerAccountId: target.merchantId,
      ...target.namespace,
      offerId: plan.offerId,
      offerVersion: plan.offerVersion,
      validFrom: new Date(price.created * 1000).toISOString(),
      validUntil: null,
      currency: plan.currency.toLowerCase(),
      amountMinorUnits: plan.amountMinorUnits,
      offerKind: plan.offerKind,
      interval: plan.interval,
      kind: plan.kind,
    });
    result.offers.push({
      offerId: plan.offerId,
      offerVersion: plan.offerVersion,
      providerPriceId: price.id,
      kind: plan.kind,
      amountMinorUnits: plan.amountMinorUnits,
      interval: plan.interval,
    });
  }
  return result;
}
