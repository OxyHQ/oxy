import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { darkenColor } from '@/utils/color-utils';
import { useColors } from '@/hooks/useColors';
import { HorizontalScrollSection } from './horizontal-scroll-section';
import type { MaterialCommunityIconName } from '@/types/icons';

export interface QuickAction {
  id: string;
  icon: MaterialCommunityIconName;
  iconColor: string;
  title: string;
  onPress: () => void;
}

interface QuickActionsSectionProps {
  actions: QuickAction[];
  onPressIn?: () => void;
}

export function QuickActionsSection({ actions, onPressIn }: QuickActionsSectionProps) {
  const colors = useColors();

  return (
    <HorizontalScrollSection
      onPressIn={onPressIn}
      scrollViewStyle={styles.scrollView}
      contentContainerStyle={styles.horizontalScrollContent}
    >
      {actions.map((action) => (
        <TouchableOpacity
          key={action.id}
          style={[styles.chip, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPressIn={onPressIn}
          onPress={action.onPress}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={action.title}
        >
          <View style={[styles.chipIcon, { backgroundColor: action.iconColor }]}>
            <MaterialCommunityIcons name={action.icon} size={20} color={darkenColor(action.iconColor)} />
          </View>
          <Text
            style={[styles.chipText, { color: colors.text }]}
            numberOfLines={1}
          >
            {action.title}
          </Text>
        </TouchableOpacity>
      ))}
    </HorizontalScrollSection>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    // Styles handled by HorizontalScrollSection
  } as const,
  horizontalScrollContent: {
    gap: 6,
    paddingHorizontal: 4,
  } as const,
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 9999,
    borderWidth: 1,
    gap: 5,
    minHeight: 28,
  } as const,
  chipIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  } as const,
  chipText: {
    fontSize: 13,
    fontWeight: '500',
    flexShrink: 0,
  } as const,
});

