import { useMemo } from 'react';

import { formatDate, formatDateTime } from '@/lib/dates';
import { useLocale } from '@/lib/i18n';

/** `formatDate` and `formatDateTime` bound to the active locale. */
export function useDateFormat() {
  const { locale } = useLocale();
  return useMemo(
    () => ({
      date: (value: string | number | Date) => formatDate(value, locale),
      dateTime: (value: string | number | Date) => formatDateTime(value, locale),
    }),
    [locale],
  );
}
