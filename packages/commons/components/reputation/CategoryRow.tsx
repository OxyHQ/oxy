import React from 'react';
import { Meter } from '@oxy.so/bloom/stat-bar';
import { Text } from '@oxy.so/bloom/typography';
import { AppIcon } from '@/constants/icons';
import { View, StyleSheet, Pressable } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { CircleIconBadge } from '@/components/ui/circle-icon-badge';
import { withAlpha } from '@oxy.so/bloom/theme';
import type { IconName } from '@/constants/icons';

interface CategoryRowProps {
  icon: IconName;
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
        <AppIcon name={icon} size='sm' fill={color} />
      </CircleIconBadge>

      <View className="flex-1 gap-space-8">
        <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
          {label}
        </Text>
        {/* Bloom's `Meter` is "the one determinate bar behind every progress
            bar in Bloom", and it announces as a `progressbar` with a name —
            which the two hand-drawn `View`s it replaces never did. The category
            keeps its own `fill` colour, because the colour is what ties the row
            to its segment in the distribution bar above. */}
        <Meter
          value={clamped}
          fill={color}
          track={colors.backgroundSecondary}
          accessibilityLabel={label}
          valueText={`${points}`}
        />
      </View>

      <Text style={[styles.points, { color: isPenalty ? colors.error : colors.text }]}>
        {isPenalty ? `-${points}` : String(points)}
      </Text>
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
  label: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  points: {
    fontSize: 16,
    fontWeight: '700',
    minWidth: 44,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
});
