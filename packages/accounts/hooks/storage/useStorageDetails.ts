import { useCallback, useMemo } from 'react';
import { alert } from '@oxy.so/bloom';
import type { AccountStorageUsageResponse } from '@oxy.so/core';
import { useColors } from '@/hooks/useColors';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { useTranslation } from '@/lib/i18n';
import type { GroupedItem } from '@/components/sections/types';

/** A single slice of the stacked usage bar in the overview section. */
export interface StorageSegment {
  key: string;
  color: string;
  pct: number;
}

/** A per-category breakdown row with its pre-formatted byte value. */
export interface StorageDetailItem extends GroupedItem {
  valueText: string;
}

export interface StorageDetails {
  usagePercentage: number;
  usageSummaryText: string;
  segments: StorageSegment[];
  storageDetails: StorageDetailItem[];
  accountInfoItems: GroupedItem[];
}

/**
 * Derives every value the storage screen renders from the raw usage payload:
 * the overview summary/percentage, the stacked-bar segments, the per-category
 * breakdown rows (with pre-formatted byte values and detail alerts), and the
 * account-info rows.
 *
 * Extracted verbatim from the storage screen's inline `useMemo`/`useCallback`
 * block — byte formatting, segment thresholds, and category ordering are
 * unchanged.
 */
export function useStorageDetails(usage: AccountStorageUsageResponse | null): StorageDetails {
  const colors = useColors();
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();

  const formatBytes = useCallback((bytes: number) => {
    const abs = Math.abs(bytes);
    const KB = 1024;
    const MB = KB * 1024;
    const GB = MB * 1024;
    const TB = GB * 1024;

    const format = (value: number, unit: string, decimals: number) => ({
      value,
      unit,
      text: `${value.toFixed(decimals)} ${unit}`,
    });

    if (abs >= TB) return format(bytes / TB, 'TB', bytes % TB === 0 ? 0 : 2);
    if (abs >= GB) return format(bytes / GB, 'GB', bytes % GB === 0 ? 0 : 2);
    if (abs >= MB) return format(bytes / MB, 'MB', 2);
    if (abs >= KB) return format(bytes / KB, 'KB', 2);
    return { value: bytes, unit: 'B', text: `${bytes} B` };
  }, []);

  const usagePercentage = useMemo(() => {
    if (!usage || usage.totalLimitBytes === 0) return 0;
    return Math.round((usage.totalUsedBytes / usage.totalLimitBytes) * 100);
  }, [usage]);

  const usageSummaryText = useMemo(() => {
    if (!usage) return '';
    const used = formatBytes(usage.totalUsedBytes).text;
    const total = formatBytes(usage.totalLimitBytes).text;
    return t('storage.usageSummary', { used, total });
  }, [formatBytes, usage, t]);

  const planDisplayName = useMemo(() => {
    if (!usage) return '';
    const plan = usage.plan;
    return plan.charAt(0).toUpperCase() + plan.slice(1);
  }, [usage]);

  const segments = useMemo<StorageSegment[]>(() => {
    const total = usage?.totalLimitBytes ?? 0;
    const cats = usage?.categories;
    const safe = (v?: number) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    const documents = safe(cats?.documents?.bytes);
    const mail = safe(cats?.mail?.bytes);
    const photosVideos = safe(cats?.photosVideos?.bytes);
    const recordings = safe(cats?.recordings?.bytes);
    const family = safe(cats?.family?.bytes);
    const other = safe(cats?.other?.bytes);

    const used = documents + mail + photosVideos + recordings + family + other;
    const remaining = Math.max(0, total - used);

    const toPct = (b: number) => (total > 0 ? (b / total) * 100 : 0);

    return [
      { key: 'documents', color: colors.sidebarIconSecurity, pct: toPct(documents) },
      { key: 'mail', color: colors.sidebarIconSharing, pct: toPct(mail) },
      { key: 'photosVideos', color: colors.sidebarIconPayments, pct: toPct(photosVideos) },
      { key: 'recordings', color: colors.sidebarIconData, pct: toPct(recordings) },
      { key: 'family', color: colors.sidebarIconPersonalInfo, pct: toPct(family) },
      { key: 'other', color: colors.textSecondary, pct: toPct(other) },
      { key: 'remaining', color: colors.border, pct: toPct(remaining) },
    ].filter((s) => s.pct > 0.2); // avoid tiny slivers that look like rendering glitches
  }, [colors.border, colors.sidebarIconData, colors.sidebarIconPayments, colors.sidebarIconPersonalInfo, colors.sidebarIconSecurity, colors.sidebarIconSharing, colors.textSecondary, usage]);

  const handleCategoryPress = useCallback((categoryId: string, categoryName: string, bytes: number, count: number) => {
    const sizeText = formatBytes(bytes).text;
    const countTextKey = categoryId === 'mail'
      ? 'storage.categories.messages'
      : categoryId === 'photosVideos'
        ? 'storage.categories.items'
        : categoryId === 'recordings'
          ? 'storage.categories.recordingsCount'
          : 'storage.categories.files';
    const countText = t(countTextKey, { count });
    const percentage = usage && usage.totalLimitBytes > 0
      ? Math.round((bytes / usage.totalLimitBytes) * 100)
      : 0;

    alert(
      categoryName,
      t('storage.detail.summary', { size: sizeText, count: countText, percent: percentage }),
      [{ text: t('common.ok') }]
    );
    // `alert` is a stable module import from @oxy.so/bloom, not a reactive value.
  }, [formatBytes, usage, t]);

  const storageDetails = useMemo<StorageDetailItem[]>(() => {
    const cats = usage?.categories;
    const safe = (v?: number) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const safeCount = (v?: number) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

    const docsCount = safeCount(cats?.documents?.count);
    const mailCount = safeCount(cats?.mail?.count);
    const photosCount = safeCount(cats?.photosVideos?.count);
    const recCount = safeCount(cats?.recordings?.count);
    const famCount = safeCount(cats?.family?.count);

    const items: StorageDetailItem[] = [
      {
        id: 'documents',
        icon: 'file-document-outline',
        iconColor: colors.sidebarIconSecurity,
        title: t('storage.categories.documents'),
        subtitle: t('storage.categories.files', { count: docsCount }),
        valueText: formatBytes(safe(cats?.documents?.bytes)).text,
        onPress: () => handleCategoryPress('documents', t('storage.categories.documents'), safe(cats?.documents?.bytes), docsCount),
        showChevron: false,
      },
      {
        id: 'mail',
        icon: 'email-outline',
        iconColor: colors.sidebarIconSharing,
        title: t('storage.categories.mail'),
        subtitle: t('storage.categories.messages', { count: mailCount }),
        valueText: formatBytes(safe(cats?.mail?.bytes)).text,
        onPress: () => handleCategoryPress('mail', t('storage.categories.mail'), safe(cats?.mail?.bytes), mailCount),
        showChevron: false,
      },
      {
        id: 'photosVideos',
        icon: 'image-outline',
        iconColor: colors.sidebarIconPayments,
        title: t('storage.categories.photosVideos'),
        subtitle: t('storage.categories.items', { count: photosCount }),
        valueText: formatBytes(safe(cats?.photosVideos?.bytes)).text,
        onPress: () => handleCategoryPress('photosVideos', t('storage.categories.photosVideos'), safe(cats?.photosVideos?.bytes), photosCount),
        showChevron: false,
      },
      {
        id: 'recordings',
        icon: 'microphone-outline',
        iconColor: colors.sidebarIconData,
        title: t('storage.categories.recordings'),
        subtitle: t('storage.categories.recordingsCount', { count: recCount }),
        valueText: formatBytes(safe(cats?.recordings?.bytes)).text,
        onPress: () => handleCategoryPress('recordings', t('storage.categories.recordings'), safe(cats?.recordings?.bytes), recCount),
        showChevron: false,
      },
      {
        id: 'family',
        icon: 'account-group-outline',
        iconColor: colors.sidebarIconPersonalInfo,
        title: t('storage.categories.family'),
        subtitle: t('storage.categories.files', { count: famCount }),
        valueText: formatBytes(safe(cats?.family?.bytes)).text,
        onPress: () => handleCategoryPress('family', t('storage.categories.family'), safe(cats?.family?.bytes), famCount),
        showChevron: false,
      },
    ];

    // Add "Other" category if it has data
    if (safe(cats?.other?.bytes) > 0) {
      const otherCount = safeCount(cats?.other?.count);
      items.push({
        id: 'other',
        icon: 'folder-outline',
        iconColor: colors.textSecondary,
        title: t('storage.categories.other'),
        subtitle: t('storage.categories.files', { count: otherCount }),
        valueText: formatBytes(safe(cats?.other?.bytes)).text,
        onPress: () => handleCategoryPress('other', t('storage.categories.other'), safe(cats?.other?.bytes), otherCount),
        showChevron: false,
      });
    }

    return items;
  }, [colors.sidebarIconData, colors.sidebarIconPayments, colors.sidebarIconPersonalInfo, colors.sidebarIconSecurity, colors.sidebarIconSharing, colors.textSecondary, formatBytes, handleCategoryPress, usage, t]);

  const accountInfoItems = useMemo<GroupedItem[]>(() => {
    if (!usage) return [];
    return [
      {
        id: 'plan',
        icon: 'crown-outline',
        iconColor: colors.sidebarIconPayments,
        title: t('storage.info.plan'),
        subtitle: planDisplayName,
        showChevron: false,
      },
      {
        id: 'updated',
        icon: 'clock-outline',
        iconColor: colors.textSecondary,
        title: t('storage.info.updated'),
        subtitle: relativeTime(usage.updatedAt, t('storage.info.never')),
        showChevron: false,
      },
    ];
  }, [colors.sidebarIconPayments, colors.textSecondary, relativeTime, planDisplayName, usage, t]);

  return { usagePercentage, usageSummaryText, segments, storageDetails, accountInfoItems };
}
