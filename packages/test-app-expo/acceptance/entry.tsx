import '../global.css';
import { registerRootComponent } from 'expo';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { OxyProvider, OxySignInButton, useAuth, useOxy } from '@oxy.so/services';
import { useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const clientId = process.env.EXPO_PUBLIC_OXY_CLIENT_ID;
const redirectUri = 'astro://oauth/callback';
const apiUrl = 'http://127.0.0.1:17960';
const authorizeUrl = 'http://127.0.0.1:17961/authorize';
if (!clientId) throw new Error('Native acceptance requires its registered fixture client ID');

function AcceptanceScreen() {
  const auth = useAuth();
  const { startNativeOAuthSignIn, oxyServices } = useOxy();
  const [operation, setOperation] = useState('idle');
  const [profileId, setProfileId] = useState('none');
  async function signIn() {
    setOperation('sign-in-pending');
    const result = await startNativeOAuthSignIn({ redirectUri });
    setOperation('reason' in result ? `${result.status}:${result.reason}` : result.status);
  }
  async function signOut() {
    try { await auth.signOut(); setOperation('signed-out'); setProfileId('none'); }
    catch { setOperation('sign-out-failed'); }
  }
  async function readProfile() {
    try { const user = await oxyServices.users.me(); setProfileId(user.id); setOperation('profile-read'); }
    catch { setProfileId('none'); setOperation('profile-denied'); }
  }
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 18 }}>
        <Text accessibilityRole="header" style={{ fontSize: 22 }}>Oxy native acceptance</Text>
        <Text testID="acceptance-resolved">resolved:{String(auth.isAuthResolved)}</Text>
        <Text testID="acceptance-authenticated">authenticated:{String(auth.isAuthenticated)}</Text>
        <Text testID="acceptance-private-ready">private-ready:{String(auth.canUsePrivateApi)}</Text>
        <Text testID="acceptance-user">user:{auth.user?.id ?? 'none'}</Text>
        <Text testID="acceptance-profile">profile:{profileId}</Text>
        <Text testID="acceptance-operation">operation:{operation}</Text>
        <Text testID="acceptance-error">provider-error:{String(Boolean(auth.error))}</Text>
        <OxySignInButton nativeOAuthCompletion="sdk" oauthRedirectUri={redirectUri} />
        <Button title="Sign in through SDK hook" onPress={signIn} />
        <Button title="Read profile through SDK" onPress={readProfile} />
        <Button title="Sign out through SDK" onPress={signOut} />
      </ScrollView>
    </SafeAreaView>
  );
}
function NativeAcceptance() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <BloomThemeProvider mode="light">
          <OxyProvider clientId={clientId} baseURL={apiUrl} authorizeBaseUrl={authorizeUrl}
            authWebUrl="http://127.0.0.1:17961" authRedirectUri={redirectUri}
            storageKeyPrefix="oxy1519-native-acceptance">
            <View style={{ flex: 1 }}><AcceptanceScreen /></View>
          </OxyProvider>
        </BloomThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
registerRootComponent(NativeAcceptance);
