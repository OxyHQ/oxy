import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { TabBar, TabBarButton, type TabBarItem } from '@oxy.so/bloom/tab-bar';
import {
  Home_Filled_Corner0_Rounded,
  Home_Stroke2_Corner0_Rounded,
  PaperPlane_Stroke2_Corner0_Rounded,
} from '@oxy.so/bloom/icons';
import type { BottomTabBarProps } from 'expo-router/tabs';

/**
 * Route names of the visible tabs, in bar order — the single mapping between a
 * bar index and a route, so the highlight follows deep links and the Android
 * back gesture (which move the navigator without going through the bar).
 */
const TAB_ROUTES = ['index', 'explore'] as const;

/** Bloom icons take a size keyword; `md` (20px) is what the bar's glyph box is built for. */
const ICON_SIZE = 'md';

/** Keeps the pill phone-sized on tablets and wide browser windows (see Commons' bar). */
const TAB_BAR_MAX_WIDTH = 440;

/**
 * The playground's bottom bar: Bloom's floating pill, the same component the
 * rest of the ecosystem ships (see `packages/commons/components/CommonsTabBar.tsx`),
 * driven by the tab navigator's own state. Colors come from the surrounding
 * `BloomThemeProvider`, so it follows light/dark and the active preset.
 */
export function TestAppTabBar({ state, navigation }: BottomTabBarProps) {
  const items = useMemo<TabBarItem[]>(
    () => [
      {
        name: 'index',
        label: 'Home',
        icon: <Home_Stroke2_Corner0_Rounded size={ICON_SIZE} />,
        activeIcon: <Home_Filled_Corner0_Rounded size={ICON_SIZE} />,
      },
      {
        name: 'explore',
        label: 'Explore',
        icon: <PaperPlane_Stroke2_Corner0_Rounded size={ICON_SIZE} />,
      },
    ],
    [],
  );

  // The navigator's route list can carry routes that are not tabs, so the
  // focused index is resolved by name rather than used as a bar index.
  const focusedRouteName = state.routes[state.index]?.name;
  const activeIndex = TAB_ROUTES.findIndex((name) => name === focusedRouteName);

  const handleIndexChange = useCallback(
    (index: number) => {
      const route = TAB_ROUTES[index];
      if (route !== undefined) navigation.navigate(route);
    },
    [navigation],
  );

  return (
    <View style={styles.host}>
      <TabBar activeIndex={activeIndex} onIndexChange={handleIndexChange} maxWidth={TAB_BAR_MAX_WIDTH}>
        {items.map((item, index) => (
          <TabBarButton key={item.name} item={item} index={index} />
        ))}
      </TabBar>
    </View>
  );
}

TestAppTabBar.displayName = 'TestAppTabBar';

const styles = StyleSheet.create({
  // A floating bar must not take layout space from the screens: pinned to the
  // bottom edge, zero-height (Bloom's bar is absolutely positioned against it),
  // and transparent to touches outside the pill.
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'box-none',
  },
});
