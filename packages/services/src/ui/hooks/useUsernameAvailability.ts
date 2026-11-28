import { useEffect, useState } from 'react';
import { useOxy } from '../context/oxyRuntimeContext';
import { shareUsernameLookup } from '../utils/usernameLookupBudget';
import { checkUsernameDraft } from '../utils/usernamePolicy';
import { useI18n } from './useI18n';

type CheckResult = {
  candidate: string;
  status: 'available' | 'taken' | 'error' | 'deferred';
};

export interface UsernameAvailabilityOptions {
  /**
   * When true (the default), a handle that already belongs to the signed-in
   * account is "unchanged" and is not sent to the server. Signup passes false:
   * a new account needs its own free handle, even on a device that is signed in.
   */
  matchCurrentUser?: boolean;
  /**
   * Count preview lookups against the production ten-a-minute quota and stop
   * one short of it. Signup sets this so Continue still has a lookup left.
   * Profile editing leaves it off: saving there does not look the name up again.
   */
  reserveSubmit?: boolean;
}

/** Debounced server check; a response only applies to the draft that requested it. */
export function useUsernameAvailability(
  value: string,
  enabled: boolean,
  options?: UsernameAvailabilityOptions,
) {
  const { oxyServices, user } = useOxy();
  const { t } = useI18n();
  const matchCurrentUser = options?.matchCurrentUser !== false;
  const reserveSubmit = options?.reserveSubmit === true;
  const candidate = value.trim();
  // The policy of the signed-in account's kind: a bot's handle ends in `bot`.
  const checked = enabled ? checkUsernameDraft(candidate, t, user?.kind) : null;
  const invalid = checked && !checked.ok ? checked.error : undefined;
  const unchanged = matchCurrentUser && candidate.toLowerCase() === user?.username?.toLowerCase();
  const [result, setResult] = useState<CheckResult>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same candidate.
  useEffect(() => {
    if (!enabled || invalid || unchanged) return;
    setResult(undefined);
    let active = true;
    const timer = setTimeout(() => {
      const lookup = reserveSubmit
        ? shareUsernameLookup(candidate, 'background', (name) =>
            oxyServices.auth.checkUsername(name),
          )
        : oxyServices.auth.checkUsername(candidate).then(({ available }) => ({ available }));
      void lookup.then(
        (outcome) => {
          if (!active) return;
          if (outcome === 'deferred') {
            setResult({ candidate, status: 'deferred' });
            return;
          }
          setResult({ candidate, status: outcome.available ? 'available' : 'taken' });
        },
        () => {
          if (active) setResult({ candidate, status: 'error' });
        },
      );
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [candidate, enabled, invalid, unchanged, oxyServices, attempt, reserveSubmit]);

  const status = !enabled
    ? 'idle'
    : unchanged
      ? 'unchanged'
      : invalid
        ? 'invalid'
        : result?.candidate === candidate
          ? result.status
          : 'checking';
  return {
    candidate,
    status,
    invalid,
    canSave: status === 'available' || status === 'unchanged',
    retry: () => {
      setResult(undefined);
      setAttempt((value) => value + 1);
    },
  };
}
