/**
 * Universal Sign in with Oxy — Expo / React Native (device-first SDK, 2026)
 *
 * ONE codebase for iOS, Android, and Web. The exact same provider + hook +
 * button work everywhere; the SDK picks the right restore path per platform:
 *
 *   - Native (iOS/Android): device-first cold boot restores a session silently
 *     from the on-device deviceId, and the shared keychain (`group.so.oxy.shared`)
 *     lets a user already signed into another Oxy app carry that session over —
 *     both automatic, no code here.
 *   - Web: device-first cold boot (persisted `{deviceId, deviceSecret}` →
 *     `POST /session/device/token`) restores the session via react-native-web.
 *     No FedCM, no `/sso` bounce, no cookies you manage.
 *
 * Cold boot NEVER redirects to a login page — it either restores a session or
 * resolves as signed-out. Interactive sign-in is the in-app dialog / OAuth
 * redirect below, not an IdP redirect.
 *
 * (This file is not tied to any specific Expo SDK version — it uses only the
 * version-agnostic device-first SDK surface.)
 */

import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { OxyProvider, OxySignInButton, useAuth } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';

// ==================== 1. Config ====================

// Your app's registered OAuth client id (the `ApplicationCredential` publicKey
// from the Oxy Console). Public value — safe to commit; override via
// `EXPO_PUBLIC_OXY_CLIENT_ID`.
const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ?? 'oxy_dk_your_client_id';
const OXY_API_URL =
  process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

// ==================== 2. App root ====================

// `BloomThemeProvider` owns theming — `OxySignInButton` calls Bloom's
// `useTheme()`, which throws outside a `BloomThemeProvider`. `OxyProvider` is
// the single device-first session authority.
export default function App() {
  return (
    <BloomThemeProvider mode="system">
      <OxyProvider baseURL={OXY_API_URL} clientId={OXY_CLIENT_ID}>
        <AppContent />
      </OxyProvider>
    </BloomThemeProvider>
  );
}

function AppContent() {
  const { isAuthenticated, isAuthResolved, user } = useAuth();

  // `isAuthResolved` flips to `true` once cold boot finishes (session restored
  // or none found). Until then, `isAuthenticated: false` is UNDETERMINED — show
  // a neutral loading state so a cold-boot reload with an existing session does
  // not flash the signed-out UI.
  if (!isAuthResolved) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return isAuthenticated && user ? <Dashboard user={user} /> : <WelcomeScreen />;
}

// ==================== 3. Signed-out ====================

function WelcomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to Oxy</Text>
      <Text style={styles.subtitle}>
        Sign in once — the SDK carries your session to every Oxy app.
      </Text>

      {/*
        One button, two behaviors — resolved from your Application's `type`
        (via `GET /auth/oauth/client/:clientId`):
          - first_party / internal / system / isOfficial → opens the in-app
            "Sign in with Oxy" dialog (Commons-first).
          - third_party → runs an OAuth 2.0 + PKCE flow to `auth.oxy.so`. On
            native, pass a custom-scheme `oauthRedirectUri` and read the handshake
            back via `onOAuthResult` to finish the token exchange; on web the SDK
            persists the PKCE pair across the redirect for you.
      */}
      <OxySignInButton variant="contained" />

      <Text style={styles.footer}>
        Already signed into another Oxy app on this device? You'll be signed in
        automatically via the shared keychain.
      </Text>
    </View>
  );
}

// ==================== 4. Signed-in ====================

function Dashboard({ user }: { user: User }) {
  const { signOut } = useAuth();

  // Render `name.displayName` when present; otherwise fall back to the handle.
  // Never recompose a name from first/last/full.
  const displayName = user.name?.displayName?.trim() || user.username;

  return (
    <View style={styles.container}>
      <Text style={styles.username}>{displayName}</Text>
      {user.email ? <Text style={styles.email}>{user.email}</Text> : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>You're signed in!</Text>
        <Text style={styles.cardText}>
          Open any other Oxy app and the SDK restores this session — no
          re-authentication needed.
        </Text>
      </View>

      {/* `showWhenAuthenticated` reuses the branded button as a sign-out CTA. */}
      <OxySignInButton
        variant="outline"
        showWhenAuthenticated
        text="Sign out"
        onPress={() => signOut()}
      />
    </View>
  );
}

// ==================== 5. Styles ====================

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, justifyContent: 'center', gap: 12 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', textAlign: 'center' },
  subtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 8 },
  footer: { fontSize: 12, color: '#999', textAlign: 'center', marginTop: 16 },
  username: { fontSize: 20, fontWeight: 'bold' },
  email: { fontSize: 14, color: '#666' },
  card: { backgroundColor: '#f0f9ff', padding: 15, borderRadius: 8, marginVertical: 16 },
  cardTitle: { fontSize: 16, fontWeight: 'bold', marginBottom: 8 },
  cardText: { fontSize: 14, color: '#666', lineHeight: 20 },
});
