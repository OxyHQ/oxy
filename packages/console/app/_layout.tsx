// Tailwind v4 + NativeWind entry: compiles the utility stylesheet for the web build.
import '../global.css';

import { BloomScope } from '@oxy.so/bloom/appearance';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { ErrorBoundary } from '@oxy.so/bloom/error-boundary';
import { ImageResolverProvider, type ImageResolver } from '@oxy.so/bloom/image-resolver';
import { PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { OxyProvider, RequireOxyAuth } from '@oxy.so/services/ui';
import { useOxy } from '@oxy.so/services/ui/client';
import { QueryClient } from '@tanstack/react-query';
import { Slot } from 'expo-router';
import Head from 'expo-router/head';
import { type ReactNode, useCallback } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { AccountProvider } from '@/hooks/use-account';
import config from '@/lib/config';
import { LocaleProvider, useTranslation } from '@/lib/i18n';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      gcTime: 1000 * 60 * 30,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
    },
    mutations: { retry: 1 },
  },
});

/** Root: providers only. No React StrictMode: it breaks react-native-web's Modal portal. */
export default function RootLayout() {
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <BloomProvider mode="system" colorPreset="oxy">
          <BloomScope size="md">
            <KeyboardProvider>
              <PortalProvider>
                <ConnectionStatusToasts />
                {/* OxyProvider owns the one QueryClientProvider: handing it the app's client
                    makes the SDK's account hooks and Console's hooks share one cache. */}
                <OxyProvider
                  baseURL={config.oxyUrl}
                  clientId={config.clientId}
                  authRedirectUri={config.authRedirectUri}
                  queryClient={queryClient}
                >
                  <ConsoleMedia>
                    <LocaleProvider>
                      <AccountProvider>
                        <GatedApp />
                      </AccountProvider>
                    </LocaleProvider>
                  </ConsoleMedia>
                </OxyProvider>
                <PortalOutlet />
              </PortalProvider>
            </KeyboardProvider>
          </BloomScope>
        </BloomProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

/** One image resolver for the tree: components pass bare file ids and a variant. */
function ConsoleMedia({ children }: { children: ReactNode }) {
  const { oxyServices } = useOxy();
  const resolve = useCallback<ImageResolver>(
    (id, variant) => oxyServices.assets.publicUrl(id, variant),
    [oxyServices],
  );
  return <ImageResolverProvider value={resolve}>{children}</ImageResolverProvider>;
}

function GatedApp() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t('app.title')}</title>
      </Head>
      <RequireOxyAuth prompt="hard" title={t('auth.gate.title')} subtitle={t('auth.gate.subtitle')}>
        <Slot />
      </RequireOxyAuth>
    </>
  );
}
