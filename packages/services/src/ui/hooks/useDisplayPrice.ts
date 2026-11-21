import { useEffect, useState } from 'react';
import { skip, useRecord } from '@oxy.so/bloom-data';
import { convertDisplayAmount } from '@peable.to/sdk/display';
import { useOxy } from '../context/oxyRuntimeContext';
import { displayRates } from '../data/displayRates';
import { useDisplayCurrency } from './useDisplayCurrency';
import { useI18n } from './useI18n';

/** How often the rates are read again while a price in another currency is shown. */
const RATES_INTERVAL_MS = 60_000;

/** Display conversion only. Pricing and checkout request bodies retain their source units. */
export function useDisplayPrice() {
  const { oxyServices } = useOxy();
  const { currency } = useDisplayCurrency();
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const rates = useRecord(displayRates, ...(currency !== 'USD' ? [oxyServices] : [skip]));
  const { refresh } = rates;
  useEffect(() => {
    if (currency === 'USD') return;
    const timer = setInterval(() => void refresh(), RATES_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [currency, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  function formatUsd(minorUnits: number) {
    const display = convertDisplayAmount({
      units: String(minorUnits),
      currency: 'USD',
      displayCurrency: currency,
      rates: rates.status === 'error' ? null : rates.value,
      now,
    });
    if (!display) return t('preferences.displayCurrency.unavailable', { currency });
    return currency === 'USD'
      ? display
      : t('preferences.displayCurrency.approximate', { amount: display });
  }
  return { currency, formatUsd };
}
