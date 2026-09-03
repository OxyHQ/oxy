/**
 * Platform navigation for the third-party "Sign in with Oxy" OAuth flow.
 *
 * Kept out of `OxySignInButton` so the button's routing logic can be unit-tested
 * without driving a real browser navigation (jsdom's `location.assign` is
 * non-configurable and cannot be spied). Both entry points hand a fully-built
 * `auth.oxy.so/authorize` URL to the platform — never FedCM, an SSO bounce, or
 * an Oxy session cookie.
 */

import { Linking } from 'react-native';
import { logger, persistOAuthReturnPath } from '@oxyhq/core';

/** Minimal shape of the optional `expo-web-browser` auth-session result. */
interface WebBrowserAuthResult {
    type?: string;
    url?: string;
}

/** Minimal shape of the optional `expo-web-browser` native module we depend on. */
interface WebBrowserModule {
    openAuthSessionAsync?: (url: string, redirectUrl: string) => Promise<WebBrowserAuthResult>;
}

/** Outcome of opening the authorize URL on native. */
export interface OpenAuthorizeResult {
    /**
     * The deep-link URL the auth session returned to (carries `?code=…&state=…`)
     * when `expo-web-browser` observed it, else `null`. `null` means the RP must
     * complete the exchange from its own deep-link handler (e.g. after the
     * `Linking.openURL` fallback, which cannot observe the return URL).
     */
    redirectUrl: string | null;
}

export interface OpenAuthorizeOptions {
    /**
     * Whether to fall back to `Linking.openURL` when an in-app auth session is
     * unavailable. Explicit-consent callers disable this because they must
     * observe and validate the callback before reporting success.
     * @default true
     */
    allowExternalFallback?: boolean;
}

/**
 * Web: hand the TOP-LEVEL document to the OAuth authorize URL (a full-page
 * redirect, not a popup) so the RP returns to its registered `redirect_uri`.
 * No-op where `location` is unavailable (SSR / non-browser hosts).
 *
 * Records the current page first. `redirect_uri` is a registered apex origin
 * (see `normalizeOAuthRedirectUri`), so the IdP always returns the tab to `/`,
 * and the return handlers restore this path. Doing it here rather than at each
 * call site is deliberate: every web authorize redirect — silent restore,
 * interactive sign-in, the passkey hub — funnels through this function, so a
 * new flow cannot forget to preserve the page the visitor came from.
 */
export function redirectToAuthorize(url: string): void {
    const location = (globalThis as { location?: Location }).location;
    if (!location) return;
    persistOAuthReturnPath(`${location.pathname}${location.search}${location.hash}`);
    location.assign(url);
}

/**
 * Native: open the authorize URL in an in-app auth session via the optional
 * `expo-web-browser` module (`openAuthSessionAsync` returns to `redirectUri`),
 * degrading to `Linking.openURL` when the module is not installed — the same
 * dynamic-import-with-fallback pattern services uses for haptics/netinfo.
 *
 * Returns the deep-link URL the session came back to when it can be observed, so
 * the caller can hand `?code=…&state=…` back to the RP for the token exchange.
 */
export async function openAuthorizeUrlNative(
    url: string,
    redirectUri: string,
    options: OpenAuthorizeOptions = {},
): Promise<OpenAuthorizeResult> {
    try {
        const mod = (await import('expo-web-browser')) as unknown as WebBrowserModule;
        if (mod && typeof mod.openAuthSessionAsync === 'function') {
            const result = await mod.openAuthSessionAsync(url, redirectUri);
            const redirectUrl =
                result && result.type === 'success' && typeof result.url === 'string'
                    ? result.url
                    : null;
            return { redirectUrl };
        }
    } catch (error) {
        logger.warn(
            'OxySignInButton: expo-web-browser auth session failed; falling back to Linking.openURL',
            { component: 'oauthNavigation' },
            error,
        );
    }

    if (options.allowExternalFallback === false) {
        return { redirectUrl: null };
    }

    // Fallback: Linking cannot observe the return URL, so the RP completes the
    // exchange from its own deep-link handler. A rejected openURL (e.g. an
    // unregistered scheme) must not throw out of the sign-in flow.
    try {
        await Linking.openURL(url);
    } catch (error) {
        logger.warn(
            'OxySignInButton: Linking.openURL rejected the authorize URL',
            { component: 'oauthNavigation' },
            error,
        );
    }
    return { redirectUrl: null };
}
