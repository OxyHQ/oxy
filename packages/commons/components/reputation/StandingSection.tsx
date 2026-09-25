import React, { useCallback, useMemo, useState } from 'react';
import { Text } from '@oxy.so/bloom/typography';
import { Icons } from '@/constants/icons';
import { Badge } from '@oxy.so/bloom/badge';
import { View, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { StatColumns, type StatColumn } from '@/components/ui/stat-columns';
import { CompositionBar, type CompositionCategory } from '@oxy.so/bloom/composition-bar';
import { CategoryRow } from '@/components/reputation/CategoryRow';
import {
  getTierProgress,
  formatInfluenceMultiplier,
  formatReliabilityPercent,
} from '@/lib/civic/reputation-standing';
import type { ReputationSource, ReputationSourceKey } from '@/lib/civic/reputation-sources';
import type { AppColors } from '@/hooks/useColors';
import type { IconName } from '@/constants/icons';
import { mixColors } from '@/utils/color';
import type { ReputationBalance, TrustTier } from '@oxy.so/contracts';
import { trustTierLabel } from '@oxy.so/core';
import { useTranslation } from '@/lib/i18n';

interface StandingSectionProps {
  balance: ReputationBalance;
  sources: ReputationSource[];
  /** Whether the surface is rendering cached data while offline. */
  isOffline: boolean;
}

/** The i18n key + points share + tonal color for one positive bar category. */
interface CategoryDatum {
  key: ReputationSourceKey;
  name: string;
  amount: number;
  color: string;
  fraction: number;
}

/** The leading glyph for each civic reputation source. */
const SOURCE_ICON: Readonly<Record<ReputationSourceKey, IconName>> = {
  realLife: 'handshake',
  peerCivic: 'community',
  apps: 'grid',
  penalties: 'alertStrong',
};

/** The soft chip tone for a trust tier — earned tiers escalate through the
 *  success/brand palette, `restricted` is punitive, `new` reads neutral. */
function tierColor(tier: TrustTier, colors: AppColors): string {
  switch (tier) {
    case 'verified':
    case 'high_trust':
      return colors.success;
    case 'trusted':
      return colors.primary;
    case 'restricted':
      return colors.error;
    case 'new':
    default:
      return colors.textSecondary;
  }
}

/**
 * The "Standing" section — flat, no enclosing card. A header row pairs the
 * "Standing" label with the big lifetime total; a soft tier chip and the
 * next-tier progress line sit beneath it; the interactive DISTRIBUTION BAR shows
 * where reputation comes from (segments in a related green→blue tonal ramp,
 * proportional to each category's share); category rows break the bar down and
 * highlight in sync with the selected segment; and a hairline-split Influence /
 * Reliability pair closes the block. Content sits directly on the page
 * background — structure comes from spacing, typography, and thin separators.
 */
export function StandingSection({ balance, sources, isOffline }: StandingSectionProps) {
  const colors = useColors();
  const { t, locale } = useTranslation();

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const toggleSelect = useCallback(
    (key: string) => setSelectedKey((prev) => (prev === key ? null : key)),
    [],
  );

  const tierAccent = tierColor(balance.trustTier, colors);
  const progress = useMemo(
    () => getTierProgress(balance.trustTier, balance.total),
    [balance.trustTier, balance.total],
  );

  const positiveSources = useMemo(
    () => sources.filter((source) => source.weight !== 'penalty' && source.points > 0),
    [sources],
  );
  const penalty = useMemo(
    () => sources.find((source) => source.weight === 'penalty' && source.points > 0),
    [sources],
  );
  const totalPositive = useMemo(
    () => positiveSources.reduce((sum, source) => sum + source.points, 0),
    [positiveSources],
  );

  // Each positive category's color is a step along a related green→blue tonal
  // ramp (success → info), in strongest → weakest order. The SAME color feeds
  // the bar segment and the list row so the two read as one control.
  const categories = useMemo<CategoryDatum[]>(() => {
    const count = positiveSources.length;
    return positiveSources.map((source, index) => ({
      key: source.key,
      name: t(`civic.reputation.sources.${source.key}`),
      amount: source.points,
      color: count <= 1 ? colors.success : mixColors(colors.success, colors.info, index / (count - 1)),
      fraction: totalPositive > 0 ? source.points / totalPositive : 0,
    }));
  }, [positiveSources, totalPositive, colors, t]);

  const barCategories: CompositionCategory[] = categories;
  const isEmpty = categories.length === 0 && !penalty;

  const stats: StatColumn[] = [
    { label: t('civic.reputation.stats.influence'), value: formatInfluenceMultiplier(balance.influence) },
    { label: t('civic.reputation.stats.reliability'), value: formatReliabilityPercent(balance.reliability) },
  ];

  const progressCopy = (() => {
    switch (progress.kind) {
      case 'progress':
        return t('civic.reputation.progress.label', {
          current: progress.current,
          target: progress.targetMin,
          remaining: progress.remaining,
          tier: trustTierLabel(locale, progress.nextTier),
        });
      case 'topPoints':
        return t('civic.reputation.progress.topTier');
      case 'max':
        return t('civic.reputation.standing.verifiedMax');
      case 'restricted':
        return t('civic.reputation.standing.restricted');
      default:
        return null;
    }
  })();

  return (
    <View className="gap-space-16">
      <View className="flex-row items-center justify-between gap-space-12">
        <Text style={[styles.heading, { color: colors.text }]}>
          {t('civic.reputation.standingTitle')}
        </Text>
        <Text style={[styles.total, { color: colors.text }]} numberOfLines={1}>
          {balance.total.toLocaleString()}
        </Text>
      </View>

      <View style={styles.chipRow}>
        <View style={[styles.tierChip, { backgroundColor: colors.backgroundSecondary }]}>
          <View style={[styles.tierDot, { backgroundColor: tierAccent }]} />
          <Text style={[styles.tierChipText, { color: colors.text }]} numberOfLines={1}>
            {trustTierLabel(locale, balance.trustTier)}
          </Text>
        </View>
        {isOffline && (
          <Badge appearance="subtle" tone="neutral" size="label-small" icon={Icons.offline} content={t('civic.reputation.offline')} />
        )}
      </View>

      {progressCopy && (
        <Text
          style={[
            styles.progressCopy,
            { color: progress.kind === 'restricted' ? colors.error : colors.textSecondary },
          ]}
        >
          {progressCopy}
        </Text>
      )}

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      {isEmpty ? (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>
          {t('civic.reputation.composition.empty')}
        </Text>
      ) : (
        <>
          <CompositionBar
            categories={barCategories}
            selectedKey={selectedKey}
            onSelect={toggleSelect}
            hintLabel={t('civic.reputation.composition.hint')}
            formatReadout={(points, percent) =>
              t('civic.reputation.composition.readout', { points, percent })
            }
          />
          <View className="mt-space-4">
            {categories.map((category) => (
              <CategoryRow
                key={category.key}
                icon={SOURCE_ICON[category.key]}
                color={category.color}
                label={category.name}
                points={category.amount}
                fraction={category.fraction}
                selected={selectedKey === category.key}
                onPress={() => toggleSelect(category.key)}
              />
            ))}
            {penalty && (
              <CategoryRow
                icon={SOURCE_ICON.penalties}
                color={colors.error}
                label={t('civic.reputation.sources.penalties')}
                points={penalty.points}
                fraction={totalPositive > 0 ? penalty.points / totalPositive : 1}
                isPenalty
              />
            )}
          </View>
        </>
      )}

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <StatColumns items={stats} />
    </View>
  );
}

const styles = StyleSheet.create({
  heading: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  total: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -1,
    fontVariant: ['tabular-nums'],
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: -4,
  },
  tierChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderCurve: 'continuous',
  },
  tierDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tierChipText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  progressCopy: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    marginTop: -4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  empty: {
    fontSize: 13,
    lineHeight: 18,
  },
});
