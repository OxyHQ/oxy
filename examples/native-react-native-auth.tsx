/**
 * React Native example: cross-app shared cryptographic identity
 *
 * Shows the LOW-LEVEL identity primitives that Commons by Oxy uses under the
 * hood: create/import a keypair, promote it to the shared keychain, register it
 * with the server, and sign in with it. Most apps do NOT need this — they mount
 * `<OxyProvider>` and the device-first cold boot + shared keychain handle
 * everything automatically (see `expo-54-universal-auth.tsx`). This example is
 * for building an identity/vault surface like Commons.
 *
 * Apps that share one identity (illustrative bundle ids):
 * - Homiio (com.homiio.app)
 * - Mention (com.mention.app)
 * - Alia (com.alia.app)
 *
 * Setup required:
 * - iOS: enable Keychain Sharing with access group "group.so.oxy.shared"
 * - Android: configure the shared identity store under "so.oxy.shared"
 */

import React, { useEffect, useState, createContext, useContext } from 'react';
import { View, Text, Button, ActivityIndicator, Alert, TextInput, Platform } from 'react-native';
import {
  OxyServices,
  KeyManager,
  SignatureService,
  RecoveryPhraseService,
} from '@oxy.so/core';
import type { User } from '@oxy.so/core';

// ==================== 1. Setup ====================

const oxyServices = new OxyServices({
  baseURL: 'https://api.oxy.so',
});

// ==================== 2. Auth Context ====================

interface AuthContextType {
  user: User | null;
  loading: boolean;
  hasIdentity: boolean;
  createIdentity: () => Promise<string[]>; // Returns recovery phrase words
  importIdentity: (phrase: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasIdentity, setHasIdentity] = useState(false);

  useEffect(() => {
    initializeAuth();
  }, []);

  const initializeAuth = async () => {
    try {
      // 1. Reuse a warm shared session planted by another Oxy app.
      const sharedSession = await KeyManager.getSharedSession();
      if (sharedSession) {
        oxyServices.setTokens(sharedSession.accessToken);
        try {
          setUser(await oxyServices.getCurrentUser());
          setHasIdentity(true);
          return;
        } catch {
          // Shared session is stale — fall through to key-based sign-in.
        }
      }

      // 2. A shared identity exists (this or another app created it): the SDK
      //    runs the whole challenge → sign → verify exchange and plants tokens.
      if (await KeyManager.hasSharedIdentity()) {
        setHasIdentity(true);
        await signInWithSharedIdentity();
        return;
      }

      // 3. Only a LOCAL (app-private) identity exists: promote it to the shared
      //    keychain so every Oxy app can use it, then sign in.
      if (await KeyManager.hasIdentity()) {
        const migrated = await KeyManager.migrateToSharedIdentity();
        if (migrated) {
          setHasIdentity(true);
          await signInWithSharedIdentity();
        }
      }
    } catch (error) {
      console.error('Auth initialization failed:', error);
    } finally {
      setLoading(false);
    }
  };

  // `signInWithSharedIdentity()` requests a challenge for the shared public key,
  // signs it with the shared private key, verifies it, and plants the tokens —
  // returns null on web or when no shared identity is present. We then read the
  // full profile for display.
  const signInWithSharedIdentity = async (): Promise<void> => {
    const session = await oxyServices.signInWithSharedIdentity();
    if (session) {
      setUser(await oxyServices.getCurrentUser());
    }
  };

  const createIdentity = async (): Promise<string[]> => {
    setLoading(true);
    try {
      // Generate a new keypair + recovery phrase (written to the local keychain).
      const { words } = await RecoveryPhraseService.generateIdentityWithRecovery();

      // Promote it to the shared keychain so all Oxy apps can use it.
      await KeyManager.migrateToSharedIdentity();

      // Register the identity with the server (signature over the current key).
      const registration = await SignatureService.createRegistrationSignature();
      await oxyServices.register(
        registration.publicKey,
        registration.signature,
        registration.timestamp,
      );

      // Sign in with the freshly registered shared identity.
      await signInWithSharedIdentity();
      setHasIdentity(true);

      return words;
    } catch (error) {
      console.error('Identity creation failed:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const importIdentity = async (phrase: string): Promise<void> => {
    setLoading(true);
    try {
      // Restore the keypair from the recovery phrase (written to the local
      // keychain) and promote it to the shared keychain.
      const publicKey = await RecoveryPhraseService.restoreFromPhrase(phrase);
      await KeyManager.migrateToSharedIdentity();

      // Register only if the server hasn't seen this key before.
      const { registered } = await oxyServices.checkPublicKeyRegistered(publicKey);
      if (!registered) {
        const registration = await SignatureService.createRegistrationSignature();
        await oxyServices.register(
          registration.publicKey,
          registration.signature,
          registration.timestamp,
        );
      }

      await signInWithSharedIdentity();
      setHasIdentity(true);
    } catch (error) {
      console.error('Identity import failed:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    setLoading(true);
    try {
      // Revoke the server session, then clear the shared session (signs out of
      // EVERY Oxy app on this device).
      const sharedSession = await KeyManager.getSharedSession();
      if (sharedSession) {
        await oxyServices.logoutSession(sharedSession.sessionId);
      }
      await KeyManager.clearSharedSession();

      oxyServices.clearTokens();
      setUser(null);
    } catch (error) {
      console.error('Sign out failed:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, hasIdentity, createIdentity, importIdentity, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

// ==================== 3. Screens ====================

function WelcomeScreen() {
  const { createIdentity, importIdentity, loading } = useAuth();
  const [showImport, setShowImport] = useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = useState('');

  const handleCreateIdentity = async () => {
    try {
      const phrase = await createIdentity();

      // Show recovery phrase to user
      Alert.alert(
        'Identity Created!',
        'Save your recovery phrase:\n\n' + phrase.join(' '),
        [
          {
            text: 'I saved it',
            style: 'default',
          },
        ]
      );
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to create identity');
    }
  };

  const handleImportIdentity = async () => {
    if (!recoveryPhrase.trim()) {
      Alert.alert('Error', 'Please enter your recovery phrase');
      return;
    }

    try {
      await importIdentity(recoveryPhrase.trim());
      Alert.alert('Success', 'Identity imported successfully!');
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to import identity');
    }
  };

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
        <Text>Checking for existing identity...</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 20 }}>
      <Text style={{ fontSize: 24, fontWeight: 'bold', marginBottom: 10 }}>
        Welcome to Oxy
      </Text>
      <Text style={{ marginBottom: 20 }}>
        Create an identity or import from another Oxy app
      </Text>

      {!showImport ? (
        <>
          <Button title="Create New Identity" onPress={handleCreateIdentity} />
          <View style={{ height: 10 }} />
          <Button title="Import Existing Identity" onPress={() => setShowImport(true)} />
        </>
      ) : (
        <>
          <Text style={{ marginBottom: 10 }}>Enter your 12 or 24 word recovery phrase:</Text>
          <TextInput
            style={{
              borderWidth: 1,
              borderColor: '#ccc',
              padding: 10,
              marginBottom: 10,
              minHeight: 100,
            }}
            multiline
            value={recoveryPhrase}
            onChangeText={setRecoveryPhrase}
            placeholder="word1 word2 word3 ..."
          />
          <Button title="Import" onPress={handleImportIdentity} />
          <View style={{ height: 10 }} />
          <Button title="Back" onPress={() => setShowImport(false)} color="#999" />
        </>
      )}

      <Text style={{ marginTop: 30, fontSize: 12, color: '#666', textAlign: 'center' }}>
        Your identity is shared across all Oxy apps{'\n'}
        (Homiio, Mention, Alia, etc.)
      </Text>
    </View>
  );
}

function DashboardScreen() {
  const { user, signOut, loading } = useAuth();

  if (!user) return null;

  // Render `name.displayName` when present; otherwise fall back to the handle.
  const displayName = user.name?.displayName?.trim() || user.username;

  return (
    <View style={{ flex: 1, padding: 20 }}>
      <View style={{ alignItems: 'center', marginVertical: 20 }}>
        <View
          style={{
            width: 80,
            height: 80,
            borderRadius: 40,
            backgroundColor: '#ddd',
            marginBottom: 10,
          }}
        />
        <Text style={{ fontSize: 20, fontWeight: 'bold' }}>{displayName}</Text>
        {user.email ? <Text style={{ color: '#666' }}>{user.email}</Text> : null}
      </View>

      <View
        style={{
          backgroundColor: '#f0f9ff',
          padding: 15,
          borderRadius: 8,
          marginBottom: 20,
        }}
      >
        <Text style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 10 }}>
          Signed in across all Oxy apps
        </Text>
        <Text style={{ color: '#666' }}>
          Your identity is shared via {Platform.OS === 'ios' ? 'iOS Keychain' : 'the Android identity store'}.
          Open any other Oxy app and you'll be automatically signed in!
        </Text>
      </View>

      <Button title={loading ? 'Signing out...' : 'Sign Out'} onPress={signOut} disabled={loading} />

      <View style={{ marginTop: 30 }}>
        <Text style={{ fontSize: 14, fontWeight: 'bold', marginBottom: 5 }}>
          Shared Identity Status:
        </Text>
        <Text style={{ color: '#666' }}>Identity stored in the shared keychain</Text>
        <Text style={{ color: '#666' }}>Session accessible to all Oxy apps</Text>
        <Text style={{ color: '#666' }}>No re-authentication needed</Text>
      </View>
    </View>
  );
}

// ==================== 4. Main App ====================

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

function AppContent() {
  const { user, loading, hasIdentity } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!hasIdentity || !user) {
    return <WelcomeScreen />;
  }

  return <DashboardScreen />;
}

// ==================== 5. Utility Hooks ====================

/**
 * Hook to check if user is signed in via another Oxy app
 */
export function useSharedSession() {
  const [hasSharedSession, setHasSharedSession] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSharedSession = async () => {
      const session = await KeyManager.getSharedSession();
      setHasSharedSession(!!session);
      setLoading(false);
    };

    checkSharedSession();
  }, []);

  return { hasSharedSession, loading };
}

/**
 * Hook to check if shared identity exists
 */
export function useSharedIdentity() {
  const [hasSharedIdentity, setHasSharedIdentity] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSharedIdentity = async () => {
      const has = await KeyManager.hasSharedIdentity();
      setHasSharedIdentity(has);

      if (has) {
        const key = await KeyManager.getSharedPublicKey();
        setPublicKey(key);
      }

      setLoading(false);
    };

    checkSharedIdentity();
  }, []);

  return { hasSharedIdentity, publicKey, loading };
}

// Usage example:
function ExampleComponent() {
  const { hasSharedSession, loading } = useSharedSession();

  if (loading) return <ActivityIndicator />;

  if (hasSharedSession) {
    return (
      <Text>
        You're already signed in from another Oxy app! (Homiio, Mention, or Alia)
      </Text>
    );
  }

  return <Text>No shared session found. Create a new identity.</Text>;
}
