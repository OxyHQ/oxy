import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { FirstPartyActivityEntry } from '@oxy.so/core';

/**
 * What Oxy's own apps did for the signed-in account (ADR 0066): they never ask
 * for permissions, and this is where the person sees them act. Keyed by user
 * so switching accounts never shows another account's activity.
 */
export function useFirstPartyActivity() {
  const { oxyServices, user, isAuthenticated } = useOxy();
  return useQuery<FirstPartyActivityEntry[]>({
    queryKey: ['first-party-activity', user?.id ?? null],
    queryFn: () => oxyServices.apps.firstPartyActivity(),
    enabled: isAuthenticated && Boolean(user?.id),
    staleTime: 60 * 1000,
  });
}

/** One row per application and purpose: the latest day first, with its totals. */
export interface FirstPartyActivitySummary {
  key: string;
  applicationName: string;
  purpose: string | null;
  effect: 'read' | 'write';
  count: number;
  lastAt: string;
}

export function summarizeFirstPartyActivity(
  entries: readonly FirstPartyActivityEntry[],
): FirstPartyActivitySummary[] {
  const rows = new Map<string, FirstPartyActivitySummary>();
  for (const entry of entries) {
    const key = `${entry.application.id}:${entry.receiver}:${entry.effect}`;
    const known = rows.get(key);
    if (known) {
      known.count += entry.count;
      if (entry.lastAt > known.lastAt) known.lastAt = entry.lastAt;
      continue;
    }
    rows.set(key, {
      key,
      applicationName: entry.application.name ?? entry.application.id,
      purpose: entry.purpose,
      effect: entry.effect,
      count: entry.count,
      lastAt: entry.lastAt,
    });
  }
  return [...rows.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
