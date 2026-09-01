import '../global.css';
import * as Linking from 'expo-linking';
import { Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { OxyProvider } from '@oxyhq/services';
import { BloomThemeProvider, useNavigationTheme } from '@oxyhq/bloom/theme';
import { ConnectionStatusToasts } from '@oxyhq/bloom/connection-status';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4100';
const AUTH_REDIRECT_URI = Linking.createURL('/');
// Public OAuth client id (the registered `ApplicationCredential` publicKey) —
// drives the app-identity flow when passed to `OxyProvider`. Env-with-default
// pattern, mirroring `packages/console/src/lib/config.ts`: a committed public
// default, overridable per environment via `EXPO_PUBLIC_OXY_CLIENT_ID`. This is
// a playground, so it reuses the Console app's credential rather than owning one.
const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ||
  'oxy_dk_2bdf04f596037ac720f94a54df405b974f240e5392a2e668';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  return (
    // BloomProvider owns the theme. OxyProvider does NOT mount its own
    // (by design, to avoid duplicate contexts), so this wraps the tree —
    // services UI like OxySignInButton calls bloom's useTheme().
    <SafeAreaProvider>
      <BloomThemeProvider mode="system">
        <ConnectionStatusToasts />
        <OxyProvider baseURL={API_URL} clientId={OXY_CLIENT_ID} authRedirectUri={AUTH_REDIRECT_URI}>
          <RootNavigator />
        </OxyProvider>
      </BloomProvider>
    </SafeAreaProvider>
  );
}

function RootNavigator() {
  const navTheme = useNavigationTheme();
  return (
    // expo-router's ThemeProvider is the react-navigation theme — distinct from
    // BloomProvider. It colors the navigator chrome (Stack headers, screen
    // backgrounds, modal). We feed it Bloom's resolved colors so Bloom remains
    // the single source of truth, instead of raw DarkTheme/DefaultTheme.
    <ThemeProvider value={navTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="profile-cards" options={{ title: 'Profile preview cards' }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
