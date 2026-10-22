// Tailwind v4 + NativeWind entry: compiles the utility stylesheet for the web build.
import '../global.css';

import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { OxyProvider, RequireOxyAuth } from '@oxy.so/services/ui';
import { QueryClient } from '@tanstack/react-query';
import { Slot } from 'expo-router';
import Head from 'expo-router/head';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AccountProvider } from '@/hooks/use-account';
import config from '@/lib/config';
import { LocaleProvider, useTranslation } from '@/lib/i18n';
import { SplashScreen } from '@/components/shell/splash-screen';
import { SignInScreen } from '@/components/shell/sign-in-screen';
import { useOxy } from '@oxy.so/services/ui/client';

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

export default function RootLayout() {
  // No React StrictMode: it breaks react-native-web's Modal portal.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <LocaleProvider>
        <BloomThemeProvider mode="system" colorPreset="oxy">
          <PortalProvider>
            <ConnectionStatusToasts />
            {/* OxyProvider owns the one QueryClientProvider: handing it the app's
                client makes the SDK's account hooks and Console's hooks share a cache. */}
            <OxyProvider
              baseURL={config.oxyUrl}
              clientId={config.clientId}
              authRedirectUri={config.authRedirectUri}
              queryClient={queryClient}
            >
              <AccountProvider>
                <Gate />
              </AccountProvider>
            </OxyProvider>
            <PortalOutlet />
          </PortalProvider>
        </BloomThemeProvider>
      </LocaleProvider>
    </GestureHandlerRootView>
  );
}

function Gate() {
  const { t } = useTranslation();
  const { openAccountDialog } = useOxy();
  return (
    <>
      <Head>
        <title>{t('app.title')}</title>
      </Head>
      <RequireOxyAuth
        prompt="hard"
        loadingFallback={<SplashScreen />}
        signedOutFallback={<SignInScreen onSignIn={() => openAccountDialog('signin')} />}
      >
        <Slot />
      </RequireOxyAuth>
    </>
  );
}
