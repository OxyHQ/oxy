import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';

interface StackHeaderProps {
  title: string;
  subtitle?: string;
  /** Show a leading back chevron when provided. */
  onBack?: () => void;
  /** Show a trailing close (✕) affordance when provided (modal-style screens). */
  onClose?: () => void;
  backAccessibilityLabel?: string;
  closeAccessibilityLabel?: string;
}

/**
 * The large-title screen header for pushed / modal Commons screens. A small
 * affordance row (back chevron and/or close) sits above a confident large title
 * with optional muted subtitle — the spacious iOS large-title rhythm rather than
 * a cramped inline 20pt bar. Lives inside the `Screen` content column, so it
 * inherits the 22pt gutter and the 32pt section rhythm below it.
 */
export function StackHeader({
  title,
  subtitle,
  onBack,
  onClose,
  backAccessibilityLabel,
  closeAccessibilityLabel,
}: StackHeaderProps) {
  const colors = useColors();
  const hasBar = !!onBack || !!onClose;

  return (
    <View style={styles.header}>
      {hasBar && (
        <View style={styles.bar}>
          {onBack ? (
            <TouchableOpacity
              onPress={onBack}
              accessibilityRole="button"
              accessibilityLabel={backAccessibilityLabel}
              style={[styles.iconBtn, styles.backBtn]}
            >
              <MaterialCommunityIcons name="chevron-left" size={28} color={colors.text} />
            </TouchableOpacity>
          ) : (
            <View style={styles.spacer} />
          )}
          {onClose && (
            <TouchableOpacity
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel={closeAccessibilityLabel}
              style={styles.iconBtn}
            >
              <MaterialCommunityIcons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          )}
        </View>
      )}
      <ThemedText style={[styles.title, { color: colors.text }]}>{title}</ThemedText>
      {subtitle && (
        <ThemedText style={[styles.subtitle, { color: colors.textSecondary }]}>{subtitle}</ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: 6,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
    marginBottom: 4,
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtn: {
    marginLeft: -10,
  },
  spacer: {
    width: 40,
    height: 40,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.5,
    lineHeight: 34,
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 21,
  },
});
