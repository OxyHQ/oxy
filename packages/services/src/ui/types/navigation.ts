import type { ReactNode, RefObject } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { RouteName } from '../navigation/routes';
import type { User } from '@oxyhq/core';
import type { ClientSession, SessionMode } from '@oxyhq/core';
import type { WebAuthMode } from '../oauth/types';

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
     * Whether this origin/app may persist the durable device credential
     * (`deviceId` + `deviceSecret`) at all.
     *
     * `'persistent'` (the default, and every app's behaviour) stores it — web
     * localStorage per origin, SecureStore per app on native — so the SDK can
     * re-mint an access token on the next cold boot.
     *
     * `'ephemeral'` stores NOTHING durable: the session lives in memory for the
     * lifetime of the page and is gone on reload. It exists for ONE caller,
     * `auth.oxy.so` with the browser hub enabled (issue #937 Phase 5, ADR 0003),
     * where the durable credential for the browser profile is the server-side
     * DeviceSession behind the `__Host-oxy-device` handle. Two durable
     * credentials for one origin is the dual authority that phase exists to
     * remove — revoking the hub while a localStorage secret still mints would
     * make a sign-out look like it worked — so the way to let the hub be
     * authoritative is to stop persisting the other one, not to consult it
     * second.
     *
     * Do NOT reach for this to make an app "more private". A relying-party
     * origin set to `'ephemeral'` simply signs the user out on every reload,
     * because nothing else on that origin remembers the device.
     *
     * @default 'persistent'
     */
    deviceCredentialStorage?: 'persistent' | 'ephemeral';
}
