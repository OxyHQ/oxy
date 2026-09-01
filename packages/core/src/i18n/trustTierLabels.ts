import type { TrustTier } from '@oxyhq/contracts';
import enUS from './locales/en-US.json';
import { translate } from './index';

/**
 * Every trust tier's English name, keyed by its stable id.
 *
 * Totality is over `TRUST_TIERS` from `@oxyhq/contracts` so a new tier without
 * an English label is a build error, not a chip that paints `trust.tiers.<id>`.
 */
export const EN_TRUST_TIER_LABELS: Record<TrustTier, string> = enUS.trust.tiers;

export function trustTierLabel(
  locale: string | undefined,
  tier: TrustTier,
): string {
  return translate(locale, `trust.tiers.${tier}`);
}
