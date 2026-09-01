import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { ThemedText } from '@/components/themed-text';
import { useTranslation } from '@/lib/i18n';

interface ReputationHeaderProps {
  /** The big page title. */
  title: string;
  /** Pending validation requests — surfaced as a count badge on the duty button. */
  pendingCount: number;
  onOpenDuty: () => void;
}

/**
 * The page header: a big, bold, left-aligned title with a floating circular
 * icon button in the top-right (soft `card` fill, subtle shadow) that jumps to
 * the validator inbox — the persistent civic-duty shortcut. A small count badge
 * overlays the button when validation requests are waiting.
 */
export function ReputationHeader({ title, pendingCount, onOpenDuty }: ReputationHeaderProps) {
  const colors = useColors();
  const { t } = useTranslation();
  const hasPending = pendingCount > 0;

  return (
    <View style={styles.header}>
      <ThemedText style={[styles.title, { color: colors.text }]} numberOfLines={1}>
        {title}
      </ThemedText>

      <TouchableOpacity
        activeOpacity={0.8}
        onPress={onOpenDuty}
        accessibilityRole="button"
        accessibilityLabel={t('civic.validate.dutyTitle')}
        style={[styles.iconButton, { backgroundColor: colors.card, shadowColor: colors.shadow }]}
      >
        <MaterialCommunityIcons name="scale-balance" size={22} color={colors.text} />
        {hasPending && (
          <View
            style={[styles.badge, { backgroundColor: colors.primary, borderColor: colors.background }]}
          >
            <ThemedText style={styles.badgeText} numberOfLines={1}>
              {pendingCount > 9 ? '9+' : String(pendingCount)}
            </ThemedText>
          </View>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingTop: 4,
  },
  title: {
    flex: 1,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 40,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
