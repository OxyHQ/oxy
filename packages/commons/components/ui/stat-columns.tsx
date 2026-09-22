import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Divider } from '@oxy.so/bloom/divider';
import { Text } from '@oxy.so/bloom/typography';
import { useColors } from '@/hooks/useColors';

export interface StatColumn {
  label: string;
  value: string;
  valueColor?: string;
}

interface StatColumnsProps {
  items: StatColumn[];
}

/**
 * Two-or-more roomy stat columns split by a rule: a tiny uppercase caption above
 * a big tabular value. The reputation Influence / Reliability pair.
 *
 * It is NOT Bloom's `StatCards`, deliberately. That family draws KPI CARDS — an
 * icon, a delta, a comparison footer, each on its own surface — and these two
 * numbers sit inside an existing card, under a rule, as a quiet footer to the
 * standing block. A card inside a card is the thing the flat reputation design
 * was written to avoid.
 *
 * What it no longer draws by hand is the rule: that is Bloom's `Divider`, in its
 * vertical form, rather than a 1px `View` tinted from `useColors()`.
 */
export function StatColumns({ items }: StatColumnsProps) {
  const colors = useColors();

  return (
    <View style={styles.row}>
      {items.map((item, index) => (
        <React.Fragment key={item.label}>
          {index > 0 && <Divider vertical />}
          <View style={styles.stat}>
            <Text style={[styles.label, { color: colors.textSecondary }]} numberOfLines={1}>
              {item.label}
            </Text>
            <Text style={[styles.value, { color: item.valueColor ?? colors.text }]} numberOfLines={1}>
              {item.value}
            </Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stat: {
    flex: 1,
    gap: 7,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  value: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
});
