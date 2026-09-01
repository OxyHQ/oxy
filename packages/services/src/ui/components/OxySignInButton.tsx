import type React from 'react';
import { useCallback, useState, useEffect, useRef } from 'react';
import { type ViewStyle, type TextStyle, type StyleProp, Platform } from 'react-native';
import {
    logger,
    generatePkcePair,
    generateOAuthState,
    buildOAuthAuthorizeUrl,
    type PublicApplication,
} from '@oxyhq/core';
import { useAuthStore } from '../stores/authStore';
import { useShallow } from 'zustand/react/shallow';
import { useTheme } from '@oxyhq/bloom/theme';
import { Button, type ButtonVariant } from '@oxyhq/bloom/button';
import { toast } from '@oxyhq/bloom/toast';
import { useOxy } from '../context/OxyContext';
import { useI18n } from '../hooks/useI18n';
import { LogoIcon } from './logo/LogoIcon';
import { subscribeToAccountDialog } from '../navigation/accountDialogManager';
import { openAuthorizeUrlNative } from './oauthNavigation';
import { closeOAuthPopup, openOAuthPopup } from '../oauth/oauthPopup';
import type { OAuthPopupHandle } from '../oauth/types';

/**
 * The OAuth handshake surfaced to a NATIVE third-party RP via
 * {@link OxySignInButtonProps.onOAuthResult} so it can finish the code exchange
 * (`POST /auth/oauth/token`). Web sign-in is handled entirely by the SDK's web
 * transport (`useOxy().startWebOAuthSignIn`) and never uses this callback.
 */
export interface OxyOAuthResult {
    /** Deep-link URL the native auth session returned to (`?code=…&state=…`), or `null` if unobserved. */
    redirectUrl: string | null;
    /** The CSRF `state` sent on the authorize request; the RP must match it on return. */
    state: string;
    /** The PKCE `code_verifier` to replay on the token exchange. */
    codeVerifier: string;
}

export interface OxySignInButtonProps {
    /**
     * Controls the appearance of the button
     * @default 'default'
     */
    variant?: 'default' | 'outline' | 'contained';

    /**
     * Optional function to handle button press
     * If not provided, the button will use the showBottomSheet method from OxyContext
     */
    onPress?: () => void;

    /**
     * Additional styles for the button container
     */
    style?: StyleProp<ViewStyle>;

    /**
     * Additional styles for the button text
     */
    textStyle?: StyleProp<TextStyle>;

    /**
     * Overrides the button label. When omitted the button renders the ONE
     * primary relying-party action, localized: `accountSwitcher.continueWithOxy`
     * ("Continue with Oxy" in English). "Sign in with Oxy" remains the name of
     * the MECHANISM — only this surface's label is "Continue with Oxy".
     *
     * @default localized `accountSwitcher.continueWithOxy`
     */
    text?: string;

    /**
     * Whether to disable the button
     * @default false
     */
    disabled?: boolean;

    /**
     * Whether to show the button even if user is already authenticated
     * @default false
     */
    showWhenAuthenticated?: boolean;

    /**
     * Exact registered redirect URI the OAuth authorization code is returned to.
     * REQUIRED only for third-party (`type: 'third_party'`) applications, which
     * sign in via OAuth + PKCE against `auth.oxy.so`. First-party / official apps
     * open the in-app dialog and ignore this prop. If a third-party app resolves
     * without it, the button logs an error and does nothing (it will not invent a
     * redirect URI).
     */
    oauthRedirectUri?: string;

    /**
     * Native only: receives the OAuth handshake after a third-party auth session
     * so the RP can finish the token exchange. On web the SDK completes the flow
     * itself — the popup transport keeps the handshake in memory, and the
     * redirect transport reads it back from `sessionStorage` — so this is never
     * called there. A native third-party sign-in with NO `onOAuthResult` handler
     * cannot complete (the `state` + `code_verifier` are lost) and logs a warning.
     *
     * @example
     * ```tsx
     * <OxySignInButton
     *   oauthRedirectUri="myapp://oauth/callback"
     *   onOAuthResult={({ redirectUrl, state, codeVerifier }) => {
     *     if (!redirectUrl) return;
     *     const code = new URL(redirectUrl).searchParams.get('code');
     *     // → POST /auth/oauth/token { code, code_verifier: codeVerifier, state }
     *   }}
     * />
     * ```
     */
    onOAuthResult?: (result: OxyOAuthResult) => void;
}

/**
 * A pre-styled button component for signing in with Oxy identity
 *
 * This component opens the Oxy Auth flow which allows users to authenticate
 * using their Oxy Accounts identity (via QR code or deep link).
 *
 * @example
 * ```tsx
 * // Basic usage
 * <OxySignInButton />
 *
 * // Custom styling
 * <OxySignInButton
 *   variant="contained"
 *   style={{ marginTop: 20 }}
 *   text="Login with Oxy"
 * />
 *
 * // Custom handler
 * <OxySignInButton onPress={() => {
 *   // Custom authentication flow
 * }} />
 * ```
 */
export const OxySignInButton: React.FC<OxySignInButtonProps> = ({
    variant = 'default',
    onPress,
    style,
    textStyle,
    text,
    disabled = false,
    showWhenAuthenticated = false,
    oauthRedirectUri,
    onOAuthResult,
}) => {
    const theme = useTheme();
    const { t } = useI18n();
    const { openAccountDialog, oxyServices, clientId, webAuthMode, startWebOAuthSignIn } = useOxy();
    const { isAuthenticated, isLoading } = useAuthStore(
        useShallow((state) => ({ isAuthenticated: state.isAuthenticated, isLoading: state.isLoading }))
    );
    // Tracks whether the unified account dialog is open so we can show
    // "Signing in..." while it is. The manager reports visibility on every
    // change regardless of platform or what opened/closed it.
    const [isModalOpen, setIsModalOpen] = useState(false);

    useEffect(() => subscribeToAccountDialog(setIsModalOpen), []);

    // The application's public identity is resolved lazily on first press and its
    // promise cached, so rapid taps share one in-flight resolve. The cache is
    // KEYED on the identity inputs (clientId + the oxyServices instance): if
    // either changes the cache is invalidated and re-resolved — without a
    // useEffect. A rejected resolve clears the cache so a later press can retry.
    const appResolutionRef = useRef<{
        clientId: string;
        oxyServices: typeof oxyServices;
        promise: Promise<PublicApplication>;
    } | null>(null);
    // Re-entrancy guard: a routing pass may await network + crypto before it
    // redirects, so block a second concurrent press from racing the sessionStorage
    // handshake against a different PKCE pair.
    const routingRef = useRef(false);
    // Popup mode only opens a window for applications that could actually need
    // one: `oauthRedirectUri` is required for (and only for) third-party OAuth,
    // so an official app never flashes a popup open and closed while its
    // in-app dialog loads.
    const shouldPreOpenPopup =
        Platform.OS === 'web' && webAuthMode === 'popup' && Boolean(oauthRedirectUri);

    const resolvePublicApplication = useCallback((): Promise<PublicApplication> | null => {
        if (!clientId) return null;
        const cached = appResolutionRef.current;
        if (cached && cached.clientId === clientId && cached.oxyServices === oxyServices) {
            return cached.promise;
        }
        const promise = oxyServices.getPublicApplication(clientId).catch((error) => {
            // Only clear if this is still the live entry (a later resolve may have
            // replaced it after a clientId/oxyServices change).
            if (appResolutionRef.current?.promise === promise) {
                appResolutionRef.current = null;
            }
            throw error;
        });
        appResolutionRef.current = { clientId, oxyServices, promise };
        return promise;
    }, [clientId, oxyServices]);

    // A press that cannot reach a sign-in surface must SAY so. Without this the
    // only trace of an aborted sign-in was a console line, so the button read as
    // simply dead — the SDK owns this, so no relying party has to wire it up.
    // `ToastOutlet` is already mounted by `OxyProvider`.
    const notifyNotConfigured = useCallback(
        (appName: string) => {
            toast.error(t('signin.errors.notConfigured'), {
                description: t('signin.errors.notConfiguredDescription', { app: appName }),
            });
        },
        [t],
    );
    const notifyFailed = useCallback(() => {
        toast.error(t('signin.errors.failed'), {
            description: t('signin.errors.failedDescription'),
        });
    }, [t]);

    // Official / first-party surface: the in-app account + sign-in dialog.
    const startOfficialSignIn = useCallback(() => {
        openAccountDialog('signin');
    }, [openAccountDialog]);

    // Third-party surface: an OAuth 2.0 authorization-code + PKCE flow against
    // auth.oxy.so. No FedCM, no SSO bounce, no Oxy session cookies.
    //
    // Web delegates to the ONE shared transport (`startWebOAuthSignIn`), which
    // owns popup-vs-redirect selection, the popup lifecycle, the code exchange,
    // and the session commit. Native keeps its in-app auth session and hands the
    // handshake to the RP, which owns that exchange.
    const startThirdPartyOAuth = useCallback(
        async (app: PublicApplication, popup: OAuthPopupHandle | null): Promise<void> => {
            if (!clientId) {
                closeOAuthPopup(popup);
                startOfficialSignIn();
                return;
            }
            if (!oauthRedirectUri) {
                closeOAuthPopup(popup);
                logger.error(
                    'OxySignInButton: a third_party application requires the `oauthRedirectUri` prop to start the OAuth flow; sign-in aborted',
                    undefined,
                    { component: 'OxySignInButton', clientId, application: app.name },
                );
                notifyNotConfigured(app.name);
                return;
            }

            if (Platform.OS === 'web') {
                const result = await startWebOAuthSignIn({
                    redirectUri: oauthRedirectUri,
                    // In popup mode the window was claimed during the press (see
                    // `handlePress`); `null` means the browser blocked it and the
                    // transport falls back to a redirect. `undefined` (redirect
                    // mode) lets the transport decide for itself.
                    ...(shouldPreOpenPopup ? { popup } : {}),
                });
                if (result.status === 'failed') {
                    logger.warn(
                        `OxySignInButton: web sign-in failed (${result.reason})`,
                        { component: 'OxySignInButton', application: app.name },
                        result.description,
                    );
                    notifyFailed();
                }
                return;
            }

            // Native: open the in-app auth session, then hand the handshake to the
            // RP so it can complete the token exchange from its deep-link callback.
            const [pkce, state] = await Promise.all([generatePkcePair(), generateOAuthState()]);
            const authorizeUrl = buildOAuthAuthorizeUrl({
                clientId,
                redirectUri: oauthRedirectUri,
                state,
                codeChallenge: pkce.codeChallenge,
            });
            const { redirectUrl } = await openAuthorizeUrlNative(authorizeUrl, oauthRedirectUri);
            if (onOAuthResult) {
                onOAuthResult({ redirectUrl, state, codeVerifier: pkce.codeVerifier });
                return;
            }
            logger.warn(
                'OxySignInButton: native third-party sign-in cannot complete without an `onOAuthResult` handler; the code exchange is the RP\'s responsibility (state + code_verifier were not surfaced)',
                { component: 'OxySignInButton', application: app.name },
            );
            notifyNotConfigured(app.name);
        },
        [
            clientId,
            oauthRedirectUri,
            onOAuthResult,
            startOfficialSignIn,
            startWebOAuthSignIn,
            shouldPreOpenPopup,
            notifyNotConfigured,
            notifyFailed,
        ],
    );

    // Resolve the Application once, then route: third-party → OAuth; first-party
    // / official / unresolved → the in-app dialog. Resolution failure NEVER
    // breaks an official app's sign-in — it falls back to the dialog. Every path
    // that does NOT reach the OAuth lane closes the pre-opened popup, so a
    // mis-routed press can never leave an empty window on screen.
    const routeSignIn = useCallback(
        async (popup: OAuthPopupHandle | null): Promise<void> => {
            if (routingRef.current) {
                closeOAuthPopup(popup);
                return;
            }
            routingRef.current = true;
            try {
                const resolving = resolvePublicApplication();
                if (!resolving) {
                    closeOAuthPopup(popup);
                    startOfficialSignIn();
                    return;
                }
                let app: PublicApplication;
                try {
                    app = await resolving;
                } catch (error) {
                    closeOAuthPopup(popup);
                    logger.warn(
                        'OxySignInButton: could not resolve the application; opening the sign-in dialog',
                        { component: 'OxySignInButton', clientId },
                        error,
                    );
                    startOfficialSignIn();
                    return;
                }
                if (app.type === 'third_party' && !app.isOfficial) {
                    await startThirdPartyOAuth(app, popup);
                    return;
                }
                closeOAuthPopup(popup);
                startOfficialSignIn();
            } catch (error) {
                // `handlePress` fires this without awaiting, so an unexpected
                // throw (a rejected native auth session, a crypto failure) would
                // otherwise vanish into an unhandled rejection with the button
                // left looking inert.
                closeOAuthPopup(popup);
                logger.error(
                    'OxySignInButton: sign-in routing threw; sign-in aborted',
                    error instanceof Error ? error : new Error(String(error)),
                    { component: 'OxySignInButton', clientId },
                );
                notifyFailed();
            } finally {
                routingRef.current = false;
            }
        },
        [
            resolvePublicApplication,
            startOfficialSignIn,
            startThirdPartyOAuth,
            clientId,
            notifyFailed,
        ],
    );

    // Defer to a caller-supplied handler, otherwise route by application type.
    //
    // The popup is opened HERE, synchronously, before the async application
    // resolve: `window.open` only survives while the click is still being
    // handled, so a window opened after that first `await` is silently blocked.
    const handlePress = useCallback(() => {
        if (onPress) {
            onPress();
            return;
        }
        void routeSignIn(shouldPreOpenPopup ? openOAuthPopup() : null);
    }, [onPress, routeSignIn, shouldPreOpenPopup]);

    // Don't show the button if already authenticated (unless explicitly overridden)
    if (isAuthenticated && !showWhenAuthenticated) return null;

    const isButtonDisabled = disabled || isLoading || isModalOpen;

    // Map the public `variant` API onto Bloom's Button variants:
    //   contained → primary (filled), outline → outline, default → secondary.
    const buttonVariant: ButtonVariant =
        variant === 'contained' ? 'primary' : variant === 'outline' ? 'outline' : 'secondary';

    // The Oxy mark reads white-on-primary for the filled (contained) button and
    // primary-on-transparent for the outline / default surfaces.
    const isContained = variant === 'contained';
    const logoColor = isContained ? '#ffffff' : theme.colors.primary;
    const logoLetterColor = isContained ? theme.colors.primary : '#ffffff';

    // The relying party surfaces exactly ONE primary action, and it reads
    // "Continue with Oxy" (issue #691). A caller-supplied `text` still wins.
    const label = text ?? t('accountSwitcher.continueWithOxy');

    return (
        <Button
            variant={buttonVariant}
            onPress={handlePress}
            disabled={isButtonDisabled}
            style={style}
            textStyle={[Platform.OS === 'web' ? { fontWeight: '600' } : null, textStyle]}
            icon={
                <LogoIcon
                    height={20}
                    color={logoColor}
                    letterColor={logoLetterColor}
                    style={{ marginRight: 10 }}
                />
            }
        >
            {isLoading || isModalOpen ? t('signin.status.signingIn') : label}
        </Button>
    );
};

export default OxySignInButton;
