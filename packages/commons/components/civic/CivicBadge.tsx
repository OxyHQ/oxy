import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import type { MaterialCommunityIconName } from '@/types/icons';
import type { CivicTone } from '@/lib/civic/card-presentation';

interface CivicBadgeProps {
  label: string;
  tone: CivicTone;
  icon?: MaterialCommunityIconName;
  /** Larger, higher-contrast variant for the primary VERIFIED/UNVERIFIED row. */
  emphasis?: boolean;
}

/**
 * A tone-coloured pill used across the civic surface (trust tier, personhood,
 * the VERIFIED / UNVERIFIED indicator, reputation-source weights). The semantic
 * `CivicTone` is mapped to a concrete Bloom colour here so the pure presentation
 * mappers (`card-presentation.ts`) stay colour-agnostic.
 */
export function CivicBadge({ label, tone, icon, emphasis = false }: CivicBadgeProps) {
  const colors = useColors();

  const accent = useMemo(() => {
    switch (tone) {
      case 'positive':
        return colors.success;
      case 'caution':
        return colors.warning;
      case 'danger':
        return colors.error;
      case 'neutral':
      default:
        return colors.textSecondary;
    }
  }, [tone, colors]);

  return (
    <View
      style={[
        styles.badge,
        emphasis && styles.badgeEmphasis,
        { backgroundColor: `${accent}1A`, borderColor: `${accent}66` },
      ]}
    >
      {icon && (
        <MaterialCommunityIcons
          name={icon}
          size={emphasis ? 18 : 13}
          color={accent}
          style={styles.icon}
        />
      )}
      <Text
        style={[styles.label, emphasis && styles.labelEmphasis, { color: accent }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeEmphasis: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  icon: {
    marginRight: 5,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  labelEmphasis: {
    fontSize: 15,
    fontWeight: '700',
  },
});
