/** Read-only planning. Product names and old balances never select a mapping. */
import { productDefinitionSchema, productOfferSchema, type ProductDefinition, type ProductOffer } from '@oxy.so/contracts';
export interface HistoricalProductSubscription {
  rowId: string; provider: 'stripe' | 'peable'; providerAccountRef: string;
  mode: 'live' | 'test'; environment: 'production' | 'development' | 'staging';
  providerSubscriptionId: string; providerPriceId: string;
  beneficiaryAccountId: string; payerAccountId: string;
}
export interface ExplicitProductMapping extends Omit<HistoricalProductSubscription, 'rowId'> {
  offerId: string; offerVersion: number;
}
export function planProductAccessMapping(input: {
  rows: HistoricalProductSubscription[]; mappings: ExplicitProductMapping[];
  products: ProductDefinition[]; offers: ProductOffer[];
}) {
  const products = input.products.map(row => productDefinitionSchema.parse(row));
  const offers = input.offers.map(row => productOfferSchema.parse(row));
  return input.rows.map(row => {
    if (row.mode !== 'live' || row.environment !== 'production') return { rowId: row.rowId, status: 'unsupported_environment' as const };
    const candidates = input.mappings.filter(mapping => mapping.provider === row.provider
      && mapping.providerAccountRef === row.providerAccountRef && mapping.mode === row.mode && mapping.environment === row.environment
      && mapping.providerSubscriptionId === row.providerSubscriptionId && mapping.providerPriceId === row.providerPriceId
      && mapping.beneficiaryAccountId === row.beneficiaryAccountId && mapping.payerAccountId === row.payerAccountId);
    if (candidates.length !== 1) return { rowId: row.rowId, status: candidates.length ? 'ambiguous' as const : 'unmapped' as const };
    const mapping = candidates[0];
    const selected = offers.filter(offer => offer.id === mapping.offerId && offer.version === mapping.offerVersion);
    if (selected.length !== 1 || selected[0].benefits.some(benefit => products.filter(product => product.id === benefit.productId).length !== 1)) return { rowId: row.rowId, status: 'invalid_configuration' as const };
    return { rowId: row.rowId, status: 'mapped' as const, offerId: mapping.offerId, offerVersion: mapping.offerVersion,
      productIds: [...new Set(selected[0].benefits.map(benefit => benefit.productId))].sort() };
  });
}
