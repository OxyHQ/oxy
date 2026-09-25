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
 * Two-or-more roomy stat columns split by a vertical `Divider`: a tiny uppercase
 * caption above a big tabular value. The reputation Influence / Reliability pair.
 *
 * Deliberately NOT Bloom's `StatCards`, which draws each KPI on its own card;
 * these sit inside an existing card, and a card inside a card is what the flat
 * reputation design avoids.
 */
export function StatColumns({ items }: StatColumnsProps) {
  const colors = useColors();

  return (
    <View className="flex-row items-center">
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
