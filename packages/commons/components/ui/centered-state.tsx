import React from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import type { MaterialCommunityIconName } from '@/types/icons';

interface CenteredStateProps {
  /** Show a spinner instead of the icon (loading state). */
  loading?: boolean;
  icon?: MaterialCommunityIconName;
  /** Override the glyph tint (e.g. a success/error result). Defaults to muted. */
  iconColor?: string;
  title?: string;
  body?: string;
  /** A button / link rendered beneath the copy. */
  action?: React.ReactNode;
}

/**
 * The shared loading / empty / error centerpiece: a calm centred column with a
 * spinner or muted glyph, an optional title and body, and an optional action.
 * Fills the available height so the message sits in the optical centre.
 */
export function CenteredState({ loading = false, icon, iconColor, title, body, action }: CenteredStateProps) {
  const colors = useColors();

  return (
    <View style={styles.centered}>
      {loading ? (
        <ActivityIndicator size="large" color={colors.tint} />
      ) : icon ? (
        <MaterialCommunityIcons name={icon} size={52} color={iconColor ?? colors.textSecondary} />
      ) : null}
      {title && <ThemedText style={[styles.title, { color: colors.text }]}>{title}</ThemedText>}
      {body && (
        <ThemedText style={[styles.body, { color: colors.textSecondary }]}>{body}</ThemedText>
      )}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 8,
    gap: 14,
    minHeight: 360,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
});
