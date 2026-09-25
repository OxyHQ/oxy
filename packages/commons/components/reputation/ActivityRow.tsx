import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import { AppIcon, Icons } from '@/constants/icons';
import { useColors } from '@/hooks/useColors';
import { CircleIconBadge } from '@/components/ui/circle-icon-badge';
import { withAlpha } from '@oxy.so/bloom/theme';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { describeReputationAction, formatPointsDelta } from '@/lib/civic/reputation-activity';
import type { ReputationTransaction } from '@oxy.so/contracts';
import { useTranslation } from '@/lib/i18n';

interface ActivityRowProps {
  transaction: ReputationTransaction;
}

/**
 * One reputation ledger entry: a soft circular icon badge tinted by the
 * award/penalty sign, the action label with an Oxy-signed indicator for
 * crypto-attested actions, the relative time, and the signed point delta.
 *
 * Built on Bloom's `Item`, the one row primitive, so this row is the same row —
 * same height, same text column, same announced semantics — as every other row
 * in the app. `role="listitem"` because it IS one: `ActivityList` renders these
 * in sequence and nothing here is pressable.
 *
 * It is deliberately NOT `@oxy.so/bloom/activity-feed`, which arrived in Bloom
 * 4 and looks like a fit by name. It is not one: that family's leading mark is
 * the ACTOR's avatar with the event kind on its corner, and it groups by a day
 * STRING the app formats. A reputation ledger has no actor — every entry is
 * about the reader — and no day headings; it has a signed point delta, which
 * the feed has nowhere to put. Bloom's own doc for that family spends a table
 * distinguishing it from shapes like this one.
 */
export function ActivityRow({ transaction }: ActivityRowProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const relativeTime = useRelativeTime();

  const meta = describeReputationAction(transaction);
  const accent = meta.positive ? colors.success : colors.error;

  const label = t(`civic.reputation.activity.actions.${meta.labelKey}`);

  return (
    <Item
      role="listitem"
      leading={
        <CircleIconBadge backgroundColor={withAlpha(accent, 0.12)}>
          <AppIcon name={meta.icon} size="sm" fill={accent} />
        </CircleIconBadge>
      }
      // The title is a NODE rather than a string because the signed shield sits
      // inline after the label — it qualifies the action, not the row.
      title={
        <View style={styles.labelRow}>
          <Text numberOfLines={1} className="shrink">
            {label}
          </Text>
          {meta.signed && (
            // A glyph says nothing to a screen reader, so the "signed" meaning is
            // carried by the view around it.
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={t('civic.reputation.activity.signed')}
            >
              <Icons.shieldCheck size="xs" fill={colors.success} />
            </View>
          )}
        </View>
      }
      subtitle={relativeTime(transaction.createdAt)}
      trailing={
        <Text style={[styles.delta, { color: accent }]}>{formatPointsDelta(transaction.points)}</Text>
      }
      accessibilityLabel={`${label}, ${formatPointsDelta(transaction.points)}`}
    />
  );
}

const styles = StyleSheet.create({
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    flexShrink: 1,
  },
  delta: {
    fontWeight: '700',
    minWidth: 44,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
