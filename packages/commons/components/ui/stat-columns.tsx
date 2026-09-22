import React from 'react';
import { Text } from '@oxy.so/bloom/typography';
import { View, StyleSheet } from 'react-native';
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
 * Two-or-more roomy stat columns split by hairline dividers: a tiny uppercase
 * caption above a big 26/700 tabular value. The same shape used by the
 * reputation Influence / Reliability pair.
 */
export function StatColumns({ items }: StatColumnsProps) {
  const colors = useColors();

  return (
    <View style={styles.row}>
      {items.map((item, index) => (
        <React.Fragment key={item.label}>
          {index > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
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
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 40,
    marginHorizontal: 22,
  },
});
