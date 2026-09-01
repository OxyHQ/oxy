import React from 'react';
import { View, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { ThemedText } from '@/components/themed-text';
import { AccountCard } from '@/components/ui/account-card';
import { useColors } from '@/hooks/useColors';
import type { MaterialCommunityIconName } from '@/types/icons';

interface EmptyStateCardProps {
  icon: MaterialCommunityIconName;
  title: string;
  subtitle: string;
  /**
   * Color for the subtitle text. Defaults to the primary text color (matching
   * the security sections). The payments sections pass `colors.textSecondary`
   * to preserve their dimmer subtitle tone.
   */
  subtitleColor?: string;
}

/**
 * Generic empty-state card (centered icon + title + subtitle inside an
 * {@link AccountCard}). Shared by the billing/transaction history sections and
 * the security devices/activity sections when there are no entries to render.
 */
export function EmptyStateCard({ icon, title, subtitle, subtitleColor }: EmptyStateCardProps) {
  const colors = useColors();

  return (
    <AccountCard>
      <View style={styles.emptyStateContainer}>
        <MaterialCommunityIcons
          name={icon}
          size={40}
          color={colors.text}
          style={styles.emptyStateIcon}
        />
        <ThemedText style={[styles.emptyStateTitle, { color: colors.text }]}>{title}</ThemedText>
        <ThemedText style={[styles.emptyStateSubtitle, { color: subtitleColor ?? colors.text }]}>
          {subtitle}
        </ThemedText>
      </View>
    </AccountCard>
  );
}

const styles = StyleSheet.create({
  emptyStateContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
    paddingHorizontal: 24,
  },
  emptyStateIcon: {
    opacity: 0.4,
    marginBottom: 12,
  },
  emptyStateTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
    opacity: 0.8,
  },
  emptyStateSubtitle: {
    fontSize: 13,
    opacity: 0.6,
    textAlign: 'center',
    lineHeight: 18,
  },
});
