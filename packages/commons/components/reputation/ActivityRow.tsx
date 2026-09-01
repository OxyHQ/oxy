import React from 'react';
import { View, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { CircleIconBadge } from '@/components/ui/circle-icon-badge';
import { withAlpha } from '@/utils/color';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { describeReputationAction, formatPointsDelta } from '@/lib/civic/reputation-activity';
import type { ReputationTransaction } from '@oxyhq/contracts';
import { useTranslation } from '@/lib/i18n';

interface ActivityRowProps {
  transaction: ReputationTransaction;
}

/**
 * One reputation ledger entry as a clean, borderless row: a soft circular icon
 * badge tinted by the award/penalty sign, a readable action label with an
 * Oxy-signed indicator for crypto-attested actions, the relative time, and the
 * signed point delta (green award / red penalty).
 */
export function ActivityRow({ transaction }: ActivityRowProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();

  const meta = describeReputationAction(transaction);
  const accent = meta.positive ? colors.success : colors.error;

  return (
    <View style={styles.row}>
      <CircleIconBadge backgroundColor={withAlpha(accent, 0.12)}>
        <MaterialCommunityIcons name={meta.icon} size={18} color={accent} />
      </CircleIconBadge>

      <View style={styles.text}>
        <View style={styles.labelRow}>
          <ThemedText style={[styles.label, { color: colors.text }]} numberOfLines={1}>
            {t(`civic.reputation.activity.actions.${meta.labelKey}`)}
          </ThemedText>
          {meta.signed && (
            <MaterialCommunityIcons
              name="shield-check"
              size={13}
              color={colors.success}
              accessibilityLabel={t('civic.reputation.activity.signed')}
            />
          )}
        </View>
        <ThemedText style={[styles.time, { color: colors.textSecondary }]} numberOfLines={1}>
          {relativeTime(transaction.createdAt)}
        </ThemedText>
      </View>

      <ThemedText style={[styles.delta, { color: accent }]}>
        {formatPointsDelta(transaction.points)}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
  },
  text: {
    flex: 1,
    gap: 3,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
    letterSpacing: -0.2,
  },
  time: {
    fontSize: 13,
  },
  delta: {
    fontSize: 16,
    fontWeight: '700',
    minWidth: 44,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
