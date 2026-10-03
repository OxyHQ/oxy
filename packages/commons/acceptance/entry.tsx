import '../global.css';
import { registerRootComponent } from 'expo';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { KeyManager, SignatureService } from '@oxy.so/core/crypto';
import { createNativeIdentityPinStore } from '@oxy.so/core/session';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OxyProvider, useAuth, useOxy } from '@oxy.so/services';
import { useState } from 'react';
import { Button, ScrollView, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { installIdentitySigner } from '../lib/identity-signer';

const clientId = process.env.EXPO_PUBLIC_OXY_CLIENT_ID;
if (!clientId) throw new Error('Identity fixture requires its own registered client');
installIdentitySigner();

function IdentityObservation() {
  const auth = useAuth();
  const { oxyServices, signIn } = useOxy();
  const [publicKey, setPublicKey] = useState('unread');
  const [profileId, setProfileId] = useState('none');
  const [pin, setPin] = useState('unread');
  const [operation, setOperation] = useState('idle');
  async function create() {
    try {
      // Canonical no-overwrite guard remains active. Private key stays in this UID.
      const key = await KeyManager.createIdentity();
      setPublicKey(key); setOperation('synthetic-identity-created');
    } catch { setOperation('identity-create-refused'); }
  }
  async function registerAndSignIn() {
    try {
      const key = await KeyManager.getPublicKey();
      if (!key) { setOperation('identity-absent'); return; }
      setPublicKey(key);
      const existing = await oxyServices.auth.isKeyRegistered(key);
      if (!existing.registered) {
        const proof = await SignatureService.createRegistrationSignature();
        await oxyServices.auth.registerKey(key, proof.signature, proof.timestamp);
      }
      await signIn(key);
      setOperation('identity-signed-in');
    } catch { setOperation('identity-sign-in-failed'); }
  }
  async function observe() {
    try {
      const key = await KeyManager.getPublicKey();
      setPublicKey(key ?? 'none');
      const user = await oxyServices.users.me();
      setProfileId(user.id);
      // Read the actual SDK pin through its canonical parser. Never save a fabricated pin.
      const securePin = await createNativeIdentityPinStore({
        getItem: SecureStore.getItemAsync, setItem: SecureStore.setItemAsync, removeItem: SecureStore.deleteItemAsync,
      }).load();
      const fallbackPin = securePin ? null : await createNativeIdentityPinStore(AsyncStorage).load();
      const observedPin = securePin ?? fallbackPin;
      setPin(observedPin ? `${observedPin.accountId}:${observedPin.publicKey === key ? 'key-match' : 'key-mismatch'}:${observedPin.accountId === user.id ? 'owner-match' : 'owner-mismatch'}` : 'absent');
      setOperation('identity-observed');
    } catch { setOperation('identity-observation-denied'); }
  }
  return (
    <SafeAreaView style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
        <Text accessibilityRole="header">Owned synthetic identity recovery</Text>
        <Text>resolved:{String(auth.isAuthResolved)}</Text>
        <Text>authenticated:{String(auth.isAuthenticated)}</Text>
        <Text>private-ready:{String(auth.canUsePrivateApi)}</Text>
        <Text>owner:{auth.user?.id ?? 'none'}</Text>
        <Text>profile:{profileId}</Text>
        <Text>pin:{pin}</Text>
        <Text selectable>public-key:{publicKey}</Text>
        <Text>operation:{operation}</Text>
        <Text>provider-error:{String(Boolean(auth.error))}</Text>
        <Button title="Create owned synthetic identity" onPress={create} />
        <Button title="Register and sign in through SDK" onPress={registerAndSignIn} />
        <Button title="Read identity and owner through SDK" onPress={observe} />
      </ScrollView>
    </SafeAreaView>
  );
}
function IdentityRecoveryFixture() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <BloomThemeProvider mode="light">
          <OxyProvider clientId={clientId} baseURL="http://127.0.0.1:17960"
            authWebUrl="http://127.0.0.1:17961" authorizeBaseUrl="http://127.0.0.1:17961/authorize"
            storageKeyPrefix="oxy1519-owned-identity" sessionMode="identity">
            <IdentityObservation />
          </OxyProvider>
        </BloomThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
registerRootComponent(IdentityRecoveryFixture);
