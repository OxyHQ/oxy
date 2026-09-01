// Tailwind v4 + NativeWind entry. Importing it here is what makes react-native-css
// compile the utility stylesheet for the web build, so className layout utilities
// (from this app and @oxyhq/services) render on web instead of falling through to
// react-native-web's base View reset. Pairs with postcss.config.mjs.
import '../global.css';

import type { ReactNode } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';
import { ImageResolverProvider } from '@oxyhq/bloom/image-resolver';
import { ConnectionStatusToasts } from '@oxyhq/bloom/connection-status';
import { API_URL, OXY_CLIENT_ID } from '@/lib/config';
import { queryClient } from '@/lib/queryClient';
import { THEME_PERSIST_KEY, themeStorage } from '@/lib/themePersistence';
import { LocaleProvider } from '@/lib/i18n';
import { ErrorFallback } from '@/components/error-fallback';

/**
 * Top-level error boundary. expo-router renders this whenever a render error
 * escapes a nested route, so an unexpected crash falls back to a branded retry
 * screen instead of a blank white screen.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <ErrorFallback {...props} />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          {/* BloomThemeProvider is the outermost theming authority — it must wrap
              every render branch, including any pre-auth backdrop. OxyProvider is
              the single session authority (web + native); it owns the QueryClient
              and never redirects to an external login. */}
          <BloomThemeProvider persistKey={THEME_PERSIST_KEY} storage={themeStorage}>
            <ConnectionStatusToasts />
            <OxyProvider baseURL={API_URL} clientId={OXY_CLIENT_ID} queryClient={queryClient}>
              <AppImageResolver>
                <LocaleProvider>
                  <AuthRouter />
                  <StatusBar style="auto" />
                </LocaleProvider>
              </AppImageResolver>
            </OxyProvider>
          </BloomThemeProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Registers the Oxy `ImageResolver` so every Bloom `Avatar` resolves a bare file
 * id to a variant-aware URL. Must live inside OxyProvider so `useOxy()` has a
 * client.
 */
function AppImageResolver({ children }: { children: ReactNode }) {
  const { oxyServices } = useOxy();
  return (
    <ImageResolverProvider value={(id, variant) => oxyServices.getFileDownloadUrl(id, variant ?? 'thumb')}>
      {children}
    </ImageResolverProvider>
  );
}

/**
 * The root Stack is the SOLE authority for the `(auth)`↔`(app)` group swap,
 * keyed purely on session. Until cold boot resolves (`isAuthResolved === false`)
 * we treat the user as needing auth; once resolved, `isAuthenticated` drives it.
 */
function AuthRouter() {
  const { isAuthenticated, isAuthResolved } = useOxy();
  const needsAuth = isAuthResolved ? !isAuthenticated : true;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(app)" redirect={needsAuth} />
      <Stack.Screen name="(auth)" redirect={!needsAuth} />
    </Stack>
  );
}
