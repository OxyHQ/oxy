import type { UsageData } from '@oxy.so/bloom/usage-card';
import type { AccountStorageModel, Theme, Translate } from './types';

const CATEGORIES = [
  ['photosVideos', 'primary'],
  ['documents', 'info'],
  ['recordings', 'success'],
  ['mail', 'warning'],
  ['family', 'secondary'],
  ['other', 'textTertiary'],
] as const;

/** Keep the server's total authoritative when an older/partial response lacks a breakdown. */
export function accountStorageUsage(
  storage: AccountStorageModel | null,
  colors: Pick<Theme['colors'], (typeof CATEGORIES)[number][1]>,
  t: Translate,
): UsageData | undefined {
  if (
    !storage ||
    !Number.isFinite(storage.limitBytes) ||
    storage.limitBytes <= 0 ||
    !Number.isFinite(storage.usedBytes) ||
    storage.usedBytes < 0
  )
    return undefined;
  const fallback = () => ({
    max: storage.limitBytes,
    segments: [{ label: t('accountMenu.storage.used'), value: storage.usedBytes }],
  });
  if (!storage.categories) return fallback();
  const entries = CATEGORIES.map(([key, tone]) => ({
    key,
    label: t(`accountMenu.storage.categories.${key}`),
    value: storage.categories?.[key]?.bytes ?? 0,
    color: colors[tone],
  }));
  if (entries.some(({ value }) => !Number.isFinite(value) || value < 0)) return fallback();
  const categorized = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (categorized > storage.usedBytes) return fallback();
  // Bytes not attributed by the server belong to Other, never to a guessed category.
  const remainder = storage.usedBytes - categorized;
  return {
    max: storage.limitBytes,
    segments: entries
      .map(({ key, ...entry }) => ({
        ...entry,
        value: entry.value + (key === 'other' ? remainder : 0),
      }))
      .filter(({ value }) => value > 0),
  };
}

/** Adaptive units keep small categories readable instead of displaying 0.0 GB. */
export function formatStorageSize(bytes: number): string {
  if (bytes <= 0 || !Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1),
  );
  const value = bytes / 1024 ** index;
  return `${Number(value.toFixed(index === 0 ? 0 : 1))} ${units[index]}`;
}

/** Capacity actions become relevant only above 85% of a known quota. */
export function shouldShowStorageActions(storage: AccountStorageModel | null): boolean {
  return Boolean(
    storage &&
      Number.isFinite(storage.usedBytes) &&
      Number.isFinite(storage.limitBytes) &&
      storage.limitBytes > 0 &&
      storage.usedBytes / storage.limitBytes > 0.85,
  );
}
