import React from 'react';
import { View, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import type { MaterialCommunityIconName } from '@/types/icons';

type CalloutTone = 'warning' | 'danger' | 'info' | 'neutral';

interface CalloutProps {
  children: React.ReactNode;
  icon?: MaterialCommunityIconName;
  tone?: CalloutTone;
}

/**
 * A soft, borderless inline note — a faint tone-tinted fill with a leading glyph
 * and a line or two of copy. Used for the rare warning / attribution / slash
 * advisory without resorting to a hard-bordered box.
 */
export function Callout({ children, icon, tone = 'neutral' }: CalloutProps) {
  const colors = useColors();

  const accent =
    tone === 'warning'
      ? colors.warning
      : tone === 'danger'
        ? colors.error
        : tone === 'info'
          ? colors.info
          : colors.textSecondary;

  return (
    <View style={[styles.callout, { backgroundColor: `${accent}14` }]}>
      {icon && <MaterialCommunityIcons name={icon} size={20} color={accent} style={styles.icon} />}
      <ThemedText style={[styles.text, { color: colors.text }]}>{children}</ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  callout: {
    flexDirection: 'row',
    gap: 12,
    padding: 16,
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  icon: {
    marginTop: 1,
  },
  text: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
});
