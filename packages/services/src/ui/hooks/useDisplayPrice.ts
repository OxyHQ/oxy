import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { convertDisplayAmount, readDisplayRates } from '@peable.to/sdk/display';
import { useDisplayCurrency } from './useDisplayCurrency';
import { useI18n } from './useI18n';

/** Display conversion only. Pricing and checkout request bodies retain their source units. */
export function useDisplayPrice() {
  const { currency } = useDisplayCurrency();
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  const rates = useQuery({
    queryKey: ['display-currency', 'faircoin-indexed-price'],
    queryFn: ({ signal }) => readDisplayRates({ signal }),
    enabled: currency !== 'USD',
    staleTime: 30_000,
    gcTime: 0,
    retry: false,
    refetchInterval: 60_000,
    refetchOnWindowFocus: 'always',
  });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  function formatUsd(minorUnits: number) {
    const display = convertDisplayAmount({
      units: String(minorUnits),
      currency: 'USD',
      displayCurrency: currency,
      rates: rates.isError ? null : rates.data,
      now,
    });
    if (!display) return t('preferences.displayCurrency.unavailable', { currency });
    return currency === 'USD'
      ? display
      : t('preferences.displayCurrency.approximate', { amount: display });
  }
  return { currency, formatUsd };
}
