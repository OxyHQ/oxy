import '../global.css';
import { OxyOneVideo } from '@oxy.so/services/ui/one-video';
import { AliaAvatar, ALIA_CHARACTER_RUNTIME_URL } from '@alia.onl/sdk';
import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import { useRef, useCallback } from 'react';
import { AliaSupport, type AliaSupportRef } from '../components/AliaSupport';
import * as Linking from 'expo-linking';
import { Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { OxyProvider } from '@oxy.so/services';
import { BloomThemeProvider, useNavigationTheme } from '@oxy.so/bloom/theme';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';
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
  const aliaSupportRef = useRef<AliaSupportRef>(null);
  const openAlia = useCallback(() => aliaSupportRef.current?.present(), []);
  return (
    // BloomProvider owns the theme. OxyProvider does NOT mount its own
    // (by design, to avoid duplicate contexts), so this wraps the tree —
    // services UI like OxySignInButton calls bloom's useTheme().
    // Gesture root: Bloom's tab bar scrubs between tabs with a pan gesture.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <BloomThemeProvider mode="system">
          <ConnectionStatusToasts />
          <OxyProvider
            onAskAlia={openAlia}
            oxyOneArtwork={<OxyOneVideo />}
            aliaAvatar={
              <AgentAvatarProvider runtimeUrl={ALIA_CHARACTER_RUNTIME_URL}>
                <AliaAvatar size={32} portrait />
              </AgentAvatarProvider>
            }
            baseURL={API_URL}
            clientId={OXY_CLIENT_ID}
            authRedirectUri={AUTH_REDIRECT_URI}
          >
            <RootNavigator />
            <AliaSupport ref={aliaSupportRef} />
          </OxyProvider>
        </BloomThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
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
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
