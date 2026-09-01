/**
 * Bottom tabs for the inbox app.
 *
 * The bar is Bloom's floating glass pill (`InboxTabBar`), supplied through the
 * navigator's `tabBar` slot. It replaced expo-router's `NativeTabs` — a real
 * platform UITabBar / BottomNavigationView — so the app matches the rest of the
 * ecosystem, and it renders on WEB too, where there was previously no bottom
 * navigation at all (the drawer was the only way between sections). The drawer
 * is unchanged; the bar is additional. This layout no longer has a `.web.tsx`
 * fork for that reason.
 *
 * The navigator underneath is still a real tab navigator rather than a `<Slot>`
 * plus a hand-rolled bar: `(inbox)`, `search` and `settings` are route groups
 * that each own a nested `<Stack>` with detail screens (a conversation, a
 * settings subpage), and only a tab navigator keeps those stacks alive across a
 * tab switch.
 *
 * hidden />` said before.
 *
 * Theming is no longer wired here: Bloom resolves all five of the bar's color
 * roles from the same `BloomThemeProvider` tokens `useColors()` reads, so it
 * follows the user's accent and a light/dark flip on its own.
 *
 * `TabBarMinimizeProvider` wraps the navigator so it is an ancestor of BOTH the
 * screens that drive the minimize signal and the bar that reads it. Mounted any
 * lower, `useMinimizeState()` silently hands each consumer its own local
 * fallback and the bar never minimizes, with no error anywhere.
 */

import { Tabs } from 'expo-router/tabs';
import { TabBarMinimizeProvider } from '@oxyhq/bloom/tab-bar';

import { InboxTabBar } from '@/components/InboxTabBar';
import { SearchFocusProvider } from '@/contexts/search-focus-context';

export default function TabsLayout() {
  return (
    <TabBarMinimizeProvider>
      {/*
        Wraps the navigator so it is an ancestor of both the tab bar (rendered
        inside `BottomTabView`) and the search screen that owns the input. That
        is what lets a tap on the search tab focus it — see `InboxTabBar`.
      */}
      <SearchFocusProvider>
        <Tabs tabBar={(props) => <InboxTabBar {...props} />} screenOptions={{ headerShown: false }}>
          <Tabs.Screen name="(inbox)" />
          <Tabs.Screen name="search" />
          <Tabs.Screen name="settings" />
          <Tabs.Screen name="subscriptions" options={{ href: null }} />
        </Tabs>
      </SearchFocusProvider>
    </TabBarMinimizeProvider>
  );
}
