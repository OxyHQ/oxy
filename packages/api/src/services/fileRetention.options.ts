/**
 * The file retention pass's steps, defaults and bounds
 * (`fileRetention.service.ts`) — dependency-free, so the operator script can
 * validate its arguments before it loads anything that needs the database or
 * the object store.
 */

export const FILE_RETENTION_STEPS = [
  'federationCacheExpiry',
  'tombstoneRenditions',
  'unusedRenditions',
] as const;
export type FileRetentionStep = (typeof FILE_RETENTION_STEPS)[number];

/**
 * What runs when no step is named. `federationCacheExpiry` is opt-in: its using
 * service (Mention) still points at an entry Oxy expires, so it is enforced
 * only once that service treats a missing cache object as evicted.
 */
export const DEFAULT_FILE_RETENTION_STEPS: readonly FileRetentionStep[] = [
  'tombstoneRenditions',
  'unusedRenditions',
];

export const DEFAULT_UNUSED_DAYS = 30;
/** Mention evicts an entry idle 30 days itself; the backstop waits well past that. */
export const DEFAULT_CACHE_TTL_DAYS = 90;
export const MIN_UNUSED_DAYS = 7;
export const MIN_CACHE_TTL_DAYS = 30;
export const DEFAULT_SCAN_WINDOW = 2000;
export const MIN_SCAN_WINDOW = 100;
export const DEFAULT_PAUSE_MS = 250;
export const DEFAULT_SLOW_BATCH_MS = 2000;
export const DEFAULT_MAX_SLOW_BATCHES = 5;
export const DEFAULT_OFF_PEAK_WINDOW: OffPeakWindow = { startHour: 1, endHour: 7 };

/** What `--apply` must be confirmed with. */
export const FILE_RETENTION_CONFIRMATION = 'delete-file-retention-rows';

/** Hours in UTC, `[startHour, endHour)`; a start after the end wraps midnight. */
export interface OffPeakWindow {
  startHour: number;
  endHour: number;
}

export function isInOffPeakWindow(now: Date, window: OffPeakWindow): boolean {
  const hour = now.getUTCHours();
  if (window.startHour === window.endHour) return true;
  return window.startHour < window.endHour
    ? hour >= window.startHour && hour < window.endHour
    : hour >= window.startHour || hour < window.endHour;
}
