import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { ThemedText } from '@/components/themed-text';
import { AccountCard } from '@/components/ui';
import { Section } from '@/components/section';
import { useColors } from '@/hooks/useColors';
import { useTranslation } from '@/lib/i18n';
import type { StorageSegment } from '@/hooks/storage/useStorageDetails';

interface OverviewSectionProps {
  loading: boolean;
  hasUsage: boolean;
  error: string | null;
  usageSummaryText: string;
  usagePercentage: number;
  segments: StorageSegment[];
  onRetry: () => void;
}

/**
 * Storage overview card: the loading spinner, the error/retry state, or the
 * usage summary with the stacked-bar breakdown. Extracted verbatim from the
 * storage screen's overview `Section`.
 */
export function OverviewSection({
  loading,
  hasUsage,
  error,
  usageSummaryText,
  usagePercentage,
  segments,
  onRetry,
}: OverviewSectionProps) {
  const colors = useColors();
  const { t } = useTranslation();

  return (
    <Section title={t('storage.sections.overview')}>
      <AccountCard>
        <View style={styles.overviewContainer}>
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={colors.tint} />
              <ThemedText style={[styles.loadingText, { color: colors.text }]}>{t('storage.loading')}</ThemedText>
            </View>
          ) : error ? (
            <View style={styles.errorContainer}>
              <MaterialCommunityIcons name="alert-circle-outline" size={40} color={colors.sidebarIconSharing} />
              <ThemedText style={[styles.errorText, { color: colors.text }]}>{error}</ThemedText>
              <TouchableOpacity
                style={[styles.retryButton, { backgroundColor: colors.tint }]}
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel={t('storage.retry')}
              >
                <Text style={styles.retryButtonText}>{t('storage.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : hasUsage ? (
            <>
              <View style={styles.usageHeader}>
                <ThemedText style={[styles.usageTitle, { color: colors.text }]}>
                  {usageSummaryText}
                </ThemedText>
                <ThemedText style={[styles.usagePercentage, { color: colors.textSecondary }]}>
                  {t('storage.usagePercentage', { percent: usagePercentage })}
                </ThemedText>
              </View>

              <View style={[styles.usageBar, { backgroundColor: colors.border }]}>
                <View style={styles.usageBarInner}>
                  {segments.map((segment) => (
                    <View
                      key={segment.key}
                      style={[
                        styles.usageSegment,
                        { backgroundColor: segment.color, width: `${segment.pct}%` },
                      ]}
                    />
                  ))}
                </View>
              </View>

              <ThemedText style={[styles.usageSubtitle, { color: colors.textSecondary }]}>
                {t('storage.usageShared')}
              </ThemedText>
            </>
          ) : null}
        </View>
      </AccountCard>
    </Section>
  );
}

const styles = StyleSheet.create({
  overviewContainer: {
    padding: 16,
    gap: 16,
  },
  loadingContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
  loadingText: {
    fontSize: 15,
    fontWeight: '500',
  },
  errorContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    gap: 12,
  },
  errorText: {
    fontSize: 15,
    fontWeight: '500',
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 18,
    marginTop: 8,
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  usageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  usageTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  usagePercentage: {
    fontSize: 15,
    fontWeight: '500',
  },
  usageBar: {
    height: 10,
    borderRadius: 6,
    overflow: 'hidden',
  },
  usageBarInner: {
    flexDirection: 'row',
    height: '100%',
    width: '100%',
  },
  usageSegment: {
    height: '100%',
  },
  usageSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
});
