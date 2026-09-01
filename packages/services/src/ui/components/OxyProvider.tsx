import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { AppState, Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { OxyProviderProps } from '../types/navigation';
import { OxyContextProvider, type OxyContextProviderProps } from '../context/OxyContext';
import { QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { BloomDialogProvider } from '@oxyhq/bloom';
import { SurfaceProvider } from '@oxyhq/bloom/surfaces';
import { ToastOutlet } from '@oxyhq/bloom/toast';
import { logger as loggerUtil } from '@oxyhq/core';
import { RequireOxyAuth } from './RequireOxyAuth';
import { attachQueryPersistence, createQueryClient } from '../hooks/queryClient';
import { createPlatformStorage, type StorageInterface } from '../utils/storageHelpers';

/**
 * Background color shown for the brief window between mount and the
 * persisted-cache hydration completing. Matches the typical splash-screen
 * backgrounds used across Oxy apps (dark surface, white-on-dark text), so
 * the transition reads as a continuation of the splash instead of a
 * white flash. Apps that need a different boot color can keep doing their
 * own `expo-splash-screen` orchestration — this placeholder just guarantees
 * we never render a transparent `null` while we wait.
 *
 * Light-mode background. Apps that boot into dark mode see a brief light
 * flash here, which is unavoidable without re-implementing the BloomTheme
 * resolver outside of `<BloomThemeProvider>`. The light value is far less
 * jarring than `null` (transparent) on either theme.
 */
const BOOT_BG_COLOR = '#ffffff';

const bootStyles = StyleSheet.create({
    providerRoot: {
        flex: 1,
    },
    bootShell: {
        flex: 1,
        backgroundColor: BOOT_BG_COLOR,
    },
});

// Detect if running on web
const isWeb = Platform.OS === 'web';

// Variable indirection: the module name is computed at runtime so Metro's
// static analyzer cannot trace this into the web bundle. Native-only.
const KEYBOARD_CONTROLLER_MODULE = 'react-native-keyboard-controller';

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
    storageKeyPrefix,
    clientId,
    baseURL,
    authWebUrl,
    authRedirectUri,
    authorizeBaseUrl,
    sessionMode = 'account',
    webAuthMode = 'redirect',
    queryClient: providedQueryClient,
    requireAuth = 'off',
    hubSync = true,
}) => {

    // Dynamic KeyboardProvider for native. Uses variable indirection
    // (KEYBOARD_CONTROLLER_MODULE) so Metro's static analyzer cannot trace
    // the import into the web bundle. On web, the runtime guard short-circuits
    // before the import runs.
    const [KBProvider, setKBProvider] = useState<FC<{ children: ReactNode }> | null>(null);
    useEffect(() => {
        if (isWeb) return;
        const moduleName = KEYBOARD_CONTROLLER_MODULE;
        import(moduleName)
            .then((mod) => setKBProvider(() => mod.KeyboardProvider))
            .catch((error) => {
                if (__DEV__) {
                    loggerUtil.warn('react-native-keyboard-controller not available, skipping keyboard support', { component: 'OxyProvider' }, error);
                }
            });
    }, []);
    const KeyboardWrapper: FC<{ children: ReactNode }> = KBProvider ?? (({ children }) => <>{children}</>);

    // Storage + persistence wiring.
    //
    // We MUST await the restore() promise before exposing the QueryClient to
    // children — otherwise the first render sees an empty cache and any
    // <Suspense> queries or `enabled: !!cached` gates would skip the offline
    // hit. Once the persisted blob has been hydrated (or definitively failed
    // to hydrate), we mark the client ready and unblock rendering.
    const storageRef = useRef<StorageInterface | null>(null);
    const queryClientRef = useRef<ReturnType<typeof createQueryClient> | null>(null);
    const persistenceUnsubRef = useRef<(() => void) | null>(null);

    // If the consumer supplied their own QueryClient we use it as-is and skip
    // persistence — their host app owns that lifecycle.
    const [queryClient, setQueryClient] = useState<ReturnType<typeof createQueryClient> | null>(() => {
        if (providedQueryClient) {
            queryClientRef.current = providedQueryClient;
            return providedQueryClient;
        }
        return null;
    });

    useEffect(() => {
        if (providedQueryClient) {
            queryClientRef.current = providedQueryClient;
            setQueryClient(providedQueryClient);
            return;
        }

        let mounted = true;

        const bootstrap = async (): Promise<void> => {
            let storage: StorageInterface | null = null;
            try {
                storage = await createPlatformStorage();
            } catch (error) {
                if (__DEV__) {
                    loggerUtil.warn('Failed to initialize storage for query persistence', { component: 'OxyProvider' }, error);
                }
            }

            if (!mounted || queryClientRef.current) return;

            storageRef.current = storage;
            const client = createQueryClient();
            const { restored, unsubscribe } = attachQueryPersistence(client, storage);
            persistenceUnsubRef.current = unsubscribe;

            // Block first render until the persisted cache is restored so
            // offline reads land synchronously on the very first paint.
            await restored;

            if (!mounted) {
                unsubscribe();
                return;
            }

            queryClientRef.current = client;
            setQueryClient(client);
        };

        bootstrap();

        return () => {
            mounted = false;
            persistenceUnsubRef.current?.();
            persistenceUnsubRef.current = null;
        };
    }, [providedQueryClient]);

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
                        onlineManager.setOnline(state.isConnected ?? true);

                        const unsubscribe = NetInfo.default.addEventListener((state: { isConnected: boolean | null }) => {
                            onlineManager.setOnline(state.isConnected ?? true);
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

    // While the QueryClient is being created and the persisted cache is
    // hydrating, render a solid-color shell instead of `null`. Returning
    // `null` here on mid-range Android devices flashed a transparent
    // surface for 200–600ms after the native splash hid, which read as a
    // glitch. The shell keeps the screen filled with a sensible default
    // until children can mount under a real <QueryClientProvider>.
    if (!queryClient) {
        return (
            <GestureHandlerRootView style={bootStyles.providerRoot}>
                <SafeAreaProvider>
                    <KeyboardWrapper>
                        <View style={bootStyles.bootShell} />
                    </KeyboardWrapper>
                </SafeAreaProvider>
            </GestureHandlerRootView>
        );
    }

    // Core content: QueryClient + OxyContext + UI overlays.
    //
    // Theming is owned by `@oxyhq/bloom`. Consumers must mount their own
    // `<BloomThemeProvider>` in their app root and configure it directly
    // (defaultColorPreset, defaultMode, persistKey, storage, fonts, etc.).
    // OxyProvider does NOT wrap a BloomThemeProvider — that would create a
    // duplicate scope that silently shadows the consumer's configuration.
    const coreContent = (
        <QueryClientProvider client={queryClient}>
            <BloomDialogProvider>
                <OxyContextProvider
                    oxyServices={oxyServices as OxyContextProviderProps['oxyServices']}
                    baseURL={baseURL}
                    authWebUrl={authWebUrl}
                    authRedirectUri={authRedirectUri}
                    authorizeBaseUrl={authorizeBaseUrl}
                    storageKeyPrefix={storageKeyPrefix}
                    clientId={clientId}
                    sessionMode={sessionMode}
                    webAuthMode={webAuthMode}
                    hubSync={hubSync}
                    onAuthStateChange={onAuthStateChange as OxyContextProviderProps['onAuthStateChange']}
                >
                    <SurfaceProvider>
                        {requireAuth === 'off' ? (
                            children
                        ) : (
                            <RequireOxyAuth prompt={requireAuth}>{children}</RequireOxyAuth>
                        )}
                    </SurfaceProvider>
                    <ToastOutlet />
                </OxyContextProvider>
            </BloomDialogProvider>
        </QueryClientProvider>
    );

    return (
        <GestureHandlerRootView style={bootStyles.providerRoot}>
            <SafeAreaProvider>
                <KeyboardWrapper>
                    {coreContent}
                </KeyboardWrapper>
            </SafeAreaProvider>
        </GestureHandlerRootView>
    );
};

export default OxyProvider;
