import { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { TabBar, TabBarButton, type TabBarItem } from '@oxyhq/bloom/tab-bar';
import {
  Envelope_Filled_Stroke2_Corner0_Rounded,
  Envelope_Stroke2_Corner0_Rounded,
  MagnifyingGlass_Filled_Stroke2_Corner0_Rounded,
  MagnifyingGlass_Stroke2_Corner0_Rounded,
  SettingsGear2_Filled_Corner0_Rounded,
  SettingsGear2_Stroke2_Corner0_Rounded,
} from '@oxyhq/bloom/icons';
import type { BottomTabBarProps } from 'expo-router/tabs';

import { useSearchFocus } from '@/contexts/search-focus-context';
import { useIsDesktopLayout } from '@/hooks/useIsDesktopLayout';
import { useTranslation } from '@/lib/i18n';

/**
 * Route names of the visible tabs, in bar order. The array is the single source
 * of truth for the mapping between a bar index and a route: `activeIndex` is
 * derived by looking the focused route up in it, and a press navigates to the
 * entry at the pressed index. Deriving both from one list is what keeps the
 * highlight correct through deep links and the back gesture, which move the
 * navigator without going through the bar.
 *
 * Routes with no matching entry (a conversation, compose) leave `activeIndex`
 * at -1, and the bar shows no selection.
 */
const TAB_ROUTES = ['(inbox)', 'search', 'settings'] as const;

/**
 * Glyph size. Bloom icons take a size KEYWORD, not a number; `md` is 20px,
 * which is what the bar's own 21px glyph box is built around.
 */
const ICON_SIZE = 'md';

/**
 * Ceiling on the pill's width, in points.
 *
 * The desktop layout hides the bar above 900pt, but two common iPads sit BELOW
 * that and so still get it: iPad mini portrait (744pt) and iPad 11" portrait
 * (834pt), where an unconstrained bar spans 720pt and 810pt respectively and
 * leaves three 21pt glyphs adrift in cells hundreds of points wide. Bloom
 * derives the item width from the window, so this cannot be fixed with a
 * `style` override: the highlight and the scrub hit-testing would still divide
 * the WINDOW width.
 *
 * 440 is the width of the largest phone screen currently shipping (iPhone 16
 * Pro Max), so the pill can never be wider than a big phone's whole display.
 * `maxWidth` is a CEILING and never a floor, so no phone is affected: the
 * widest phone pill is 416pt (440 minus the bar's 12pt margin per side), which
 * is under this and therefore stays full-bleed. Matches the value commons uses
 * — same three-tab bar, same design language, no reason for them to differ.
 */
const TAB_BAR_MAX_WIDTH = 440;

/**
 * The Inbox bottom bar: Bloom's floating glass pill, driven by the tab
 * navigator's own state.
 *
 * It replaces the platform `NativeTabs` bar, and unlike that bar it renders on
 * WEB too, where the app previously had no bottom navigation at all (the drawer
 * was the only way between sections). The drawer stays; the bar is additional.
 *
 * Each tab carries an outline/filled icon PAIR, supplied as `icon` +
 * `activeIcon` so the bar's crossfade swaps SHAPES the way the SF Symbol pair
 * (`envelope` / `envelope.fill`) did, rather than tinting one shape twice.
 *
 * `sfSymbol` is deliberately NOT set: it would render an SF Symbol on iOS and a
 * Bloom icon everywhere else, so the three platforms would disagree about the
 * shape of the same tab.
 */
export function InboxTabBar({ state, navigation }: BottomTabBarProps) {
  const { t } = useTranslation();

  // The bar is for NARROW layouts only. On a wide viewport the mailbox drawer
  // is `permanent` and is the whole navigation, exactly as before this bar
  // existed — so the bar would be a second, redundant navigation next to it.
  // Both read the SAME `useIsDesktopLayout()`, which is what stops a viewport
  // from ever showing both or neither, and it re-renders on resize so dragging
  // a window across the breakpoint gains and loses the bar cleanly.
  const isDesktopLayout = useIsDesktopLayout();

  // The native bar hid itself while the OS keyboard was up (`NativeTabs`'
  // `hidden` prop). Bloom's bar has no such prop, so the host unmounts it
  // instead — the same result, and the selector only re-renders when the
  // visibility boolean actually flips. `KeyboardProvider` is already mounted at
  // the app root in `app/_layout.tsx`.
  const keyboardVisible = useKeyboardState((keyboard) => keyboard.isVisible);

  const items = useMemo<TabBarItem[]>(
    () => [
      {
        name: '(inbox)',
        label: t('tabs.inbox'),
        icon: <Envelope_Stroke2_Corner0_Rounded size={ICON_SIZE} />,
        activeIcon: <Envelope_Filled_Stroke2_Corner0_Rounded size={ICON_SIZE} />,
      },
      {
        name: 'search',
        label: t('tabs.search'),
        icon: <MagnifyingGlass_Stroke2_Corner0_Rounded size={ICON_SIZE} />,
        activeIcon: <MagnifyingGlass_Filled_Stroke2_Corner0_Rounded size={ICON_SIZE} />,
      },
      {
        name: 'settings',
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

  const { focusInput } = useSearchFocus();

  const handleIndexChange = useCallback(
    (index: number) => {
      const route = TAB_ROUTES[index];
      if (route === undefined) return;

      navigation.navigate(route);

      // Tapping Search puts the caret in the search field. The bar fires this
      // on EVERY tap, including one on the tab that is already focused, so the
      // same signal covers both arriving at search and re-tapping while already
      // there — no separate re-tap mechanism is needed.
      //
      // Ordering matters: `navigate` first, then focus. When the user is
      // already on search the input is mounted and this focuses it right away.
      // When arriving from another tab the screen has not mounted yet, so this
      // finds no input and no-ops; `SearchHeader`'s own `autoFocus` handles
      // that case, as it already does for `/search` reached from the inbox
      // screen's search affordance or a deep link. One mechanism per case
      // rather than a queue that would duplicate what mounting already does.
      if (route === 'search') {
        focusInput();
      }
    },
    [navigation, focusInput],
  );

  if (isDesktopLayout || keyboardVisible) return null;

  return (
    <View style={styles.host}>
      <TabBar
        activeIndex={activeIndex}
        onIndexChange={handleIndexChange}
        maxWidth={TAB_BAR_MAX_WIDTH}
        // The blur band is 114pt tall and full-bleed, so the inbox screen's
        // Compose and Alia FABs sit inside it and would be blurred and tinted.
        // No z-order can lift a screen's FAB above the bar's host — it is
        // inside an earlier sibling — so switching the band off is the only
        // fix. It stays ON for search and settings, which float nothing at the
        // bottom edge and where dissolving content behind the pill is the point.
        blur={focusedRouteName !== '(inbox)'}
      >
        {items.map((item, index) => (
          <TabBarButton key={item.name} item={item} index={index} />
        ))}
      </TabBar>
    </View>
  );
}

InboxTabBar.displayName = 'InboxTabBar';

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
