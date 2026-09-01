// Tailwind v4 + NativeWind entry — compiles className utilities for web so
// @oxyhq/services screens (FileManagement, etc.) render layout correctly.
import '../global.css';

import { Stack, ThemeProvider } from 'expo-router';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';
import 'react-native-reanimated';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { OxyProvider, useOxy, RequireOxyAuth } from '@oxyhq/services';
import { toast } from '@oxyhq/bloom';
import { ImageResolverProvider } from '@oxyhq/bloom/image-resolver';
import type { ImageResolver } from '@oxyhq/bloom/image-resolver';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigationTheme } from '@oxyhq/bloom/theme';
import { BloomProvider } from '@oxyhq/bloom/provider';
import type { ThemeMode } from '@oxyhq/bloom/theme';
import { Provider as PortalProvider, Outlet as PortalOutlet } from '@oxyhq/bloom/portal';

import { queryClient, clearPersistedInboxCache, restoredInboxCache } from '@/hooks/queries/queryClient';
import { ThemeProvider as AppThemeProvider, useThemeContext } from '@/contexts/theme-context';
import { InboxPrefsProvider } from '@/contexts/inbox-prefs-context';
import { LocaleProvider, useTranslation } from '@/lib/i18n';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useInboxSocket } from '@/hooks/useInboxSocket';
import { usePushRegistration } from '@/hooks/usePushRegistration';
import { useEmailStore } from '@/hooks/useEmail';
import { registerServiceWorker } from '@/utils/registerServiceWorker';
import { onConnectivityChange, flushQueue } from '@/utils/offlineQueue';
import { OXY_CLIENT_ID, OXY_AUTH_REDIRECT_URI } from '@/constants/oxy';
import * as SplashScreen from 'expo-splash-screen';

// Hide the native splash immediately on import. Font loading is owned entirely
// by `BloomProvider`'s `FontLoader`, which gates its own subtree and
// applies the default family via `Text.defaultProps` once the bundled families
// are ready. No artificial wait is required here before unhiding the splash.
SplashScreen.hideAsync().catch(() => {
  // hideAsync rejects if the splash has already been hidden (e.g. during a
  // fast-refresh re-import). The state is idempotent, so swallow this case.
});

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <Head.Provider>
        <AppThemeProvider>
          <InboxPrefsProvider>
            <ThemedRoot />
          </InboxPrefsProvider>
        </AppThemeProvider>
      </Head.Provider>
    </ErrorBoundary>
  );
}

/**
 * Reads the persisted theme preferences from `AppThemeProvider` and feeds
 * them into `BloomProvider`, which owns the react-navigation theme
 * (via `useNavigationTheme`) AND the resolved colors consumed throughout
 * the tree. `OxyProvider` does NOT mount its own `BloomProvider`
 * (see `packages/services/src/ui/components/OxyProvider.tsx`), so this is
 * the single source of truth.
 */
function ThemedRoot() {
  const { themePreference, colorPreset } = useThemeContext();
  const themeMode = themePreference as ThemeMode;
  return (
    <BloomProvider mode={themeMode} colorPreset={colorPreset}>
      <RootLayoutContent />
    </BloomProvider>
  );
}

function RootLayoutContent() {
  const navTheme = useNavigationTheme();

  return (
    <KeyboardProvider>
      {/*
        LocaleProvider sits INSIDE OxyProvider so it can read the signed-in
        user's `language` preference via `useOxy()` and seed the initial
        locale accordingly. Persisted overrides flow through AsyncStorage.

        The app's `queryClient` is handed to `OxyProvider`, which owns the
        single `QueryClientProvider` for the tree. Passing it here (rather than
        wrapping OxyProvider in an outer provider) guarantees the SDK's account
        hooks and the app's email hooks share ONE cache, so a render-time reset
        in `RootEffects` actually clears the data the UI reads.
      */}
      <OxyProvider baseURL={API_URL} clientId={OXY_CLIENT_ID} authRedirectUri={OXY_AUTH_REDIRECT_URI} queryClient={queryClient}>
        <InboxCacheRestoreGate>
          <BloomImageResolver>
            <LocaleProvider>
              <SafeAreaProvider>
                <PortalProvider>
                  <ThemeProvider value={navTheme}>
                    <RootEffects />
                    {/*
                    The whole app is gated behind the shared SDK signed-out wall
                    (`RequireOxyAuth prompt="hard"`). It replaces the former
                    hand-rolled sign-in gate: it blocks the navigator until the
                    device-first cold boot resolves a session, shows a neutral
                    loading state while pending (never flashes the wall), and its
                    primary CTA opens the ONE shared account dialog. See
                    `GatedNavigator` for the localized copy.
                  */}
                    <GatedNavigator />
                    <StatusBar style="auto" />
                  </ThemeProvider>
                  <PortalOutlet />
                </PortalProvider>
              </SafeAreaProvider>
            </LocaleProvider>
          </BloomImageResolver>
        </InboxCacheRestoreGate>
      </OxyProvider>
    </KeyboardProvider>
  );
}

/**
 * The app navigator, gated behind the shared SDK signed-out wall. `RequireOxyAuth`
 * (prompt="hard") keys on the SDK readiness state so it renders a neutral loading
 * state until the device-first cold boot resolves, then either mounts the
 * navigator (signed in) or the centered signed-out wall whose CTA opens the ONE
 * account dialog. Lives under `LocaleProvider` so the localized copy resolves.
 */
function GatedNavigator() {
  const { t } = useTranslation();
  return (
    <RequireOxyAuth prompt="hard" title={t('auth.gate.title')} subtitle={t('auth.gate.subtitle')}>
      <Stack>
        <Stack.Screen name="(drawer)" options={{ headerShown: false }} />
        <Stack.Screen name="+not-found" options={{ headerShown: false }} />
      </Stack>
    </RequireOxyAuth>
  );
}

/**
 * Block the mail UI until the persisted TanStack Query cache has been hydrated.
 * OxyProvider skips persistence restore when a host `queryClient` is supplied,
 * so Inbox owns that lifecycle here.
 */
function InboxCacheRestoreGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let mounted = true;
    void restoredInboxCache.then(() => {
      if (mounted) setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!ready) {
    return <View style={{ flex: 1, backgroundColor: '#ffffff' }} />;
  }

  return children;
}

/**
 * Registers the single Bloom `ImageResolver` for the app. Bloom `Avatar`s
 * (and any other Bloom media surface) that receive a bare Oxy file ID in
 * `source` resolve it through `oxyServices.getFileDownloadUrl(id, variant)` —
 * the one chokepoint where the canonical `cloud.oxy.so`/signed URL is built.
 * Lives inside `OxyProvider` so `useOxy()` is available.
 */
function BloomImageResolver({ children }: { children: ReactNode }) {
  const { oxyServices } = useOxy();
  const resolve = useCallback<ImageResolver>(
    (id, variant) => oxyServices.getFileDownloadUrl(id, variant),
    [oxyServices],
  );
  return <ImageResolverProvider value={resolve}>{children}</ImageResolverProvider>;
}

/**
 * Renders no UI — runs the web-only side effects (service worker registration,
 * offline-queue flush listener, Bloom Dialog keyframes) inside `LocaleProvider`
 * so that translated toast strings are available when those handlers fire.
 */
function RootEffects() {
  const { t } = useTranslation();
  const { user, activeSessionId } = useOxy();
  const queryClient = useQueryClient();

  // Reset account-scoped cache/UI state DURING render (not in an effect) the
  // instant the active Oxy session changes. `activeSessionId` covers switching
  // between distinct accounts AND between sessions of the same user. Doing this
  // as a render-time adjustment — the React-blessed pattern for syncing derived
  // state to an external identity — avoids the intermediate frame where the UI
  // would still show the previous account's cached mail. See
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const accountKey = activeSessionId ?? user?.id ?? null;
  const prevAccountKeyRef = useRef(accountKey);
  if (prevAccountKeyRef.current !== accountKey) {
    prevAccountKeyRef.current = accountKey;
    queryClient.clear();
    // Drop the persisted blob too so the next cold start can't restore the
    // previous account's mail after an account switch / sign-out.
    void clearPersistedInboxCache();
    useEmailStore.getState().resetAccountScopedState();
  }

  // Real-time inbox updates. The hook is a no-op until a user is signed in
  // and tears the socket down on sign-out or user switch; cache/state
  // invalidation above prevents cross-user inbox data reuse.
  useInboxSocket({ baseURL: API_URL });

  // Register this installation's Expo push token through the SDK when the user
  // has push notifications enabled (native only). No-op on web / signed-out.
  usePushRegistration();

  // Register service worker on web
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    registerServiceWorker(() => {
      toast.info(t('inbox.toast.newVersionAvailable'));
    });

    // Flush offline queue when connectivity returns
    const unsubscribe = onConnectivityChange((online) => {
      if (online) {
        flushQueue().then((count) => {
          if (count > 0) {
            toast.success(t('inbox.toast.offlineSync', { count }));
          }
        }).catch(() => {
          // Sync failure is non-fatal; queued actions will retry on next
          // connectivity-change event. Surface nothing to the user.
        });
      }
    });

    return unsubscribe;
  }, [t]);

  // Inject Bloom Dialog CSS keyframe animations on web
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const style = document.createElement('style');
    style.textContent = [
      '@keyframes bloomDialogFadeIn { from { opacity: 0; } to { opacity: 1; } }',
      '@keyframes bloomDialogFadeOut { from { opacity: 1; } to { opacity: 0; } }',
      '@keyframes bloomDialogZoomFadeIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }',
      '@keyframes bloomDialogZoomFadeOut { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.95); } }',
    ].join('\n');
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  return null;
}
