/**
 * The FairCoin-indexed display rates (`@oxy.so/bloom-data`): read-only
 * estimates for a price shown in another currency than it is charged in. Its
 * own module so only a price display loads the rates reader.
 */
import { entity, source } from '@oxy.so/bloom-data';
import type { OxyServices } from '@oxy.so/core';
import { type DisplayRates, readDisplayRates } from '@peable.to/sdk/display';

/** The one key of the display rates. */
const DISPLAY_RATES = 'faircoin-indexed-price';

export const DisplayRatesOf = entity<DisplayRates & { readonly id: string }>('oxy.display-rates', {
  id: (rates) => rates.id,
});

/**
 * Never retried and never kept unobserved (an old estimate is worse than
 * none); read again when 30 s old. Takes the client like every SDK source,
 * though the rates come from FairCoin, not Oxy.
 */
export const displayRates = source(DisplayRatesOf, {
  stale: 30_000,
  gcTime: 0,
  retry: 0,
  key: (_oxy: OxyServices) => DISPLAY_RATES,
  load: async ({ signal }, _oxy) => ({
    ...(await readDisplayRates({ signal })),
    id: DISPLAY_RATES,
  }),
});
