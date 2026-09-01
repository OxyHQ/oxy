import React from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { CircleIconBadge } from '@/components/ui/circle-icon-badge';
import { withAlpha } from '@/utils/color';
import type { MaterialCommunityIconName } from '@/types/icons';

interface CategoryRowProps {
  icon: MaterialCommunityIconName;
  /** The category accent (matches its bar segment / badge tint). */
  color: string;
  label: string;
  /** Magnitude of points for this category (always non-negative). */
  points: number;
  /** Filled proportion of this category's thin progress bar, in [0, 1]. */
  fraction: number;
  /** Render as a subtracted penalty: red value with a leading minus. */
  isPenalty?: boolean;
  /** Highlighted in sync with the distribution bar's selected segment. */
  selected?: boolean;
  /** Toggles selection when the row is tapped. */
  onPress?: () => void;
}

/**
 * One composition category row: a soft circular icon badge, the category label
 * with a thin proportional progress bar beneath it, and the right-aligned bold
 * points value. Penalties read red with a leading minus. When `onPress` is set
 * the row is tappable and, while `selected`, sits on a soft highlight fill that
 * mirrors the distribution bar's active segment.
 */
export function CategoryRow({
  icon,
  color,
  label,
  points,
  fraction,
  isPenalty = false,
  selected = false,
  onPress,
}: CategoryRowProps) {
  const colors = useColors();
  const clamped = Math.max(0, Math.min(1, fraction));

  const content = (
    <>
      <CircleIconBadge backgroundColor={withAlpha(color, 0.12)}>
        <MaterialCommunityIcons name={icon} size={18} color={color} />
      </CircleIconBadge>

      <View style={styles.body}>
        <ThemedText style={[styles.label, { color: colors.text }]} numberOfLines={1}>
          {label}
        </ThemedText>
        <View style={[styles.track, { backgroundColor: colors.backgroundSecondary }]}>
          <View style={[styles.fill, { backgroundColor: color, width: `${clamped * 100}%` }]} />
        </View>
      </View>

      <ThemedText style={[styles.points, { color: isPenalty ? colors.error : colors.text }]}>
        {isPenalty ? `-${points}` : String(points)}
      </ThemedText>
    </>
  );

  const rowStyle = [styles.row, selected && { backgroundColor: colors.backgroundSecondary }];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected }}
        style={rowStyle}
      >
        {content}
      </Pressable>
    );
  }

  return <View style={rowStyle}>{content}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginHorizontal: -10,
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  body: {
    flex: 1,
    gap: 8,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  track: {
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  fill: {
    height: 6,
    borderRadius: 999,
  },
  points: {
    fontSize: 16,
    fontWeight: '700',
    minWidth: 44,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
