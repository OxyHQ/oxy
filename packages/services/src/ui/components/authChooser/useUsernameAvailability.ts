/**
 * Debounced username-availability check over the existing SDK method.
 *
 * One responsibility: turn keystrokes into an `idle | checking | available |
 * taken` verdict without racing. A sequence guard drops superseded responses,
 * and a NETWORK failure resets the (now stale) verdict and toasts — it never
 * paints an inline error inside the dialog (owner mandate).
 */

import { useCallback, useRef, useState } from 'react';
import { toast } from '@oxyhq/bloom/toast';
import type { OxyServices } from '@oxyhq/core';
import type { Translate } from './types';

export type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken';

/** Keystrokes settle for this long before a check is issued. */
const DEBOUNCE_MS = 400;
/** Shorter than this and there is nothing worth asking the server about. */
const MIN_USERNAME_LENGTH = 3;

export function useUsernameAvailability(
  oxyServices: OxyServices,
  t: Translate,
): {
  status: UsernameStatus;
  check: (value: string) => void;
} {
  const [status, setStatus] = useState<UsernameStatus>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeqRef = useRef(0);

  const check = useCallback(
    (value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const seq = ++requestSeqRef.current;
      if (!value || value.length < MIN_USERNAME_LENGTH) {
        setStatus('idle');
        return;
      }
      setStatus('checking');
      timerRef.current = setTimeout(() => {
        void oxyServices
          .checkUsernameAvailability(value)
          .then((result) => {
            if (seq !== requestSeqRef.current) return; // superseded by a newer check
            setStatus(result.available ? 'available' : 'taken');
          })
          .catch(() => {
            if (seq !== requestSeqRef.current) return;
            setStatus('idle');
            toast.error(t('accounts.create.username.checkFailed'));
          });
      }, DEBOUNCE_MS);
    },
    [oxyServices, t],
  );

  return { status, check };
}
