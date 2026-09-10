import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { TabBar, TabBarButton, type TabBarItem } from '@oxy.so/bloom/tab-bar';
import {
  Person_Filled_Corner2_Rounded,
  Person_Stroke2_Corner2_Rounded,
  SettingsGear2_Filled_Corner0_Rounded,
  SettingsGear2_Stroke2_Corner0_Rounded,
  Star_Filled_Corner0_Rounded,
  Star_Stroke2_Corner0_Rounded,
} from '@oxy.so/bloom/icons';
import type { BottomTabBarProps } from 'expo-router/tabs';

import { useTranslation } from '@/lib/i18n';

/**
 * Route names of the visible tabs, in bar order. The array is the single source
 * of truth for the mapping between a bar index and a route: `activeIndex` is
 * derived by looking the focused route up in it, and a press navigates to the
 * entry at the pressed index. Deriving both from one list is what keeps the
 * highlight correct through deep links and the Android back gesture, which move
 * the navigator without going through the bar.
 */
const TAB_ROUTES = ['(id)', '(reputation)', '(settings)'] as const;

/**
 * Glyph size. Bloom icons take a size KEYWORD, not a number; `md` is 20px,
 * which is what the bar's own 21px glyph box is built around.
 */
const ICON_SIZE = 'md';

/**
 * Ceiling on the pill's width, in points.
 *
 * Commons ships to iPad (`supportsTablet: true`), where an unconstrained bar
 * spans the whole screen — 810pt at 11" portrait, 1342pt in landscape — leaving
 * three 21pt glyphs adrift in cells hundreds of points wide. Bloom derives the
 * item width from the window, so this cannot be fixed with a `style` override:
 * the highlight and the scrub hit-testing would still divide the WINDOW width.
 *
 * 440 is the width of the largest phone screen currently shipping (iPhone 16
 * Pro Max), so the pill can never be wider than a big phone's whole display.
 * `maxWidth` is a CEILING and never a floor, so no phone is affected: the
 * widest phone pill is 416pt (440 minus the bar's 12pt margin per side), which
 * is under this and therefore stays full-bleed. Every tablet size is over it
 * and gets constrained and centred.
 */
const TAB_BAR_MAX_WIDTH = 440;

/**
 * The Commons bottom bar: Bloom's floating glass pill, driven by the tab
 * navigator's own state.
 *
 * It replaces the platform `NativeTabs` bar. The three route groups, their
 * order and their labels are unchanged; what changes is that the bar is a JS
 * surface that floats OVER the content instead of a native bar that reserves
 * space below it. Anything that needs to stay clear of it measures the bar
 * through `useTabBarFootprint()` (see `components/ui/screen.tsx`) rather than a
 * hardcoded height.
 *
 * Each tab carries an outline/filled icon PAIR. The bar renders `icon` and
 * `activeIcon` as two stacked crossfade layers, so selection reads as the
 * outline glyph dissolving into the filled one — the same thing the SF Symbol
 * pair said natively, which a tint crossfade alone could not express.
 *
 * `sfSymbol` is deliberately NOT set: it would render an SF Symbol on iOS and a
 * Bloom icon everywhere else, so the two platforms would disagree about the
 * shape of the same tab. The Bloom pair is used on all three platforms.
 */
export function CommonsTabBar({ state, navigation }: BottomTabBarProps) {
  const { t } = useTranslation();

  const items = useMemo<TabBarItem[]>(
    () => [
      {
        name: '(id)',
        label: t('tabs.id'),
        icon: <Person_Stroke2_Corner2_Rounded size={ICON_SIZE} />,
        activeIcon: <Person_Filled_Corner2_Rounded size={ICON_SIZE} />,
      },
      {
        name: '(reputation)',
        label: t('tabs.reputation'),
        icon: <Star_Stroke2_Corner0_Rounded size={ICON_SIZE} />,
        activeIcon: <Star_Filled_Corner0_Rounded size={ICON_SIZE} />,
      },
      {
        name: '(settings)',
        label: t('tabs.settings'),
        icon: <SettingsGear2_Stroke2_Corner0_Rounded size={ICON_SIZE} />,
        activeIcon: <SettingsGear2_Filled_Corner0_Rounded size={ICON_SIZE} />,
      },
    ],
    [t],
  );

  // The navigator's route list also carries the hidden routes, so the focused
  // index cannot be used as a bar index directly — it is resolved by name.
  const focusedRouteName = state.routes[state.index]?.name;
  const activeIndex = TAB_ROUTES.findIndex((name) => name === focusedRouteName);

  const handleIndexChange = useCallback(
    (index: number) => {
      const route = TAB_ROUTES[index];
      if (route !== undefined) {
        navigation.navigate(route);
      }
    },
    [navigation],
  );

  return (
    <View style={styles.host}>
      <TabBar
        activeIndex={activeIndex}
        onIndexChange={handleIndexChange}
        maxWidth={TAB_BAR_MAX_WIDTH}
        // The blur band is 114pt tall and full-bleed, so the ID screen's
        // QR-scan FAB sits inside it and would be blurred and tinted. No
        // z-order can lift a screen's FAB above the bar's host — it is inside
        // an earlier sibling — so switching the band off is the only fix.
        // It stays ON for the other two tabs, where nothing floats at the
        // bottom edge and dissolving content behind the pill is the point.
        blur={focusedRouteName !== '(id)'}
      >
        {items.map((item, index) => (
          <TabBarButton key={item.name} item={item} index={index} />
        ))}
      </TabBar>
    </View>
  );
}

CommonsTabBar.displayName = 'CommonsTabBar';

const styles = StyleSheet.create({
  /**
   * POSITIONING: the navigator renders this element as the LAST child of a flex
   * column whose other child is the screen container. Left in normal flow the
   * host would take real layout space and shrink every screen by the bar's
   * height, which is exactly what a floating bar must not do — so it is pulled
   * out of the flow and pinned to the bottom edge.
   *
   * It stays ZERO-HEIGHT on purpose: Bloom's bar is itself `position: absolute`
   * against this host, so it hangs off the host's bottom edge and needs nothing
   * from its box but that edge's position.
   *
   * `pointerEvents: 'box-none'` in the style object rather than as a prop —
   * react-native-web deprecated the prop and warns on every render.
   */
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'box-none',
  },
});
