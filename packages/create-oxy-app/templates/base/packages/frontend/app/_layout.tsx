// Tailwind v4 + NativeWind entry. Importing it here is what makes react-native-css
// compile the utility stylesheet for the web build, so className layout utilities
// (from this app and @oxy.so/services) render on web instead of falling through to
// react-native-web's base View reset. Pairs with postcss.config.mjs.
import '../global.css';

import type { ReactNode } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useOxy } from '@oxy.so/services';
import { preventNativeSplashAutoHide, useHideNativeSplashWhenReady } from '@oxy.so/expo-splash';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { expoRouterScrollAdapter } from '@oxy.so/bloom/scroll/expo-router';
import { ImageResolverProvider } from '@oxy.so/bloom/image-resolver';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { API_URL, OXY_CLIENT_ID } from '@/lib/config';
import { queryClient } from '@/lib/queryClient';
import { THEME_PERSIST_KEY, themeStorage } from '@/lib/themePersistence';
import { LocaleProvider } from '@/lib/i18n';
import { ErrorFallback } from '@/components/error-fallback';

// Native only (no-op on web): hold the OS splash until cold boot knows whether
// there is a session, so the first frame is the right group rather than a flash
// of the sign-in screen. `AuthRouter` hides it.
preventNativeSplashAutoHide();

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
    <BloomProvider
      scrollAdapter={expoRouterScrollAdapter}
      persistKey={THEME_PERSIST_KEY}
      storage={themeStorage}
    >
      <ConnectionStatusToasts />
      {/* OxyProvider owns the gesture, safe-area and keyboard roots, the QueryClient
          and session authority. Keep one of each below Bloom's composition root. */}
      <OxyProvider baseURL={API_URL} clientId={OXY_CLIENT_ID} queryClient={queryClient}>
        <AppImageResolver>
          <LocaleProvider>
            <AuthRouter />
            <StatusBar style="auto" />
          </LocaleProvider>
        </AppImageResolver>
      </OxyProvider>
    </BloomProvider>
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
    <ImageResolverProvider value={(id, variant) => oxyServices.assets.publicUrl(id, variant ?? 'thumb')}>
      {children}
    </ImageResolverProvider>
  );
}

/**
 * The root Stack is the SOLE authority for the `(auth)`↔`(app)` group swap,
 * keyed purely on session. Until cold boot resolves (`isAuthResolved === false`)
 * we treat the user as needing auth; once resolved, `isAuthenticated` drives it.
 * Each group is reachable only while its `Stack.Protected` guard holds, and
 * expo-router sends a blocked navigation to the group that is open.
 */
function AuthRouter() {
  const { isAuthenticated, isAuthResolved } = useOxy();
  const needsAuth = isAuthResolved ? !isAuthenticated : true;
  useHideNativeSplashWhenReady(isAuthResolved);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!needsAuth}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={needsAuth}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
    </Stack>
  );
}
