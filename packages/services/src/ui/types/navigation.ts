import type { ReactNode, RefObject } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { RouteName } from '../navigation/routes';
import type { User } from '@oxy.so/core';
import type { ClientSession } from '@oxy.so/core';
import type { SessionMode } from '@oxy.so/core/session';
import type { WebAuthMode } from '../oauth/types';
import type { ProductAnalytics } from '../analytics/productAnalytics';

export interface StepController {
    canGoBack: () => boolean;
    goBack: () => void;
}

export interface BaseScreenProps {
    // Navigation props
    navigate?: (screen: RouteName, props?: Record<string, unknown>) => void;
    goBack?: () => void;
    /** Whether the host surface can navigate back — a deeper frame OR a prior step. */
    canGoBack?: () => boolean;
    onClose?: () => void;
    onAuthenticated?: (payload?: unknown) => void;
    /**
     * Dismiss THIS surface, resolving the `present()` promise that opened it
     * with `result`. Injected by the surface host (the P1 surface stack). Picker
     * and crop screens use it to hand a typed result back to the awaiting
     * `surfaces.present(...)` call instead of an untyped `onSelect`/`onConfirm`
     * callback prop.
     */
    dismiss?: (result?: unknown) => void;
    
    // Theme props
    theme?: 'light' | 'dark' | string;
    
    // Step-based screen props
    initialStep?: number;
    stepControllerRef?: RefObject<StepController | null>;
    onStepChange?: (currentStep: number, totalSteps: number) => void;
    
    // Screen identification
    currentScreen?: RouteName;
    
    // Scroll control
    scrollTo?: (y: number, animated?: boolean) => void;
    
    // Form props (for sign in/up flows)
    username?: string;
    email?: string;
    password?: string;
    confirmPassword?: string;
    userProfile?: unknown;
    
    // Note: OxyContext values (user, sessions, login, etc.) should be accessed via useOxy() hook
    // This keeps props minimal and follows React best practices
    
    // Allow additional props for screen-specific data
    [key: string]: unknown;
}

export interface OxyProviderProps {
    oxyServices?: unknown;
    children?: ReactNode;
    onAuthStateChange?: (user: unknown) => void;
    /** Optional, non-blocking product analytics sink. Receives no profile data. */
    productAnalytics?: ProductAnalytics;
    storageKeyPrefix?: string;
    /**
     * The app's Oxy OAuth client id / ApplicationCredential publicKey.
     * Required for the cross-app device sign-in flow: the QR / approval-window
     * sign-in registers a device-flow session via `POST /auth/session/create`,
     * which now identifies the requesting app by this real registered
     * client id. The central Oxy auth experience resolves and renders the
     * consent identity from it server-side. Without it the device sign-in
     * flow cannot start.
     */
    clientId?: string;
    baseURL?: string;
    authWebUrl?: string;
    authRedirectUri?: string;
    /**
     * Authorize endpoint override for web "Sign in with Oxy". Defaults to the
     * production Oxy IdP (`https://auth.oxy.so/authorize`) when unset. Set this
     * from an env var (e.g. Vite `VITE_OXY_AUTHORIZE_URL`, Expo
     * `EXPO_PUBLIC_OXY_AUTHORIZE_URL`) so a local/staging deployment targets its
     * own IdP instead of production.
     */
    authorizeBaseUrl?: string;
    /**
     * Who owns this app's session.
     *
     * - `'account'` (default) — the device's ACTIVE account. Every ordinary Oxy
     *   app: any app sharing the device's `DeviceSession` can switch the active
     *   account and this one follows, sign-in surfaces and the account switcher
     *   are available, and `accounts` lists the account graph.
     * - `'identity'` — the owner of this device's PRIMARY identity key, for as
     *   long as that key exists. The provider pins its authenticated user AND
     *   its bearer to the account that key authenticates as, so an account
     *   switch made by any sibling app changes the shared device state but never
     *   this app's user or token. Built for the identity vault (Commons).
     *
     * In `'identity'` mode the account-graph surfaces are disabled at the source
     * rather than hidden in the UI: `accounts` stays empty and is never fetched,
     * `switchToAccount` / `switchSession` reject with `IdentityBoundSessionError`,
     * `accountDialogController` is `null` and `openAccountDialog()` does nothing,
     * and the web OAuth cold-boot lane (the authorization-code return leg) is
     * skipped — it commits whichever account the IdP resolves, which is not
     * necessarily the local key's owner.
     *
     * Read once at mount, like `baseURL` / `oxyServices`: changing it on a
     * mounted provider does not re-bind the session.
     * @default 'account'
     */
    sessionMode?: SessionMode;
    /**
     * How a WEB third-party "Sign in with Oxy" hands the user to the IdP.
     *
     * - `'popup'` (default) — a small `auth.oxy.so` window opened from the
     *   user's click. The app stays MOUNTED and becomes authenticated without a
     *   reload; the IdP delivers only the authorization code + `state` back to
     *   the opener via `postMessage` (never a token, device secret, or PKCE
     *   verifier). A blocked popup falls back to the redirect automatically.
     * - `'redirect'` — a full-page navigation to `auth.oxy.so`, which returns to
     *   the registered `redirect_uri` with `?code=`. The tab unmounts and
     *   remounts, so route and unsaved state are lost.
     *
     * Either way the navigation only ever happens from a real user gesture: the
     * SDK never bounces the top-level window on its own (#691 phase 7b).
     *
     * Native is unaffected — it always uses an in-app auth session.
     * @default 'popup'
     */
    webAuthMode?: WebAuthMode;
    queryClient?: QueryClient;
    /**
     * Convenience: wrap the whole app subtree in `<RequireOxyAuth prompt=...>`.
     * `off` (default) renders children unconditionally; `soft` adds a dismissible
     * sign-in banner while signed out; `hard` blocks the app behind the signed-out
     * wall until the user signs in. For finer control, mount `RequireOxyAuth`
     * yourself around a specific subtree instead.
     * @default 'off'
     */
    requireAuth?: 'off' | 'soft' | 'hard';
    /**
     * When true, provisions a non-rotating background credential for native code
     * (Android widgets) that runs without a JS runtime. Android-only today; inert
     * on web and iOS.
     * @default false
     */
    backgroundSession?: boolean;
    /**
     * Wires the app's OWN i18n library to Oxy's resolved language, so the
     * account (or, signed out, the device/guest locale) drives the app's
     * translated UI directly — no app-local effect or "sync" component to
     * remember to mount. Oxy decides WHICH language; the app keeps owning its
     * own translation catalogs and library (i18next, FormatJS, or anything
     * else) and is told through `onChange` when to switch.
     *
     * Omitted entirely (the default) when an app has no i18n of its own, or
     * manages it independently of the account/device locale.
     */
    language?: OxyLanguageConfig;
}

export interface OxyLanguageConfig {
    /** The exact locales this app ships a translation catalog for. */
    supportedLocales: readonly string[];
    /**
     * Used when Oxy's resolved language matches none of `supportedLocales`,
     * not even by base language (Oxy's account-locale catalog is broader
     * than any one app's translations).
     */
    fallbackLocale: string;
    /**
     * Called whenever the resolved locale changes, coerced to the closest
     * one in `supportedLocales`. May return a promise; a rejection is
     * reported to `onError` instead of throwing into the app tree.
     */
    onChange: (locale: string) => void | Promise<void>;
    onError?: (error: unknown, locale: string) => void;
}
