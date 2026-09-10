import React from 'react';
import { Tabs } from 'expo-router/tabs';
import { TabBarMinimizeProvider } from '@oxy.so/bloom/tab-bar';
import { ErrorFallback } from '@/components/error-fallback';
import { CommonsTabBar } from '@/components/CommonsTabBar';

/**
 * Bottom tab bar — the post-auth navigation shell for Commons.
 *
 * The bar itself is Bloom's floating glass pill (`CommonsTabBar`), rendered
 * through the navigator's `tabBar` slot. It replaced the platform `NativeTabs`
 * bar so Commons matches the rest of the ecosystem; the navigator underneath is
 * still a real tab navigator, which is what keeps each group's nested `<Stack>`
 * alive when the user switches tabs. Three static tabs, each backed by its own
 * route group + nested `<Stack>` (the tabs render no headers, so each group owns
 * its titles and detail-screen pushes):
 *
 *   (id)         ID           — Oxy ID card + identity overview + scanned-card view
 *   (reputation) Reputación   — reputation breakdown
 *   (settings)   Ajustes      — identity/vault management
 *
 * `(id)` is declared first, so the bar lands there on cold start. The QR scanner
 * is NOT a tab — it is an action opened from the ID landing's Bloom FAB as a
 * root-level full-screen modal (`app/(scan)`).
 *
 * `name` MUST match each route-group folder name INCLUDING parentheses.
 *
 * Theming is no longer wired here: Bloom's bar resolves all five of its colors
 * from the same `BloomThemeProvider` tokens `useColors()` reads, so it follows a
 * light/dark flip and the active preset on its own. The surrounding navigation
 * chrome still inherits Bloom via the root layout's
 * `ThemeProvider value={useNavigationTheme()}`.
 *
 * `TabBarMinimizeProvider` wraps the navigator rather than sitting inside it: it
 * has to be an ancestor of BOTH the screens that drive the minimize signal
 * (through `ScreenContentWrapper`'s scroll handler) and the bar that reads it.
 * Mounted any lower, `useMinimizeState()` silently hands each consumer its own
 * local fallback and the bar never minimizes, with no error anywhere.
 */
export default function TabsLayout() {
  return (
    <TabBarMinimizeProvider>
      <Tabs tabBar={(props) => <CommonsTabBar {...props} />} screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="(id)" />
        <Tabs.Screen name="(reputation)" />
        <Tabs.Screen name="(settings)" />
      </Tabs>
    </TabBarMinimizeProvider>
  );
}

/**
 * Route-level error boundary for the whole tab tree. expo-router renders this
 * when a render error escapes any tab's stack.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <ErrorFallback {...props} />;
}
