import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { darkenColor } from '@/utils/color-utils';
import { useColors } from '@/hooks/useColors';
import type { MaterialCommunityIconName } from '@/types/icons';

export interface AccountInfoCard {
  id: string;
  icon: MaterialCommunityIconName;
  iconColor: string;
  title: string;
  value: string;
  onPress?: () => void;
}

interface AccountInfoGridProps {
  cards: AccountInfoCard[];
  onPressIn?: () => void;
}

export function AccountInfoGrid({ cards, onPressIn }: AccountInfoGridProps) {
  const colors = useColors();

  return (
    <View style={styles.gridContainer}>
      {cards.map((card) => (
        <TouchableOpacity
          key={card.id}
          style={[styles.accountInfoCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPressIn={onPressIn}
          onPress={card.onPress}
          activeOpacity={card.onPress ? 0.7 : 1}
          disabled={!card.onPress}
          accessibilityRole={card.onPress ? 'button' : undefined}
          accessibilityLabel={`${card.title}, ${card.value}`}
          accessibilityState={{ disabled: !card.onPress }}
        >
          <View style={[styles.accountInfoIcon, { backgroundColor: card.iconColor }]}>
            <MaterialCommunityIcons name={card.icon} size={20} color={darkenColor(card.iconColor)} />
          </View>
          <View style={styles.spacer} />
          <View style={styles.textContainer}>
            <Text style={[styles.accountInfoTitle, { color: colors.textSecondary }]}>{card.title}</Text>
            <Text style={[styles.accountInfoValue, { color: colors.text }]}>{card.value}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'stretch',
  } as const,
  accountInfoCard: {
    flex: 1,
    minWidth: '48%',
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    alignSelf: 'flex-start',
  } as const,
  accountInfoIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  } as const,
  spacer: {
    height: 20,
  } as const,
  textContainer: {
    gap: 4,
  } as const,
  accountInfoTitle: {
    fontSize: 12,
    fontWeight: '500',
  } as const,
  accountInfoValue: {
    fontSize: 20,
    fontWeight: 'bold',
  } as const,
});

