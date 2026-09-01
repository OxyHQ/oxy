// Tailwind v4 + NativeWind entry. Importing it here is what makes react-native-css
// compile the utility stylesheet for the web build so @oxyhq/services' className-based
// screens (the file-management cluster, etc.) render their layout on web instead of
// falling through to react-native-web's base View reset.
import '../global.css';

import { Stack, ThemeProvider } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import type { ReactNode } from 'react';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { OxyProvider , useOxy } from '@oxyhq/services';
import { BloomThemeProvider, useNavigationTheme } from '@oxyhq/bloom/theme';
import { ImageResolverProvider } from '@oxyhq/bloom/image-resolver';
import { ConnectionStatusToasts } from '@oxyhq/bloom/connection-status';


import { ScrollProvider } from '@/contexts/scroll-context';
import { ThemeModeProvider, useThemeMode } from '@/contexts/theme-mode-context';
import AppSplashScreen from '@/components/AppSplashScreen';
import { AppInitializer } from '@/lib/appInitializer';
import { LocaleProvider, useTranslation } from '@/lib/i18n';
import { MinimalErrorFallback } from '@/components/error-fallback';
import { OXY_CLIENT_ID, OXY_AUTH_REDIRECT_URI } from '@/constants/oxy';
import {
  preventNativeSplashAutoHide,
  useHideNativeSplashWhenReady,
} from '@oxyhq/expo-splash';

// Reanimated 4 ships with a strict logger that surfaces `.value` reads during
// render as runtime warnings. Several deeply nested third-party components in
// this app trip it; lowering the level to `warn` (without strict mode) keeps
// real errors visible while silencing the false-positive cascade.
configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false,
});

// NATIVE ONLY: hold the OS splash so it stays visible until the app has finished
// running init, then hide it once `appIsReady` flips (via
// `useHideNativeSplashWhenReady`). This makes the native OS splash the SINGLE
// splash on native — the Oxy mark (white silhouette) centered on the dark brand
// background with the Oxy symbol pinned to the bottom (configured by
// `@oxyhq/expo-splash` in app.config.js). The custom `AppSplashScreen` React
// overlay is gated to web only. No-op on web (the shared helper guards
// `Platform.OS === 'web'`).
preventNativeSplashAutoHide();

// Get API URL from environment variable with fallback
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

export const unstable_settings = {
  anchor: '(tabs)',
};

interface SplashState {
  initializationComplete: boolean;
  startFade: boolean;
  fadeComplete: boolean;
}

export default function RootLayout() {
  return (
    <ThemeModeProvider>
      <RootLayoutInner />
    </ThemeModeProvider>
  );
}

/**
 * Top-level error boundary. expo-router renders this whenever a render
 * error escapes any nested route, so an unexpected crash falls back to a
 * branded retry screen instead of an opaque white screen. Uses
 * `MinimalErrorFallback` so it works even if the Bloom theme provider
 * itself is the source of the crash.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <MinimalErrorFallback {...props} />;
}

function RootLayoutInner() {
  const { themeMode } = useThemeMode();

  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    startFade: false,
    fadeComplete: false,
  });

  const handleSplashFadeComplete = useCallback(() => {
    setSplashState((prev) => ({ ...prev, fadeComplete: true }));
  }, []);

  const initializeApp = useCallback(async () => {
    const result = await AppInitializer.initializeApp(true);
    // Always mark complete (even on error) to unblock the app
    setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    return result;
  }, []);

  // Derive the web splash fade trigger from state. `startFade` is fully derived
  // from initialization completing — there is no other trigger.
  const startFade = splashState.initializationComplete;

  const [appIsReady, setAppIsReady] = useState(false);

  // Readiness gate.
  // - WEB keeps the fade-gated flow: the custom <AppSplashScreen> renders, fades
  //   out when init completes, and its `onFadeComplete` sets `fadeComplete`, so
  //   web readiness = init complete AND the custom splash finished fading.
  // - NATIVE renders NO custom splash (the held OS splash covers the screen), so
  //   `onFadeComplete` never fires; native readiness = init complete ONLY, else
  //   the OS splash would hang forever.
  useEffect(() => {
    if (appIsReady) return;
    const ready =
      Platform.OS === 'web'
        ? splashState.initializationComplete && splashState.fadeComplete
        : splashState.initializationComplete;
    if (ready) {
      setAppIsReady(true);
    }
  }, [splashState.initializationComplete, splashState.fadeComplete, appIsReady]);

  // NATIVE ONLY: once ready, hide the held OS splash. The shared helper is a
  // no-op on web (the OS splash was never held; the custom overlay handles the
  // transition there).
  useHideNativeSplashWhenReady(appIsReady);

  // Fire-and-forget initializer once per mount. A ref guard is required for
  // React 19 Strict Mode, which intentionally double-invokes effects in
  // development to surface side-effect bugs.
  const initStartedRef = useRef(false);
  useEffect(() => {
    if (initStartedRef.current) return;
    initStartedRef.current = true;
    initializeApp();
  }, [initializeApp]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        {/* OxyProvider does NOT wrap a BloomThemeProvider — by design, to
            avoid duplicate contexts when an app already ships its own (see
            packages/services/src/ui/components/OxyProvider.tsx). The consumer
            (this app) owns the BloomThemeProvider and feeds it the resolved
            theme mode from ThemeModeProvider. */}
        <BloomThemeProvider mode={themeMode}>
          <ConnectionStatusToasts />
          <OxyProvider baseURL={API_URL} clientId={OXY_CLIENT_ID} authRedirectUri={OXY_AUTH_REDIRECT_URI}>
            <AppImageResolver>
              <LocaleProvider>
                <AppHead />
                {!appIsReady ? (
                  // WEB: the custom splash covers init and fades out; its
                  // `onFadeComplete` gates `appIsReady`. NATIVE renders null
                  // here — the held OS splash is on top, so nothing underneath
                  // needs to paint.
                  Platform.OS === 'web' ? (
                    <AppSplashScreen
                      startFade={startFade}
                      onFadeComplete={handleSplashFadeComplete}
                    />
                  ) : null
                ) : (
                  <AppStackContent />
                )}
              </LocaleProvider>
            </AppImageResolver>
          </OxyProvider>
        </BloomThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Registers the canonical Oxy `ImageResolver` so every Bloom `Avatar` in the
 * tree (e.g. the sidebar `ProfileButton`) resolves a bare file id to a
 * variant-aware URL via `oxyServices.getFileDownloadUrl`. Without it, avatars
 * fall back to rendering initials. Must live inside `OxyProvider` so `useOxy()`
 * has a client. Defaults the variant to `thumb` for the small avatar surfaces.
 */
function AppImageResolver({ children }: { children: ReactNode }) {
  const { oxyServices } = useOxy();
  return (
    <ImageResolverProvider
      value={(id, variant) => oxyServices.getFileDownloadUrl(id, variant ?? 'thumb')}
    >
      {children}
    </ImageResolverProvider>
  );
}

/** Document head with translated title/description. Lives inside <LocaleProvider>. */
function AppHead() {
  const { t } = useTranslation();
  return (
    <Head>
      <title>{t('head.title')}</title>
      <meta name="description" content={t('head.description')} />
    </Head>
  );
}

/** Renders the navigation stack once the app is ready. */
function AppStackContent() {
  // Must be called inside OxyProvider (which wraps BloomThemeProvider)
  const navTheme = useNavigationTheme();
  const { isAuthenticated, isAuthResolved } = useOxy();

  // Accounts is a management-only app: identity CREATION lives in Commons, so
  // the `(auth)` group is sign-in only. The root Stack is the SOLE authority
  // for the `(auth)`↔`(tabs)` swap, and it keys PURELY on session — never on a
  // local identity key (Accounts holds none).
  //
  // Until cold boot resolves the session (`isAuthResolved === false`) we treat
  // the user as needing auth and render `(auth)`; the sign-in screen shows a
  // neutral backdrop during that window so a returning user does not flash the
  // sign-in form before their session is restored. Once resolved, the swap is
  // driven by `isAuthenticated` alone. Expo Router resolves redirects to the
  // first non-redirecting sibling, so exactly one group is active at any time.
  const needsAuth = isAuthResolved ? !isAuthenticated : true;

  // No `<SafeAreaProvider>` here: this subtree renders inside the provider
  // above, which mounts one itself (on both the ready and the boot-shell
  // path). A second, deeper one only re-measures the same full-screen frame.
  return (
    <ScrollProvider>
      <ThemeProvider value={navTheme}>
        <Stack>
          <Stack.Screen name="(tabs)" redirect={needsAuth} options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" redirect={!needsAuth} options={{ headerShown: false }} />
        </Stack>
        <StatusBar style="auto" />
      </ThemeProvider>
    </ScrollProvider>
  );
}
