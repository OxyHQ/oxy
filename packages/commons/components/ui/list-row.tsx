import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { useHapticPress } from '@/hooks/use-haptic-press';
import { ThemedText } from '@/components/themed-text';
import type { MaterialCommunityIconName } from '@/types/icons';

interface ListRowProps {
  /** A BARE leading glyph — no circle, no chip. Defaults to the muted tertiary tint. */
  icon?: MaterialCommunityIconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  /** Right-aligned readout (e.g. a count, a status word). */
  value?: string;
  valueColor?: string;
  /** A trailing element that replaces the value/chevron region (pill, switch…). */
  trailing?: React.ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  disabled?: boolean;
  /** Render the title (and default icon) in the error tint. */
  destructive?: boolean;
}

/**
 * One comfortable list row (~56pt). A bare leading icon, a title with optional
 * muted subtitle, and an optional trailing value / element / chevron — flat, no
 * per-row box. Pair with `GroupedList` to share hairline separators.
 */
export function ListRow({
  icon,
  iconColor,
  title,
  subtitle,
  value,
  valueColor,
  trailing,
  onPress,
  showChevron,
  disabled = false,
  destructive = false,
}: ListRowProps) {
  const colors = useColors();
  const handlePressIn = useHapticPress();

  const titleColor = destructive ? colors.error : colors.text;
  const glyphColor = iconColor ?? (destructive ? colors.error : colors.textTertiary);

  const body = (
    <View style={[styles.row, disabled && styles.disabled]}>
      {icon && <MaterialCommunityIcons name={icon} size={22} color={glyphColor} />}
      <View style={styles.text}>
        <ThemedText style={[styles.title, { color: titleColor }]} numberOfLines={1}>
          {title}
        </ThemedText>
        {subtitle && (
          <ThemedText style={[styles.subtitle, { color: colors.textSecondary }]} numberOfLines={2}>
            {subtitle}
          </ThemedText>
        )}
      </View>
      {trailing}
      {value != null && (
        <ThemedText style={[styles.value, { color: valueColor ?? colors.text }]} numberOfLines={1}>
          {value}
        </ThemedText>
      )}
      {showChevron && (
        <MaterialCommunityIcons name="chevron-right" size={20} color={colors.textTertiary} />
      )}
    </View>
  );

  if (onPress && !disabled) {
    return (
      <TouchableOpacity
        onPress={onPress}
        onPressIn={handlePressIn}
        activeOpacity={0.6}
        accessibilityRole="button"
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        accessibilityState={{ disabled }}
      >
        {body}
      </TouchableOpacity>
    );
  }

  return body;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 16,
    minHeight: 56,
  },
  disabled: {
    opacity: 0.45,
  },
  text: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 16,
    fontWeight: '500',
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  value: {
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
