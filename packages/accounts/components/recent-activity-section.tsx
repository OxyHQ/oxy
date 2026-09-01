import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useColors } from '@/hooks/useColors';
import { HorizontalScrollSection } from './horizontal-scroll-section';
import { darkenColor } from '@/utils/color-utils';
import type { MaterialCommunityIconName } from '@/types/icons';

export interface RecentActivityItem {
  id: string;
  icon: MaterialCommunityIconName;
  iconColor: string;
  title: string;
  subtitle?: string;
  onPress: () => void;
}

interface RecentActivitySectionProps {
  items: RecentActivityItem[];
  onPressIn?: () => void;
}

export function RecentActivitySection({ items, onPressIn }: RecentActivitySectionProps) {
  const colors = useColors();

  if (items.length === 0) {
    return null;
  }

  return (
    <HorizontalScrollSection
      onPressIn={onPressIn}
      contentContainerStyle={styles.contentContainer}
    >
      {items.map((item) => (
        <TouchableOpacity
          key={item.id}
          style={[styles.activityCard, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPressIn={onPressIn}
          onPress={item.onPress}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={item.subtitle ? `${item.title}, ${item.subtitle}` : item.title}
        >
          <View style={[styles.activityIcon, { backgroundColor: item.iconColor }]}>
            <MaterialCommunityIcons name={item.icon} size={20} color={darkenColor(item.iconColor)} />
          </View>
          <View style={styles.activityContent}>
            <Text 
              style={[styles.activityTitle, { color: colors.text }]}
              numberOfLines={1}
            >
              {item.title}
            </Text>
            {item.subtitle && (
              <Text 
                style={[styles.activitySubtitle, { color: colors.textSecondary }]}
                numberOfLines={1}
              >
                {item.subtitle}
              </Text>
            )}
          </View>
        </TouchableOpacity>
      ))}
    </HorizontalScrollSection>
  );
}

const styles = StyleSheet.create({
  contentContainer: {
    gap: 12,
  } as const,
  activityCard: {
    minWidth: 200,
    maxWidth: 280,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  } as const,
  activityIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as const,
  activityContent: {
    flex: 1,
    minWidth: 0,
  } as const,
  activityTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  } as const,
  activitySubtitle: {
    fontSize: 12,
    fontWeight: '400',
  } as const,
});

