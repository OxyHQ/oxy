import Ionicons from '@expo/vector-icons/Ionicons';
import { Link, usePathname, type Href } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@oxyhq/bloom/theme';

import { ThemedText } from '@/components/themed-text';
import { useHapticPress } from '@/hooks/use-haptic-press';

type TabItem = {
  href: Href;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
};

const TABS: TabItem[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/explore', label: 'Explore', icon: 'paper-plane' },
];

/**
 * Custom bottom tab bar built on expo-router's <Link> — the canonical
 * navigation primitive. <Link> renders a real <a href> on web (accessible,
 * middle-click / open-in-new-tab friendly) AND navigates client-side, so
 * switching tabs never triggers a full document reload. Mirrors the
 * Slot + router-driven navigation pattern used across the other Oxy apps,
 * instead of @react-navigation's <Tabs> (incompatible with expo-router on
 * Expo SDK 56). Colors come from Bloom's useTheme() — the single theme
 * source — so the bar tracks the active color preset like the nav chrome.
 */
export function TabBar() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const triggerHaptics = useHapticPress();

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      {TABS.map((tab) => {
        const active =
          tab.href === '/' ? pathname === '/' : pathname.startsWith(String(tab.href));
        const color = active ? colors.primary : colors.icon;
        return (
          <Link key={tab.label} href={tab.href} asChild>
            <Pressable
              style={styles.tab}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={tab.label}
              onPressIn={triggerHaptics}
            >
              <Ionicons name={tab.icon} size={24} color={color} />
              <ThemedText style={[styles.label, { color }]}>{tab.label}</ThemedText>
            </Pressable>
          </Link>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 2,
  },
  label: {
    fontSize: 11,
    lineHeight: 14,
  },
});
