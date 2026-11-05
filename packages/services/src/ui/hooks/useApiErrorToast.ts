import { useCallback } from 'react';
import { toast } from '@oxy.so/bloom/toast';
import { describeApiError } from '../utils/apiErrorMessage';
import { useI18n } from './useI18n';

/**
 * Toast a failed API call in the person's language: the reason when the error
 * names one (offline, invalid input, rate limit, server fault), else the
 * `fallbackKey` string saying what failed. Never the server's `message`.
 */
export function useApiErrorToast(): (error: unknown, fallbackKey: string) => void {
  const { t } = useI18n();
  return useCallback(
    (error: unknown, fallbackKey: string) => {
      toast.error(describeApiError(error, t, t(fallbackKey)));
    },
    [t],
  );
}
