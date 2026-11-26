import type { ReactNode } from 'react';
import { Redirect, Slot, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useOxy } from '@oxy.so/services';
import { preventNativeSplashAutoHide, useHideNativeSplashWhenReady } from '@oxy.so/expo-splash';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { expoRouterScrollAdapter } from '@oxy.so/bloom/scroll/expo-router';
import { ImageResolverProvider } from '@oxy.so/bloom/image-resolver';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { API_URL, OXY_CLIENT_ID } from '@/lib/config';
import { THEME_PERSIST_KEY, themeStorage } from '@/lib/themePersistence';
import { LocaleProvider } from '@/lib/i18n';
import { ErrorFallback } from '@/components/error-fallback';

// Native only (no-op on web): hold the OS splash until cold boot knows whether
// there is a session, so the first frame is the right group rather than a flash
// of the sign-in screen. `AuthGate` hides it.
preventNativeSplashAutoHide();

/**
 * Top-level error boundary. expo-router renders this whenever a render error
 * escapes a nested route, so an unexpected crash falls back to a branded retry
 * screen instead of a blank white screen.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <ErrorFallback {...props} />;
}

/**
 * The providers, as React: the routes below them are the Bloom language
 * (`layout()` and `screen()` from `@oxy.so/bloom-language/router`).
 */
export default function RootLayout() {
  return (
    <BloomProvider
      scrollAdapter={expoRouterScrollAdapter}
      persistKey={THEME_PERSIST_KEY}
      storage={themeStorage}
    >
      <ConnectionStatusToasts />
      {/* OxyProvider owns the gesture, safe-area and keyboard roots and the
          session, and opens each account's @oxy.so/bloom-data store (the one
          lib/notes.ts writes to). Keep one of each below Bloom's root. */}
      <OxyProvider baseURL={API_URL} clientId={OXY_CLIENT_ID}>
        <AppImageResolver>
          <LocaleProvider>
            <AuthGate />
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
 * The sole authority for the `(auth)`↔`(app)` swap, keyed on the session. It
 * renders a `Slot`, not a stack: the app's one native stack is the language's
 * `Stack` in `(app)/_layout.tsx` (on Android the predictive-back stack, which
 * cannot share the app with expo-router's standard one). Until cold boot
 * resolves nothing is drawn under the held splash.
 */
function AuthGate() {
  const { isAuthenticated, isAuthResolved } = useOxy();
  const segments = useSegments();
  useHideNativeSplashWhenReady(isAuthResolved);

  if (!isAuthResolved) return null;
  const inAuthGroup = segments[0] === '(auth)';
  if (!isAuthenticated && !inAuthGroup) return <Redirect href="/sign-in" />;
  if (isAuthenticated && inAuthGroup) return <Redirect href="/" />;
  return <Slot />;
}
