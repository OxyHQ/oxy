/**
 * React Native example: one Oxy identity across apps, held by Commons
 *
 * Shows the LOW-LEVEL identity primitives. Most apps do NOT need this — they
 * mount `<OxyProvider>` and the device-first cold boot signs them in by itself
 * (its `commons-proof-signin` lane calls the same method as part A below; see
 * `expo-54-universal-auth.tsx`).
 *
 * A. Any Oxy app: sign in as the identity the device already holds.
 *    - Android: Commons is the only holder of the private key. The app asks
 *      Commons, over signature-protected IPC, for its public key and a signed
 *      server challenge. The key never enters this app.
 *    - iOS: the identity lives in the keychain access group
 *      `group.so.oxy.shared` and signs the challenge in-process.
 * B. The identity holder (Commons): create or import the key, keep the shared
 *    slot in step (`syncSharedIdentity`), register it with the server.
 *
 * Setup required (the `@oxy.so/app-preset` config plugin does both):
 * - iOS: Keychain Sharing with access group "group.so.oxy.shared"
 * - Android: `@oxy.so/services/plugins/withOxySharedPermissions` (signature
 *   permissions `so.oxy.permission.IDENTITY` / `so.oxy.permission.DEVICE_SESSION`
 *   plus `<queries>`). Never `android:sharedUserId`: each Oxy app has its own
 *   UID. The app must be signed with the Oxy certificate and be on Commons'
 *   caller allow-list.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Button, Text, TextInput, View } from 'react-native';
import { OxyServices } from '@oxy.so/core';
import type { User } from '@oxy.so/core';
import { KeyManager, RecoveryPhraseService, SignatureService } from '@oxy.so/core/crypto';

const oxy = new OxyServices({ baseURL: 'https://api.oxy.so' });

// ==================== A. Sign in as the device's identity ====================

/**
 * `signInWithCommonsIdentity()` resolves `null` on web, when Commons is not
 * installed or holds no identity, or when it refuses this app. Otherwise it
 * has minted a session and planted the tokens.
 */
async function signInAsDeviceIdentity(): Promise<{ user: User; sessionId: string } | null> {
  const session = await oxy.auth.signInWithCommonsIdentity();
  if (!session) return null;
  return { user: await oxy.users.me(), sessionId: session.sessionId };
}

// ==================== B. Holding the identity (Commons) ====================

/**
 * Register the local key if the server does not know it yet. The username is
 * required: the account is created with the key and the username together.
 */
async function registerIfNeeded(publicKey: string, username: string): Promise<void> {
  const { registered } = await oxy.auth.isKeyRegistered(publicKey);
  if (registered) return;
  const registration = await SignatureService.createRegistrationSignature();
  await oxy.auth.registerKey(
    registration.publicKey,
    registration.signature,
    registration.timestamp,
    username,
  );
}

async function createIdentity(username: string): Promise<string[]> {
  // Writes the key to this app's own secure storage (and, in Commons on
  // Android, to the identity signer store its identity host signs with).
  const { words, publicKey } = await RecoveryPhraseService.generateIdentityWithRecovery();
  // Fill the shared slot (the iOS keychain group other apps read).
  await KeyManager.syncSharedIdentity();
  await registerIfNeeded(publicKey, username);
  return words;
}

async function importIdentity(phrase: string, username: string): Promise<void> {
  const publicKey = await RecoveryPhraseService.restoreFromPhrase(phrase);
  await KeyManager.syncSharedIdentity();
  await registerIfNeeded(publicKey, username);
}

// ==================== Auth context ====================

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: () => Promise<void>;
  create: (username: string) => Promise<string[]>;
  importPhrase: (phrase: string, username: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const signIn = async () => {
    const result = await signInAsDeviceIdentity();
    setUser(result?.user ?? null);
    setSessionId(result?.sessionId ?? null);
  };

  useEffect(() => {
    signIn()
      .catch((error) => console.error('Sign-in failed:', error))
      .finally(() => setLoading(false));
  }, []);

  const withLoading = async <T,>(run: () => Promise<T>): Promise<T> => {
    setLoading(true);
    try {
      return await run();
    } finally {
      setLoading(false);
    }
  };

  const value: AuthContextType = {
    user,
    loading,
    signIn: () => withLoading(signIn),
    create: (username) =>
      withLoading(async () => {
        const words = await createIdentity(username);
        await signIn();
        return words;
      }),
    importPhrase: (phrase, username) =>
      withLoading(async () => {
        await importIdentity(phrase, username);
        await signIn();
      }),
    signOut: () =>
      withLoading(async () => {
        if (sessionId) await oxy.session.logout(sessionId);
        oxy.session.clear();
        setUser(null);
        setSessionId(null);
      }),
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

// ==================== Screens ====================

function WelcomeScreen() {
  const { create, importPhrase, signIn } = useAuth();
  const [phrase, setPhrase] = useState('');
  const [username, setUsername] = useState('');

  const handleCreate = async () => {
    try {
      const words = await create(username.trim());
      Alert.alert('Identity created', `Save your recovery phrase:\n\n${words.join(' ')}`);
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to create identity');
    }
  };

  const handleImport = async () => {
    try {
      await importPhrase(phrase.trim(), username.trim());
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to import identity');
    }
  };

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
      <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 20 }}>Welcome to Oxy</Text>
      <Button title="Sign in with Commons" onPress={signIn} />
      <View style={{ height: 20 }} />
      <Text style={{ marginBottom: 10 }}>Or hold the identity in this app (Commons only):</Text>
      <TextInput
        style={{ borderWidth: 1, borderColor: '#ccc', padding: 10, marginBottom: 10 }}
        autoCapitalize="none"
        value={username}
        onChangeText={setUsername}
        placeholder="Username (required for a new account)"
      />
      <Button title="Create new identity" onPress={handleCreate} disabled={!username.trim()} />
      <TextInput
        style={{
          borderWidth: 1,
          borderColor: '#ccc',
          padding: 10,
          marginVertical: 10,
          minHeight: 80,
        }}
        multiline
        value={phrase}
        onChangeText={setPhrase}
        placeholder="Recovery phrase"
      />
      <Button title="Import" onPress={handleImport} disabled={!phrase.trim()} />
    </View>
  );
}

function DashboardScreen({ user }: { user: User }) {
  const { signOut, loading } = useAuth();
  // `name.displayName` when present; otherwise the handle.
  const displayName = user.name?.displayName?.trim() || user.username;

  return (
    <View style={{ flex: 1, padding: 20 }}>
      <Text style={{ fontSize: 20, fontWeight: 'bold', marginVertical: 20 }}>{displayName}</Text>
      <Button
        title={loading ? 'Signing out...' : 'Sign out'}
        onPress={signOut}
        disabled={loading}
      />
    </View>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

function AppContent() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }
  return user ? <DashboardScreen user={user} /> : <WelcomeScreen />;
}

/**
 * The device's shared Oxy identity, as this app sees it: the public key only
 * (Commons' `describe` on Android, the keychain group on iOS).
 */
export function useSharedIdentity() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    KeyManager.getSharedPublicKey()
      .then(setPublicKey)
      .finally(() => setLoading(false));
  }, []);

  return { publicKey, loading };
}
