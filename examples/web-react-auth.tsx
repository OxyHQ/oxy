/**
 * Web React example — Sign in with Oxy (device-first SDK, 2026)
 *
 * The whole flow is owned by the SDK. You mount one provider, read auth state
 * from one hook, and drop in one button. There is NO cookie plumbing, no FedCM,
 * no `/sso` bounce, and no per-app session restore — `OxyProvider`'s device-first
 * cold boot (persisted `{deviceId, deviceSecret}` → `POST /session/device/token`)
 * restores an existing session on
 * its own and NEVER redirects to a login page.
 *
 * Runs on the web via react-native-web (the same SDK powers Expo/native — see
 * `expo-54-universal-auth.tsx`).
 */

import React from 'react';
import { OxyProvider, OxySignInButton, useAuth } from '@oxyhq/services';
import type { User } from '@oxyhq/core';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { BloomThemeProvider } from '@oxyhq/bloom/theme';

// ==================== 1. Config ====================

// Your app's registered OAuth client id (the `ApplicationCredential` publicKey
// from the Oxy Console). Public value — safe to commit; override per environment.
const OXY_CLIENT_ID = process.env.OXY_CLIENT_ID ?? 'oxy_dk_your_client_id';
const OXY_API_URL = process.env.OXY_API_URL ?? 'https://api.oxy.so';

// ==================== 2. App root ====================

// `BloomThemeProvider` owns theming — `OxySignInButton` (and other services UI)
// calls Bloom's `useTheme()`, which throws outside a `BloomThemeProvider`.
// `OxyProvider` is the single session authority; do NOT also mount
// a separate web provider (the legacy one is gone — one provider only).
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
  // or none found). Until then, `isAuthenticated: false` is UNDETERMINED — hold
  // a neutral loading state so a reload with an existing session doesn't flash
  // the logged-out UI.
  if (!isAuthResolved) {
    return (
      <div className="loading">
        <div className="spinner" />
        <p>Loading…</p>
      </div>
    );
  }

  return isAuthenticated && user ? <Dashboard user={user} /> : <LoginPage />;
}

// ==================== 3. Signed-out ====================

function LoginPage() {
  return (
    <div className="login-page">
      <h1>Welcome to Oxy</h1>
      <p>Sign in once, then you're signed in across every Oxy app.</p>

      {/*
        One button, two behaviors — resolved from your Application's `type`
        (via `GET /auth/oauth/client/:clientId`):
          - third_party  → the SDK runs an OAuth 2.0 + PKCE redirect to
            `auth.oxy.so/authorize` (it generates and stores the PKCE pair and
            CSRF `state` for you). Pass `oauthRedirectUri` for third-party apps.
          - first_party / internal / system / isOfficial → opens the in-app
            "Sign in with Oxy" dialog (Commons-first); no redirect.
      */}
      <OxySignInButton variant="contained" />
    </div>
  );
}

// ==================== 4. Signed-in ====================

function Dashboard({ user }: { user: User }) {
  const { signOut } = useAuth();

  // Render `name.displayName` when present; otherwise fall back to the handle.
  // Never recompose a name from first/last/full.
  const displayName = user.name?.displayName?.trim() ?? getNormalizedUserHandle(user);

  return (
    <div className="dashboard">
      <header>
        <div className="user-info">
          <h2>{displayName}</h2>
          {user.email ? <p>{user.email}</p> : null}
        </div>
        <button type="button" onClick={() => signOut()}>Sign out</button>
      </header>

      <main>
        <h3>You're signed in!</h3>
        <p>Open any other Oxy app and the SDK restores this session for you.</p>
      </main>
    </div>
  );
}

// ==================== 5. Programmatic sign-in (optional) ====================

/**
 * `useAuth().signIn()` is the imperative equivalent of the button for official
 * apps — it opens the same in-app sign-in dialog. It does NOT navigate to a
 * login page (device-first cold boot already restored a session if one exists),
 * so a caller reacts to `isAuthenticated` rather than awaiting this promise.
 * Third-party apps should sign in via `<OxySignInButton oauthRedirectUri=… />`.
 */
export function useSignInAction() {
  const { signIn, isAuthenticated } = useAuth();
  return { signIn, isAuthenticated };
}
