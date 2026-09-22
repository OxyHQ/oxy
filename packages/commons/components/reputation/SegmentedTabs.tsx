import React from 'react';
import { Text } from '@oxy.so/bloom/typography';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useColors } from '@/hooks/useColors';

/** One segmented tab option. */
export interface SegmentedTabItem<T extends string> {
  key: T;
  label: string;
}

interface SegmentedTabsProps<T extends string> {
  items: SegmentedTabItem<T>[];
  value: T;
  onChange: (key: T) => void;
}

/**
 * A left-aligned row of segmented pill tabs. The active tab is a filled
 * soft-gray pill with bold text; inactive tabs are plain muted labels with no
 * fill — the reference's Dashboard/Chats/Accounts segmented control.
 */
export function SegmentedTabs<T extends string>({ items, value, onChange }: SegmentedTabsProps<T>) {
  const colors = useColors();

  return (
    <View style={styles.row}>
      {items.map((item) => {
        const active = item.key === value;
        return (
          <TouchableOpacity
            key={item.key}
            activeOpacity={0.7}
            onPress={() => onChange(item.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.tab, active && { backgroundColor: colors.backgroundSecondary }]}
          >
            <Text
              style={[
                styles.label,
                {
                  color: active ? colors.text : colors.textSecondary,
                  fontWeight: active ? '700' : '500',
                },
              ]}
            >
              {item.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    borderCurve: 'continuous',
  },
  label: {
    fontSize: 15,
    letterSpacing: -0.2,
  },
});
