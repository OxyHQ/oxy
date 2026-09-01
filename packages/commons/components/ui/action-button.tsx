import React from 'react';
import { StyleSheet, TouchableOpacity, ActivityIndicator, type StyleProp, type ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import type { MaterialCommunityIconName } from '@/types/icons';

type ButtonTone = 'primary' | 'success' | 'danger';

interface BaseButtonProps {
  label: string;
  onPress?: () => void;
  icon?: MaterialCommunityIconName;
  disabled?: boolean;
  loading?: boolean;
  tone?: ButtonTone;
  /** Stretch to fill the parent width. */
  fullWidth?: boolean;
  /** Extra layout style (e.g. `flex: 1` for side-by-side buttons). */
  style?: StyleProp<ViewStyle>;
}

function toneColor(tone: ButtonTone, colors: ReturnType<typeof useColors>): string {
  switch (tone) {
    case 'success':
      return colors.success;
    case 'danger':
      return colors.error;
    case 'primary':
    default:
      return colors.tint;
  }
}

/**
 * The single filled call to action — radius 16, continuous corner, one tone
 * fill, white label, optional leading glyph. No shadow, no gradient.
 */
export function PrimaryButton({
  label,
  onPress,
  icon,
  disabled = false,
  loading = false,
  tone = 'primary',
  fullWidth = true,
  style,
}: BaseButtonProps) {
  const colors = useColors();
  const background = toneColor(tone, colors);
  const inactive = disabled || loading;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={inactive}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={[
        styles.button,
        { backgroundColor: background },
        fullWidth && styles.fullWidth,
        inactive && styles.inactive,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <>
          {icon && <MaterialCommunityIcons name={icon} size={20} color="#fff" />}
          <ThemedText style={styles.primaryLabel}>{label}</ThemedText>
        </>
      )}
    </TouchableOpacity>
  );
}

/**
 * The quiet companion to `PrimaryButton`: a hairline outline in the tone colour,
 * transparent fill, tone-coloured label.
 */
export function SecondaryButton({
  label,
  onPress,
  icon,
  disabled = false,
  loading = false,
  tone = 'primary',
  fullWidth = true,
  style,
}: BaseButtonProps) {
  const colors = useColors();
  const accent = toneColor(tone, colors);
  const inactive = disabled || loading;

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={inactive}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={[
        styles.button,
        styles.outline,
        { borderColor: colors.border },
        fullWidth && styles.fullWidth,
        inactive && styles.inactive,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={accent} />
      ) : (
        <>
          {icon && <MaterialCommunityIcons name={icon} size={20} color={accent} />}
          <ThemedText style={[styles.secondaryLabel, { color: accent }]}>{label}</ThemedText>
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 15,
    paddingHorizontal: 24,
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: StyleSheet.hairlineWidth,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  inactive: {
    opacity: 0.5,
  },
  primaryLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
