import type { Update } from '@/hooks/use-updates';
import type { PillTone } from '@/components/apps-inference/ui';

// Channel names are URL-safe slugs (mirrors the `channelNameSchema` contract) —
// validate client-side so promote gives immediate feedback before the round-trip.
export const CHANNEL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** First 8 chars of the UUID — enough to identify an update at a glance. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Short git SHA (7 chars), the git convention. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/** Human "n ago" from an ISO timestamp, largest sensible unit. */
export function formatAge(iso: string, locale?: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '—';
  }
  const seconds = Math.round((now - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(seconds) >= secs) {
      return rtf.format(-Math.round(seconds / secs), unit);
    }
  }
  return rtf.format(-seconds, 'second');
}

export function statusTone(status: Update['status']): PillTone {
  if (status === 'published') {
    return 'default';
  }
  if (status === 'rolled_back') {
    return 'destructive';
  }
  return 'secondary';
}

export function platformLabel(platform: Update['platform']): string {
  return platform === 'ios' ? 'iOS' : 'Android';
}

/**
 * Reduce a channel's updates (newest first, all statuses) to the head of each
 * `(runtimeVersion, platform)` tuple — the first (newest) occurrence — then sort
 * by runtime version (desc, numeric-aware) then platform.
 */
export function computeHeads(updates: Array<Update>): Array<Update> {
  const heads = new Map<string, Update>();
  for (const update of updates) {
    // Escaped NUL separator: runtime versions are free-form strings, so a
    // printable delimiter could collide across distinct (runtime, platform) pairs.
    const key = `${update.runtimeVersion}\u0000${update.platform}`;
    if (!heads.has(key)) {
      heads.set(key, update);
    }
  }
  return Array.from(heads.values()).sort((a, b) =>
    a.runtimeVersion === b.runtimeVersion
      ? a.platform.localeCompare(b.platform)
      : b.runtimeVersion.localeCompare(a.runtimeVersion, undefined, { numeric: true }),
  );
}
