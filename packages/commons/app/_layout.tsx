import '../global.css';
import { Stack, router } from 'expo-router';
import { ThemeProvider } from 'expo-router/react-navigation';
import Head from 'expo-router/head';
import { StatusBar } from 'expo-status-bar';
import { Linking, Platform } from 'react-native';
import { useEffect, useRef, useState } from 'react';
import 'react-native-reanimated';
import { configureReanimatedLogger, ReanimatedLogLevel } from 'react-native-reanimated';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ConnectionStatusToasts } from '@oxyhq/bloom/connection-status';

// Reanimated 4 ships with a strict logger that surfaces `.value` reads during
// render as runtime warnings. Several deeply nested third-party components in
// this app trip it; lowering the level to `warn` (without strict mode) keeps
// real errors visible while silencing the false-positive cascade.
configureReanimatedLogger({
  level: ReanimatedLogLevel.warn,
  strict: false,
});

import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useQueryClient } from '@tanstack/react-query';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { KeyManager, logger } from '@oxyhq/core';
import { useNavigationTheme } from '@oxyhq/bloom/theme';
import { BloomProvider } from '@oxyhq/bloom/provider';

import { ScrollProvider } from '@/contexts/scroll-context';
import { ThemeModeProvider, useThemeMode } from '@/contexts/theme-mode-context';
import {
  useOnboardingStatus,
  ONBOARDING_IDENTITY_QUERY_KEY,
  ONBOARDING_COMPLETE_QUERY_KEY,
} from '@/hooks/useOnboardingStatus';
import { LocaleProvider, useTranslation } from '@/lib/i18n';
import { MinimalErrorFallback } from '@/components/error-fallback';
import { OXY_CLIENT_ID } from '@/constants/oxy';
import { usePushRegistration } from '@/hooks/notifications/usePushRegistration';
import {
  coldLaunchApprovalCode,
  useAuthRequestNotifications,
} from '@/hooks/notifications/useAuthRequestNotifications';
import { useForegroundNotificationHandler } from '@/hooks/notifications/useForegroundNotificationHandler';
import {
  preventNativeSplashAutoHide,
  useHideNativeSplashWhenReady,
} from '@oxyhq/expo-splash';

// NATIVE ONLY: hold the OS splash so the Oxy mark (white silhouette centered on
// the dark brand background, Oxy symbol pinned to the bottom — configured by
// `@oxyhq/expo-splash` in app.config.js) stays visible until the app can paint
// its FIRST real screen. Commons is NATIVE-ONLY (no web build), so the branded
// native OS splash is the single splash. We hold it here and hide it from
// `AppStackContent` (below) once the app is genuinely ready — see the note there
// on why readiness is computed inside the providers, not on frame 1. No-op on
// web (the shared helper guards `Platform.OS === 'web'`).
preventNativeSplashAutoHide();

// Get API URL from environment variable with fallback
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.oxy.so';

// Safety net: never let a stalled readiness signal hold the OS splash forever.
// If storage hydration / cold boot haven't settled within this window, reveal
// the app anyway rather than trapping the user behind the splash.
const SPLASH_FALLBACK_MS = 4000;

export const unstable_settings = {
  anchor: '(tabs)',
};

/**
 * A typed expo-router `Href` for a cold-launch handoff target. The object form
 * (not a raw string) is required because `typedRoutes` is on: a runtime-built
 * string can't narrow to the generated path union, whereas the
 * `{ pathname, params }` shape does — mirroring `app/(scan)/index.tsx`.
 *
 * `approve` is a ROOT `transparentModal` route (`/approve`); `attest` stays in
 * the `(scan)` fullScreenModal group (`/(scan)/attest`).
 */
type ScanReplayHref =
  | { pathname: '/approve'; params: Record<string, string> }
  | { pathname: '/(scan)/attest'; params: Record<string, string> };

/**
 * Map a cold-launch deep link onto its in-app `(scan)` target, or `null` when
 * it is not a scan intent.
 *
 * The sign-in / real-life-attestation handoffs arrive as
 * `oxycommons://approve?...` / `oxycommons://attest?...` (also the `commons://`
 * scheme). `+native-intent` passes these through as `/approve` / `/attest`.
 * `approve` resolves to the root `transparentModal` route; `attest` resolves
 * into the `(scan)` group. We strip any scheme + leading slashes and, when the
 * first path segment is `approve` or `attest`, return the typed href with the
 * query decoded into `params` (expo-router re-encodes them when it builds the
 * URL). Card links (`/card/<did>`, a `(tabs)` route) and anything else yield
 * `null` so they are never force-routed here.
 */
function scanTargetFromColdLaunch(url: string): ScanReplayHref | null {
  const stripped = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^\/+/, '');
  const [pathPart, query = ''] = stripped.split(/[?#]/);
  const segment = pathPart.toLowerCase();
  if (segment !== 'approve' && segment !== 'attest') {
    return null;
  }

  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
    } catch (error) {
      // A malformed percent-sequence in a scanned/tapped payload: keep the raw
      // bytes for this param rather than dropping the whole intent — the target
      // (scan) screen validates params and rejects anything unusable.
      console.warn('[commons] cold-start deep-link param decode failed', error);
      params[rawKey] = rawValue;
    }
  }

  return segment === 'approve'
    ? { pathname: '/approve', params }
    : { pathname: '/(scan)/attest', params };
}

/**
 * The cold-launch handoff target, from EITHER source that can start Commons
 * with an intent: a system deep link, or a tapped "Sign in with Oxy" push
 * (issue #691, Phase 4).
 *
 * One resolver feeding the ONE replay below, so the push path inherits the
 * "wait until the routing gate settles, then navigate exactly once" behavior
 * instead of growing a parallel mechanism. The deep link wins when both are
 * present: it is the more specific intent (it can also address `attest`), and
 * the push only ever carries an approval code the link form already covers.
 *
 * Never rejects — both sources swallow their own failures — so the replay's
 * readiness flag always flips.
 */
async function resolveColdLaunchTarget(): Promise<ScanReplayHref | null> {
  let url: string | null = null;
  try {
    url = await Linking.getInitialURL();
  } catch (error) {
    logger.warn('[commons] cold-launch deep link could not be read', {
      component: 'AppStackContent',
    }, error);
  }

  const fromDeepLink = url ? scanTargetFromColdLaunch(url) : null;
  if (fromDeepLink) {
    return fromDeepLink;
  }

  const code = await coldLaunchApprovalCode();
  return code ? { pathname: '/approve', params: { code } } : null;
}

export default function RootLayout() {
  return (
    <ThemeModeProvider>
      <RootLayoutInner />
    </ThemeModeProvider>
  );
}

/**
 * Top-level error boundary. expo-router renders this whenever a render
 * error escapes any nested route, so an unexpected crash falls back to a
 * branded retry screen instead of an opaque white screen. Uses
 * `MinimalErrorFallback` so it works even if the Bloom theme provider
 * itself is the source of the crash.
 */
export function ErrorBoundary(props: { error: Error; retry: () => void }) {
  return <MinimalErrorFallback {...props} />;
}

function RootLayoutInner() {
  const { themeMode } = useThemeMode();

  // NOTE: the cross-app shared-identity boot backfill used to live here, keyed
  // off a raw `KeyManager.hasIdentity()` read on mount. It moved into
  // `AppStackContent` (below) and is now gated on the shared identity probe
  // reporting `present`, so it never fires during a possibly-locked cold-start
  // window and never touches a fresh install — see the effect there.

  // `AppStackContent` is rendered UNCONDITIONALLY — the held native OS splash
  // covers the RN view until `AppStackContent` hides it once the app is ready.
  // This avoids an intermediate boot shell (which flashed white on the dark
  // brand background) and the blank frame that appeared when the splash dropped
  // before fonts + the query cache were ready.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        {/* OxyProvider does NOT wrap a BloomProvider — by design, to
            avoid duplicate contexts when an app already ships its own (see
            packages/services/src/ui/components/OxyProvider.tsx). The consumer
            (this app) owns the BloomProvider and feeds it the resolved
            theme mode from ThemeModeProvider. */}
        <BloomThemeProvider mode={themeMode}>
          {/* `sessionMode="identity"` — Commons IS the identity, so its session
              is PINNED to the owner of this device's PRIMARY identity key for as
              long as that key exists, not to whichever account the shared
              `DeviceSession` is currently switched to. The SDK then:
                - runs `identity-key-signin` at cold boot (getPublicKey →
                  challenge → sign → verify) instead of the CROSS-APP
                  shared-keychain lane, which may hold a different identity;
                - binds every token mint / re-mint to the pinned account;
                - never fetches the device account graph, rejects
                  `switchToAccount` / `switchSession`, and keeps the account
                  dialog inert — the vault has exactly one user, by construction.
              This replaces the app-local boot auto-connect Commons used to run;
              do NOT re-add an app-local session-restore path. */}
          <ConnectionStatusToasts />
          <OxyProvider
            baseURL={API_URL}
            clientId={OXY_CLIENT_ID}
            sessionMode="identity"
            backgroundSession
          >
            <LocaleProvider>
              <AppHead />
              <AppStackContent />
            </LocaleProvider>
          </OxyProvider>
        </BloomProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/** Document head with translated title/description. Lives inside <LocaleProvider>. */
function AppHead() {
  const { t } = useTranslation();
  return (
    <Head>
      <title>{t('head.title')}</title>
      <meta name="description" content={t('head.description')} />
    </Head>
  );
}

/**
 * Renders the navigation stack and drives the native OS splash hand-off.
 *
 * Readiness is computed HERE, inside the providers, not on frame 1 of
 * `RootLayoutInner`. This component lives UNDER `<BloomProvider>`, whose
 * Bloom `FontLoader` gates its subtree — so by the time `AppStackContent`
 * mounts at all, fonts are already loaded. The only remaining readiness signals
 * are:
 *   - `isStorageReady`: the SDK's persisted query cache has hydrated, so the
 *     first paint serves cached data instead of an empty `#ffffff` boot shell.
 *   - `status !== 'checking'`: the device-first cold boot has settled the
 *     onboarding decision, so the Stack renders the correct group on the FIRST
 *     frame (no `(auth)` ↔ `(tabs)` flash).
 *
 * We hold the branded OS splash (see `preventNativeSplashAutoHide` at module
 * scope) until BOTH resolve, so the transition is: OS splash → first real
 * screen, with no blank frame and no white flash.
 */
function AppStackContent() {
  // Must be called inside OxyProvider (which wraps BloomProvider)
  const navTheme = useNavigationTheme();
  const { isStorageReady } = useOxy();
  const { status, needsAuth, identityPresent } = useOnboardingStatus();
  const queryClient = useQueryClient();

  const appReady = isStorageReady && status !== 'checking';

  // NOTE: connecting the vault's session from its OWN primary identity key is
  // the SDK's job, not this app's. `sessionMode="identity"` (see the provider
  // above) makes `identity-key-signin` a cold-boot step in `@oxyhq/core`, and
  // the SDK also owns the in-session re-mint, the 401 recovery arm and the
  // offline→online reconnect heal. The app-local auto-connect driver that used
  // to live here was deleted — do not reintroduce one.

  // Cross-app shared-identity backfill (native only, one-shot per launch).
  //
  // Commons is the ONLY app that writes the cross-app shared-identity slot other
  // Oxy apps read for silent "Sign in with Oxy". For users whose identity
  // predates that write-through, the slot stays empty until it is backfilled
  // once via `KeyManager.migrateToSharedIdentity()`. Gated on the shared identity
  // probe reporting a healthy LOCAL `present` verdict (`identityPresent`), so it
  // never runs on a fresh install, a `lost`/`unavailable` device, or during the
  // possibly-locked cold-start window — and it is never the app's first identity
  // reader. Ref-guarded so it fires at most once per launch. Fire-and-forget:
  // never awaited on the render path, never blocks the splash hand-off.
  const backfillDoneRef = useRef(false);
  useEffect(() => {
    if (Platform.OS === 'web' || backfillDoneRef.current || !identityPresent) return;
    backfillDoneRef.current = true;

    void (async () => {
      try {
        if (await KeyManager.hasSharedIdentity()) return;

        const migrated = await KeyManager.migrateToSharedIdentity();
        if (!migrated) {
          // The probe already confirmed a healthy primary and the shared slot
          // was empty, so `false` here means the write itself failed (e.g.
          // `OxyIdentityStore.write` threw) — surfaced distinctly so a real write
          // failure is greppable in production, not confused with "not attempted".
          logger.error(
            '[commons] shared-identity boot backfill: migrateToSharedIdentity returned false for a confirmed primary identity',
            undefined,
            { component: 'AppStackContent' },
          );
        }
      } catch (error) {
        logger.error('[commons] shared-identity boot backfill threw unexpectedly', error, {
          component: 'AppStackContent',
        });
      }
    })();
  }, [identityPresent]);

  // Event-driven routing refresh: the moment the on-device identity verdict may
  // have changed (create / import / delete / restore / cache invalidation),
  // re-read the shared onboarding probes so routing reflects it immediately,
  // without polling. `subscribeIdentityChanged` fires synchronously and returns
  // its own unsubscribe.
  useEffect(() => {
    return KeyManager.subscribeIdentityChanged(() => {
      queryClient.invalidateQueries({ queryKey: ONBOARDING_IDENTITY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ONBOARDING_COMPLETE_QUERY_KEY });
    });
  }, [queryClient]);

  // Bounded fallback so a stalled `isStorageReady`/`status` signal can never
  // hang the OS splash forever. Cleaned up on unmount.
  const [fallbackElapsed, setFallbackElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setFallbackElapsed(true), SPLASH_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, []);

  // Single readiness signal shared by the splash hand-off AND the deep-link
  // replay below, so the two can never disagree: whenever the splash is allowed
  // to reveal the first frame, the replay is evaluated in the same tick. If the
  // splash reveals via the fallback while the routing gate is still unresolved,
  // the replay sees `needsAuth` and drops the intent explicitly, rather than
  // leaving the captured URL stranded in the ref forever.
  const splashReady = appReady || fallbackElapsed;
  useHideNativeSplashWhenReady(splashReady);

  // ── Cold-start handoff replay (deep link OR tapped auth-request push) ──────
  // On a warm start the `(scan)` redirect gate is already resolved, so an
  // `oxycommons://approve|attest` link routes straight through. On a COLD start
  // the gate is `needsAuth === true` while `status === 'checking'`, so the root
  // Stack bounces `(scan)` → `(auth)` and the incoming intent is discarded once
  // the gate settles. We capture the cold-launch target once, then — after the
  // gate has resolved to an authenticated device — `router.replace()` to it
  // exactly once. If the gate instead resolves to `needsAuth` (no local
  // identity), we drop the intent and let the normal onboarding flow proceed.
  //
  // `resolveColdLaunchTarget()` is cold-launch-only and covers BOTH intent
  // sources (see its doc). Capturing into a ref + a resolved flag (state) makes
  // the replay race-free: it fires only once BOTH the launch target has been
  // read AND the gate has settled, guarded by a ref so later renders never
  // re-navigate.
  const pendingScanTargetRef = useRef<ScanReplayHref | null>(null);
  const scanReplayDoneRef = useRef(false);
  const [initialUrlResolved, setInitialUrlResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void resolveColdLaunchTarget()
      .then((target) => {
        if (!cancelled) pendingScanTargetRef.current = target;
      })
      .catch((error: unknown) => {
        logger.error('[commons] cold-launch handoff resolution failed', error, {
          component: 'AppStackContent',
        });
      })
      .finally(() => {
        if (!cancelled) setInitialUrlResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (scanReplayDoneRef.current) return;
    if (!initialUrlResolved || !splashReady) return;
    // Both the captured target and the routing gate are now settled — act once.
    scanReplayDoneRef.current = true;
    const target = pendingScanTargetRef.current;
    pendingScanTargetRef.current = null;
    if (!needsAuth && target) {
      router.replace(target);
    }
  }, [initialUrlResolved, splashReady, needsAuth]);

  // Keep this installation reachable by push for the signed-in vault identity,
  // so "Continue with Oxy" on a desktop can wake the phone instead of falling
  // back to a QR. No-ops until a session + the OS permission both exist.
  usePushRegistration();

  // Make an approval request visible even while Commons is the foregrounded
  // app — otherwise the OS silently swallows it at exactly the moment the user
  // is demonstrably holding the phone. Ungated on purpose: presentation must
  // not wait for the routing gate (an arriving request should be seen), and it
  // is a one-shot, process-wide install, not per-mount state.
  useForegroundNotificationHandler();

  // Warm auth-request pushes. Gated on the SAME settled signal the replay uses:
  // before that, `/approve` would be bounced by the `needsAuth` guard, and the
  // cold-launch path (which has already claimed the launching tap's code by the
  // time `initialUrlResolved` flips) owns that window.
  useAuthRequestNotifications(initialUrlResolved && splashReady && !needsAuth);

  // No `<SafeAreaProvider>` here: this subtree renders inside the provider
  // above, which mounts one itself (on both the ready and the boot-shell
  // path). A second, deeper one only re-measures the same full-screen frame.
  return (
    <ScrollProvider>
      <ThemeProvider value={navTheme}>
        <Stack>
          {/*
            Bidirectional onboarding guard.

            Commons legitimately OWNS the `hasIdentity` gate — it is the
            key vault. `needsAuth` is true when this device has no local
            identity yet OR has one but no username/session. We must:
              - Redirect AWAY from `(tabs)` (the post-auth tab shell) when
                onboarding is incomplete.
              - Redirect AWAY from `(auth)` when onboarding is complete.

            Expo Router resolves redirects to the first non-redirecting
            sibling, so exactly one is true at any time. Commons is a
            NATIVE-ONLY app (iOS/Android — see `platforms` in app.json):
            `(auth)/index.tsx` is the create-identity welcome (Hello Human)
            and there is no web build, because the key vault never leaves the
            device.
          */}
          <Stack.Screen name="(tabs)" redirect={needsAuth} options={{ headerShown: false }} />
          <Stack.Screen name="(auth)" redirect={!needsAuth} options={{ headerShown: false }} />
          {/*
            The QR scanner is an ACTION, not a tab. It lives at the root as a
            full-screen presented modal (pushed from the ID landing FAB via
            `router.push('/(scan)')`) so the CameraView covers the tab bar. It
            holds the camera (`index`) + the real-life attestation confirmation
            (`attest`). Guarded by the same `needsAuth` redirect as `(tabs)`:
            only an authenticated user can open it, and an unauthenticated
            `oxycommons://attest` deep link is bounced to onboarding.
          */}
          <Stack.Screen
            name="(scan)"
            redirect={needsAuth}
            options={{ headerShown: false, presentation: 'fullScreenModal' }}
          />
          {/*
            "Sign in with Oxy" approval — a Bloom bottom sheet. Registered at
            the ROOT (not inside `(scan)`) as a TRANSPARENT modal so the sheet
            rises over the real underlying context (the `(tabs)` anchor from
            `unstable_settings`) instead of an opaque `fullScreenModal` group
            card — otherwise it looks like a dedicated screen. `animation:
            'none'` lets the sheet own the motion. Same `needsAuth` guard as
            `(scan)`: an unauthenticated `oxycommons://approve` deep link is
            bounced to onboarding (and the cold-start replay above re-navigates
            here once the gate settles to an authenticated device).
          */}
          <Stack.Screen
            name="approve"
            redirect={needsAuth}
            options={{ headerShown: false, presentation: 'transparentModal', animation: 'none' }}
          />
        </Stack>
        <StatusBar style="auto" />
      </ThemeProvider>
    </ScrollProvider>
  );
}
