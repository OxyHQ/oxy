import { useEffect, useState } from 'react';
import { usernameSchema } from '@oxy.so/contracts';
import { useOxy } from '../context/oxyRuntimeContext';

type CheckResult = { candidate: string; status: 'available' | 'taken' | 'error' };

/** Debounced server check; a response only applies to the draft that requested it. */
export function useUsernameAvailability(value: string, enabled: boolean) {
  const { oxyServices, user } = useOxy();
  const candidate = value.trim();
  const parsed = usernameSchema.safeParse(candidate);
  const invalid = parsed.success ? undefined : parsed.error.issues[0]?.message;
  const unchanged = candidate.toLowerCase() === user?.username?.toLowerCase();
  const [result, setResult] = useState<CheckResult>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries the same candidate.
  useEffect(() => {
    if (!enabled || invalid || unchanged) return;
    setResult(undefined);
    let active = true;
    const timer = setTimeout(() => {
      void oxyServices.auth.checkUsername(candidate).then(
        ({ available }) => {
          if (active) setResult({ candidate, status: available ? 'available' : 'taken' });
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
  }, [candidate, enabled, invalid, unchanged, oxyServices, attempt]);

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
