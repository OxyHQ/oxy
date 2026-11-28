import { OxySupportContext } from '../context/oxySupportContext';
import { useEffect, useState, useMemo, type FC } from 'react';
import { AppState, Platform, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import type { OxyProviderProps } from '../types/navigation';
import { OxyRuntimeProvider, type OxyRuntimeProviderProps } from '../context/OxyContext';
import { OxyHostedRuntimeProvider } from '../context/OxyHostedContext';
import { getOxySessionHost } from '@oxy.so/core/host';
import { environment } from '@oxy.so/bloom-data';
import { SurfaceProvider } from '@oxy.so/bloom/surfaces';
import { ToastOutlet } from '@oxy.so/bloom/toast';
import { logger as loggerUtil } from '@oxy.so/core';
import { RequireOxyAuth } from './RequireOxyAuth';
import {
  createMemoryStorage,
  createPlatformStorage,
  type StorageInterface,
} from '../utils/storageHelpers';
import { isNetConnectivityOnline } from '../utils/netConnectivity';
import { KeyboardBoundary } from './KeyboardBoundary';
import { SafeAreaRoot } from './SafeAreaRoot';
import { ProductAnalyticsObserver } from '../analytics/productAnalytics';
import { AccountLanguageBoundary } from './AccountLanguageBoundary';
import { BloomLocaleBridge } from './BloomLocaleBridge';
import { SupervisionStateObserver } from '../hooks/queries/useSupervision';
import { AccountDialogHostProvider } from './signIn/accountDialogHost';

const bootStyles = StyleSheet.create({
  providerRoot: {
    flex: 1,
  },
});

// Detect if running on web
const isWeb = Platform.OS === 'web';

/**
 * OxyProvider - Universal provider for Expo apps (native + web)
 *
 * Provides authentication, session management, the account data stores and UI overlays.
 * Wraps its own overlay stack in a safe-area root (`SafeAreaRoot`: the native
 * SafeAreaProvider on a device, the window's metrics on web) and
 * GestureHandlerRootView so the shared Bloom SURFACE STACK (`<SurfaceProvider>` / `<SurfaceHost>`) — which
 * hosts every SDK surface (the ~35 bottom-sheet routes + the AccountDialog) — can
 * safely render even when a consuming app has not mounted those providers yet.
 *
 * Usage:
 * ```tsx
 * import { OxyProvider, useAuth } from '@oxy.so/services';
 *
 * function App() {
 *   return (
 *     <SafeAreaProvider>
 *       <GestureHandlerRootView style={{ flex: 1 }}>
 *         <OxyProvider baseURL="https://api.oxy.so">
 *           <YourApp />
 *         </OxyProvider>
 *       </GestureHandlerRootView>
 *     </SafeAreaProvider>
 *   );
 * }
 *
 * function MyComponent() {
 *   const { isAuthenticated, user, signIn, signOut } = useAuth();
 *
 *   if (!isAuthenticated) {
 *     return <OxySignInButton />;
 *   }
 *   return <Text>Welcome, {user?.username}!</Text>;
 * }
 * ```
 *
 * An app with its own translated UI passes a language config to follow the account's
 * (or, signed out, the device/guest) resolved locale automatically — see ADR
 * 0022 (`docs/adr/0022-app-i18n-follows-oxy-language.md`):
 * ```tsx
 * <OxyProvider
 *   baseURL="https://api.oxy.so"
 *   language={{
 *     supportedLocales: SUPPORTED_LANGUAGES,       // this app's own catalog
 *     fallbackLocale: DEFAULT_LANGUAGE,
 *     onChange: (locale) => i18n.changeLanguage(locale),
 *   }}
 * >
 * ```
 */
const OxyProvider: FC<OxyProviderProps> = ({
  oxyServices,
  children,
  onAuthStateChange,
  onAskAlia,
  documentationUrl,
  aliaAvatar,
  oxyOneArtwork,
  productAnalytics,
  storageKeyPrefix,
  clientId,
  appName,
  handlePreviewTemplate,
  baseURL,
  authWebUrl,
  authRedirectUri,
  authorizeBaseUrl,
  sessionMode = 'account',
  webAuthMode = 'popup',
  requireAuth = 'off',
  backgroundSession = false,
  language,
  campaignAttribution = false,
  authStateStore,
}) => {
  // A platform that holds the Oxy session (ADR 0058) registers its host before
  // the app's code runs. Read once, like `baseURL`: a host registered later
  // does not re-bind a mounted provider. `'identity'` is never hosted.
  const [sessionHost] = useState(() => (sessionMode === 'account' ? getOxySessionHost() : null));
  useEffect(() => {
    if (__DEV__ && sessionHost && authStateStore) {
      loggerUtil.warn(
        'OxyProvider: authStateStore is ignored — a platform holds the session here (session host)',
        { component: 'OxyProvider' },
      );
    }
  }, [sessionHost, authStateStore]);
  const support = useMemo(
    () => ({ onAskAlia, documentationUrl, aliaAvatar, oxyOneArtwork }),
    [onAskAlia, documentationUrl, aliaAvatar, oxyOneArtwork],
  );
  const [platformStorage, setPlatformStorage] = useState<StorageInterface | null>(null);

  useEffect(() => {
    let mounted = true;
    createPlatformStorage()
      .catch((error: unknown) => {
        if (__DEV__) {
          loggerUtil.warn('Failed to initialize storage', { component: 'OxyProvider' }, error);
        }
        return createMemoryStorage();
      })
      .then((storage) => {
        if (mounted) setPlatformStorage(storage);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // The device signals bloom-data reads (`environment`): whether the app is in
  // front, and whether it is online. On web it listens to the browser itself.
  useEffect(() => {
    if (isWeb) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      environment.setFocused(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (isWeb) return undefined;
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    // The one feeder of the online signal on a device (`utils/netConnectivity`).
    // A build without NetInfo's native module counts as online.
    import('@react-native-community/netinfo')
      .then(async (NetInfo) => {
        const state = await NetInfo.default.fetch();
        if (!mounted) return;
        environment.setOnline(isNetConnectivityOnline(state));
        unsubscribe = NetInfo.default.addEventListener((next) => {
          environment.setOnline(isNetConnectivityOnline(next));
        });
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  // Core content: OxyContext + UI overlays.
  //
  // Theming is owned by `@oxy.so/bloom`. Consumers must mount their own
  // `<BloomThemeProvider>` in their app root and configure it directly
  // (defaultColorPreset, defaultMode, persistKey, storage, fonts, etc.).
  // OxyProvider does NOT wrap a BloomThemeProvider — that would create a
  // duplicate scope that silently shadows the consumer's configuration.
  // It DOES set Bloom's locale (`BloomLocaleBridge`) to Oxy's language, but
  // defers to a locale the app already set above it.
  const providerChildren = (
    <>
      <SupervisionStateObserver />
      {productAnalytics ? <ProductAnalyticsObserver analytics={productAnalytics} /> : null}
      <AccountLanguageBoundary language={language}>
        <BloomLocaleBridge>
          <OxySupportContext.Provider value={support}>
            <SurfaceProvider>
              {requireAuth === 'off' ? (
                children
              ) : (
                <RequireOxyAuth prompt={requireAuth}>{children}</RequireOxyAuth>
              )}
            </SurfaceProvider>
          </OxySupportContext.Provider>
          <ToastOutlet />
        </BloomLocaleBridge>
      </AccountLanguageBoundary>
    </>
  );

  const coreContent = sessionHost ? (
    <OxyHostedRuntimeProvider
      session={sessionHost}
      oxyServices={oxyServices as OxyRuntimeProviderProps['oxyServices']}
      baseURL={baseURL}
      authWebUrl={authWebUrl}
      authRedirectUri={authRedirectUri}
      authorizeBaseUrl={authorizeBaseUrl}
      storageKeyPrefix={storageKeyPrefix}
      clientId={clientId}
      webAuthMode={webAuthMode}
      legacyLanguageKeys={language?.legacyStorageKeys}
      captureCampaignAttribution={campaignAttribution}
      platformStorage={platformStorage}
      onAuthStateChange={onAuthStateChange as OxyRuntimeProviderProps['onAuthStateChange']}
    >
      {providerChildren}
    </OxyHostedRuntimeProvider>
  ) : (
    <OxyRuntimeProvider
      oxyServices={oxyServices as OxyRuntimeProviderProps['oxyServices']}
      baseURL={baseURL}
      authWebUrl={authWebUrl}
      authRedirectUri={authRedirectUri}
      authorizeBaseUrl={authorizeBaseUrl}
      storageKeyPrefix={storageKeyPrefix}
      clientId={clientId}
      sessionMode={sessionMode}
      webAuthMode={webAuthMode}
      backgroundSession={backgroundSession}
      legacyLanguageKeys={language?.legacyStorageKeys}
      captureCampaignAttribution={campaignAttribution}
      platformStorage={platformStorage}
      authStateStore={authStateStore}
      onAuthStateChange={onAuthStateChange as OxyRuntimeProviderProps['onAuthStateChange']}
    >
      {providerChildren}
    </OxyRuntimeProvider>
  );

  return (
    <GestureHandlerRootView style={bootStyles.providerRoot}>
      <SafeAreaRoot>
        <KeyboardBoundary>
          <AccountDialogHostProvider
            appName={appName}
            handlePreviewTemplate={handlePreviewTemplate}
          >
            {coreContent}
          </AccountDialogHostProvider>
        </KeyboardBoundary>
      </SafeAreaRoot>
    </GestureHandlerRootView>
  );
};

export default OxyProvider;
