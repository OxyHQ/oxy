import type { ReputationCategory } from '@oxyhq/contracts';
import enUS from './locales/en-US.json';
import { translate } from './index';

/**
 * Every reputation rule category's English name, keyed by its stable id.
 *
 * Totality is over `REPUTATION_CATEGORIES` from `@oxyhq/contracts` so a new
 * category added server-side without an English label is a build error, not a
 * Trust Rules section title that paints `trust.rules.categories.<id>`.
 */
export const EN_REPUTATION_CATEGORY_LABELS: Record<ReputationCategory, string> =
  enUS.trust.rules.categories;

export function reputationCategoryLabel(
  locale: string | undefined,
  id: ReputationCategory,
): string {
  return translate(locale, `trust.rules.categories.${id}`);
}
