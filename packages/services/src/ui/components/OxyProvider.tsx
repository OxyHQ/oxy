import { useEffect, useRef, useState, type FC } from 'react';
import { AppState, Platform, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { OxyProviderProps } from '../types/navigation';
import { OxyRuntimeProvider, type OxyRuntimeProviderProps } from '../context/OxyContext';
import { QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { SurfaceProvider } from '@oxyhq/bloom/surfaces';
import { ToastOutlet } from '@oxyhq/bloom/toast';
import { logger as loggerUtil } from '@oxyhq/core';
import { RequireOxyAuth } from './RequireOxyAuth';
import { attachQueryPersistence, createQueryClient } from '../hooks/queryClient';
import { createMemoryStorage, createPlatformStorage, type StorageInterface } from '../utils/storageHelpers';
import { isNetConnectivityOnline } from '../utils/netConnectivity';
import { KeyboardBoundary } from './KeyboardBoundary';
import { ProductAnalyticsObserver } from '../analytics/productAnalytics';

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
 * Provides authentication, session management, query client, and UI overlays.
 * Wraps its own overlay stack in SafeAreaProvider and GestureHandlerRootView so
 * the shared Bloom SURFACE STACK (`<SurfaceProvider>` / `<SurfaceHost>`) — which
 * hosts every SDK surface (the ~35 bottom-sheet routes + the AccountDialog) — can
 * safely render even when a consuming app has not mounted those providers yet.
 *
 * Usage:
 * ```tsx
 * import { OxyProvider, useAuth } from '@oxyhq/services';
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
 */
const OxyProvider: FC<OxyProviderProps> = ({
    oxyServices,
    children,
    onAuthStateChange,
    productAnalytics,
    storageKeyPrefix,
    clientId,
    baseURL,
    authWebUrl,
    authRedirectUri,
    authorizeBaseUrl,
    sessionMode = 'account',
    webAuthMode = 'popup',
    queryClient: providedQueryClient,
    requireAuth = 'off',
    backgroundSession = false,
    deviceCredentialStorage = 'persistent',
}) => {

    // Storage + persistence wiring.
    //
    // The QueryClient exists synchronously so cache I/O can never delay the app
    // tree's first render. Persistence hydrates in the background; TanStack's
    // persisted-client timestamps prevent older stored data from replacing a
    // newer query that settled while restore was in flight.
    const queryClientRef = useRef<ReturnType<typeof createQueryClient> | null>(null);
    const persistenceUnsubRef = useRef<(() => void) | null>(null);
    const ownsQueryClientRef = useRef(providedQueryClient === undefined);
    const [platformStorage, setPlatformStorage] = useState<StorageInterface | null>(null);

    // If the consumer supplied their own QueryClient we use it as-is and skip
    // persistence — their host app owns that lifecycle.
    const [queryClient] = useState<ReturnType<typeof createQueryClient>>(() => {
        if (providedQueryClient) {
            queryClientRef.current = providedQueryClient;
            return providedQueryClient;
        }
        const client = createQueryClient();
        queryClientRef.current = client;
        return client;
    });

    useEffect(() => {
        let mounted = true;

        const bootstrap = async (): Promise<void> => {
            let storage: StorageInterface | null = null;
            try {
                storage = await createPlatformStorage();
            } catch (error) {
                if (__DEV__) {
                    loggerUtil.warn('Failed to initialize storage for query persistence', { component: 'OxyProvider' }, error);
                }
                storage = createMemoryStorage();
            }

            if (!mounted) return;

            setPlatformStorage(storage);
            const client = queryClientRef.current;
            if (!client || !ownsQueryClientRef.current) return;
            const persistence = attachQueryPersistence(client, storage);
            persistenceUnsubRef.current = persistence.unsubscribe;
            await persistence.restored;
        };

        bootstrap();

        return () => {
            mounted = false;
            persistenceUnsubRef.current?.();
            persistenceUnsubRef.current = null;
        };
    }, []);

    // Hook React Query focus manager into app state (native) or visibility (web)
    useEffect(() => {
        if (isWeb) {
            // Web: use document visibility
            const handleVisibilityChange = () => {
                focusManager.setFocused(document.visibilityState === 'visible');
            };
            document.addEventListener('visibilitychange', handleVisibilityChange);
            return () => {
                document.removeEventListener('visibilitychange', handleVisibilityChange);
            };
        }
            // Native: use AppState
            const subscription = AppState.addEventListener('change', (state) => {
                focusManager.setFocused(state === 'active');
            });
            return () => {
                subscription.remove();
            };
    }, []);

    // Setup network status monitoring for offline detection
    useEffect(() => {
        let cleanup: (() => void) | undefined;

        const setupNetworkMonitoring = async () => {
            try {
                if (isWeb) {
                    // Web: use navigator.onLine
                    onlineManager.setOnline(navigator.onLine);
                    const handleOnline = () => onlineManager.setOnline(true);
                    const handleOffline = () => onlineManager.setOnline(false);

                    window.addEventListener('online', handleOnline);
                    window.addEventListener('offline', handleOffline);

                    cleanup = () => {
                        window.removeEventListener('online', handleOnline);
                        window.removeEventListener('offline', handleOffline);
                    };
                } else {
                    // Native: try to use NetInfo
                    try {
                        const NetInfo = await import('@react-native-community/netinfo');
                        const state = await NetInfo.default.fetch();
                        onlineManager.setOnline(isNetConnectivityOnline(state));

                        const unsubscribe = NetInfo.default.addEventListener((state: { isConnected: boolean | null; isInternetReachable?: boolean | null }) => {
                            onlineManager.setOnline(isNetConnectivityOnline(state));
                        });

                        cleanup = () => unsubscribe();
                    } catch {
                        // NetInfo not available, default to online
                        onlineManager.setOnline(true);
                    }
                }
            } catch (error) {
                // Default to online if detection fails
                onlineManager.setOnline(true);
            }
        };

        setupNetworkMonitoring();

        return () => {
            cleanup?.();
        };
    }, []);

    // Core content: QueryClient + OxyContext + UI overlays.
    //
    // Theming is owned by `@oxyhq/bloom`. Consumers must mount their own
    // `<BloomThemeProvider>` in their app root and configure it directly
    // (defaultColorPreset, defaultMode, persistKey, storage, fonts, etc.).
    // OxyProvider does NOT wrap a BloomThemeProvider — that would create a
    // duplicate scope that silently shadows the consumer's configuration.
    const coreContent = (
        <QueryClientProvider client={queryClient}>
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
                deviceCredentialStorage={deviceCredentialStorage}
                platformStorage={platformStorage}
                onAuthStateChange={onAuthStateChange as OxyRuntimeProviderProps['onAuthStateChange']}
            >
                {productAnalytics ? <ProductAnalyticsObserver analytics={productAnalytics} /> : null}
                <SurfaceProvider>
                    {requireAuth === 'off' ? (
                        children
                    ) : (
                        <RequireOxyAuth prompt={requireAuth}>{children}</RequireOxyAuth>
                    )}
                </SurfaceProvider>
                <ToastOutlet />
            </OxyRuntimeProvider>
        </QueryClientProvider>
    );

    return (
        <GestureHandlerRootView style={bootStyles.providerRoot}>
            <SafeAreaProvider>
                <KeyboardBoundary>
                    {coreContent}
                </KeyboardBoundary>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
};

export default OxyProvider;
