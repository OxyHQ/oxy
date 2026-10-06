import { personalPlanCatalogueSchema, type PersonalPlanCatalogue } from '@oxy.so/contracts';
import type { ProductBillingCatalogue } from './productBillingCatalogue.service';

/** Never infer public offers from provider prices, grants or existing plan names. */
export function readPersonalPlanCatalogue(catalogue: ProductBillingCatalogue): PersonalPlanCatalogue {
  const plans = catalogue.personalPlans.map(plan => {
    const offer = catalogue.offers.find(value => value.id === plan.offerId && value.version === plan.offerVersion);
    if (!offer) throw new Error('Published offer version is unavailable');
    const { benefitNames, ...publicPlan } = plan;
    return { ...publicPlan, benefits: offer.benefits.map((benefit, index) => ({
      displayName: benefitNames[index], benefit,
    })) };
  });
  return personalPlanCatalogueSchema.parse({ schemaVersion: 1,
    state: plans.length ? 'configured' : 'unconfigured', purchase: 'unavailable', plans });
}
