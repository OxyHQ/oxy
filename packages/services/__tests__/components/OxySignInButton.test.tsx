/**
 * `OxySignInButton` — the public "Sign in with Oxy" button.
 *
 * These tests cover the routing fork: on press the button resolves the
 * requesting Application (via `oxyServices.getPublicApplication(clientId)`) and
 * routes by type — an official / first-party app opens the in-app account
 * dialog, a `third_party` app starts OAuth 2.0 + PKCE against `auth.oxy.so`.
 *
 * On WEB the OAuth half is delegated to the shared transport
 * (`useOxy().startWebOAuthSignIn`), which owns popup-vs-redirect selection, the
 * authorize URL, and the handshake — those are asserted in
 * `src/ui/oauth/__tests__/browserAuthTransport.test.ts`. What is asserted here
 * is that the button routes to it and never navigates on its own. Native still
 * builds the handshake itself with the REAL `@oxyhq/core` PKCE helpers and hands
 * it to the RP.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Platform } from 'react-native';
import { toast } from '@oxyhq/bloom/toast';
import { logger } from '@oxyhq/core';
import type { PublicApplication } from '@oxyhq/core';
import { redirectToAuthorize, openAuthorizeUrlNative } from '../../src/ui/components/oauthNavigation';
import { OXY_OAUTH_STATE_STORAGE_KEY } from '@oxyhq/core';
import OxySignInButton from '../../src/ui/components/OxySignInButton';
import type { StartWebOAuthSignInOptions } from '../../src/ui/oauth/browserAuthTransport';
import type { WebAuthMode, WebOAuthSignInResult } from '../../src/ui/oauth/types';

const makeApp = (over: Partial<PublicApplication>): PublicApplication => ({
  id: 'app-1',
  name: 'Test App',
  type: 'first_party',
  isOfficial: false,
  isInternal: false,
  scopes: ['openid', 'profile'],
  ...over,
});

const openAccountDialog = jest.fn();
const getPublicApplication = jest.fn<Promise<PublicApplication>, [string]>();
const startWebOAuthSignIn = jest.fn<Promise<WebOAuthSignInResult>, [StartWebOAuthSignInOptions]>();
let clientId: string | null = 'oxy_dk_test';
let webAuthMode: WebAuthMode = 'popup';

const mockRuntime = () => ({
  openAccountDialog,
  oxyServices: { getPublicApplication },
  clientId,
  webAuthMode,
  startWebOAuthSignIn,
  currentLanguage: 'en-US',
});

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => mockRuntime(),
  // The button's label goes through `useI18n()`, the one hook that reads the
  // runtime optionally.
  useOptionalOxy: () => mockRuntime(),
}));

jest.mock('../../src/ui/stores/authStore', () => ({
  __esModule: true,
  useAuthStore: (selector: (s: { isAuthenticated: boolean; isLoading: boolean }) => unknown) =>
    selector({ isAuthenticated: false, isLoading: false }),
}));

jest.mock('zustand/react/shallow', () => ({
  __esModule: true,
  useShallow: (fn: unknown) => fn,
}));

jest.mock('../../src/ui/navigation/accountDialogManager', () => ({
  __esModule: true,
  subscribeToAccountDialog: () => () => undefined,
}));

jest.mock('../../src/ui/components/logo/LogoIcon', () => ({ LogoIcon: () => null }));

jest.mock('../../src/ui/components/oauthNavigation', () => ({
  __esModule: true,
  redirectToAuthorize: jest.fn(),
  openAuthorizeUrlNative: jest.fn(async () => ({ redirectUrl: null })),
}));

const redirectToAuthorizeMock = redirectToAuthorize as jest.MockedFunction<typeof redirectToAuthorize>;
const openAuthorizeUrlNativeMock = openAuthorizeUrlNative as jest.MockedFunction<
  typeof openAuthorizeUrlNative
>;

beforeEach(() => {
  jest.clearAllMocks();
  clientId = 'oxy_dk_test';
  webAuthMode = 'popup';
  Platform.OS = 'web';
  openAuthorizeUrlNativeMock.mockResolvedValue({ redirectUrl: null });
  startWebOAuthSignIn.mockResolvedValue({ status: 'redirecting', via: 'redirect-mode' });
  window.sessionStorage.clear();
});

afterEach(() => {
  Platform.OS = 'web';
});

describe('OxySignInButton', () => {
  // ── Label ─────────────────────────────────────────────────────────────────
  // The relying party surfaces exactly ONE primary action and it reads
  // "Continue with Oxy" (issue #691). "Sign in with Oxy" stays the name of the
  // mechanism everywhere else — only this button's default label changed.
  describe('label', () => {
    it('renders the localized "Continue with Oxy" primary action by default', () => {
      render(<OxySignInButton />);
      expect(screen.getByRole('button').textContent).toBe('Continue with Oxy');
    });

    it('lets a caller-supplied text prop win over the default label', () => {
      render(<OxySignInButton text="Login with Oxy" />);
      expect(screen.getByRole('button').textContent).toBe('Login with Oxy');
    });
  });

  it('opens the in-app dialog for a first-party / official application', async () => {
    getPublicApplication.mockResolvedValue(makeApp({ type: 'first_party', isOfficial: true }));

    render(<OxySignInButton oauthRedirectUri="https://rp.example/callback" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(openAccountDialog).toHaveBeenCalledWith('signin'));
    expect(getPublicApplication).toHaveBeenCalledWith('oxy_dk_test');
    expect(redirectToAuthorizeMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(OXY_OAUTH_STATE_STORAGE_KEY)).toBeNull();
  });

  it('delegates a third_party web sign-in to the shared transport', async () => {
    getPublicApplication.mockResolvedValue(
      makeApp({ type: 'third_party', isOfficial: false, name: 'Third Party' }),
    );

    render(<OxySignInButton oauthRedirectUri="https://rp.example/callback" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(startWebOAuthSignIn).toHaveBeenCalledTimes(1));
    expect(startWebOAuthSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: 'https://rp.example/callback' }),
    );
    expect(openAccountDialog).not.toHaveBeenCalled();
    // The button itself never navigates or writes the handshake — the transport
    // owns both, so exactly one implementation of either exists.
    expect(redirectToAuthorizeMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(OXY_OAUTH_STATE_STORAGE_KEY)).toBeNull();
  });

  it('aborts (no sign-in attempt) for a third_party application with no oauthRedirectUri', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    getPublicApplication.mockResolvedValue(makeApp({ type: 'third_party', isOfficial: false }));

    render(<OxySignInButton />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(startWebOAuthSignIn).not.toHaveBeenCalled();
    expect(redirectToAuthorizeMock).not.toHaveBeenCalled();
    expect(openAccountDialog).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(OXY_OAUTH_STATE_STORAGE_KEY)).toBeNull();
    // The abort must be VISIBLE, not just logged — a console line alone left the
    // button reading as dead to the user.
    expect(toast.error).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('fails closed when the application cannot be resolved', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    getPublicApplication.mockRejectedValue(new Error('network'));

    render(<OxySignInButton oauthRedirectUri="https://rp.example/callback" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(openAccountDialog).not.toHaveBeenCalled();
    expect(startWebOAuthSignIn).not.toHaveBeenCalled();
    expect(redirectToAuthorizeMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('opens the dialog without resolving when there is no clientId', async () => {
    clientId = null;

    render(<OxySignInButton />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(openAccountDialog).toHaveBeenCalledWith('signin'));
    expect(getPublicApplication).not.toHaveBeenCalled();
  });

  it('defers entirely to a caller-supplied onPress', () => {
    const onPress = jest.fn();

    render(<OxySignInButton onPress={onPress} />);
    fireEvent.click(screen.getByRole('button'));

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(getPublicApplication).not.toHaveBeenCalled();
    expect(openAccountDialog).not.toHaveBeenCalled();
  });

  it('hands the OAuth handshake to onOAuthResult for a third_party application (native)', async () => {
    Platform.OS = 'ios';
    openAuthorizeUrlNativeMock.mockResolvedValue({ redirectUrl: 'myapp://cb?code=abc123&state=xyz' });
    getPublicApplication.mockResolvedValue(makeApp({ type: 'third_party', isOfficial: false }));
    const onOAuthResult = jest.fn();

    render(<OxySignInButton oauthRedirectUri="myapp://cb" onOAuthResult={onOAuthResult} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(openAuthorizeUrlNativeMock).toHaveBeenCalledTimes(1));
    // Native never touches sessionStorage or the web full-page redirect.
    expect(redirectToAuthorizeMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(OXY_OAUTH_STATE_STORAGE_KEY)).toBeNull();

    await waitFor(() => expect(onOAuthResult).toHaveBeenCalledTimes(1));
    const [authorizeUrl] = openAuthorizeUrlNativeMock.mock.calls[0];
    const sentState = new URL(authorizeUrl).searchParams.get('state');
    const result = onOAuthResult.mock.calls[0][0];
    expect(result.redirectUrl).toBe('myapp://cb?code=abc123&state=xyz');
    expect(result.state).toBe(sentState);
    expect(typeof result.codeVerifier).toBe('string');
    expect(result.codeVerifier.length).toBeGreaterThan(40);
  });

  it('warns when a native third_party sign-in has no onOAuthResult handler', async () => {
    Platform.OS = 'ios';
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    getPublicApplication.mockResolvedValue(makeApp({ type: 'third_party', isOfficial: false }));

    render(<OxySignInButton oauthRedirectUri="myapp://cb" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(openAuthorizeUrlNativeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(redirectToAuthorizeMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it('re-resolves the application when clientId changes (cache invalidation)', async () => {
    getPublicApplication.mockResolvedValue(makeApp({ type: 'first_party', isOfficial: true }));

    const { rerender } = render(<OxySignInButton />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(getPublicApplication).toHaveBeenCalledWith('oxy_dk_test'));

    clientId = 'oxy_dk_other';
    rerender(<OxySignInButton />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(getPublicApplication).toHaveBeenCalledWith('oxy_dk_other'));
    expect(getPublicApplication).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failure reported by the shared transport instead of silently ending', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    startWebOAuthSignIn.mockResolvedValue({ status: 'failed', reason: 'handshake-storage' });
    getPublicApplication.mockResolvedValue(makeApp({ type: 'third_party', isOfficial: false }));

    render(<OxySignInButton oauthRedirectUri="https://rp.example/callback" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(warnSpy).toHaveBeenCalled());
    expect(warnSpy.mock.calls[0][0]).toContain('handshake-storage');
    expect(openAccountDialog).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  // `handlePress` fires routing without awaiting it, so before this an
  // unexpected throw became an unhandled rejection and the button just sat there.
  it('toasts instead of swallowing an unexpected throw while routing', async () => {
    Platform.OS = 'ios';
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    getPublicApplication.mockResolvedValue(makeApp({ type: 'third_party', isOfficial: false }));
    openAuthorizeUrlNativeMock.mockRejectedValue(new Error('auth session dismissed'));

    render(<OxySignInButton oauthRedirectUri="myapp://cb" onOAuthResult={jest.fn()} />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  // ── Popup mode ────────────────────────────────────────────────────────────
  // `window.open` only survives while the click is still being handled, and the
  // button awaits a network resolve before it even knows the application is
  // third-party — so the window MUST be claimed in the press handler and carried
  // into the transport, and released again on every path that does not use it.
  describe('popup mode', () => {
    let popup: { closed: boolean; close: jest.Mock; location: { href: string } };
    let openSpy: jest.SpyInstance;

    beforeEach(() => {
      webAuthMode = 'popup';
      popup = { closed: false, close: jest.fn(), location: { href: '' } };
      openSpy = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    });

    afterEach(() => {
      openSpy.mockRestore();
    });

    it('claims the popup during the press and carries it into the shared transport', async () => {
      // Resolve the application only once the press has been observed.
      let releaseApplication: (app: PublicApplication) => void = () => undefined;
      getPublicApplication.mockReturnValue(
        new Promise<PublicApplication>((resolve) => {
          releaseApplication = resolve;
        }),
      );

      render(<OxySignInButton oauthRedirectUri="https://rp.example/callback" />);
      fireEvent.click(screen.getByRole('button'));

      // Synchronously after the click, with the application still unresolved.
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(startWebOAuthSignIn).not.toHaveBeenCalled();

      releaseApplication(makeApp({ type: 'third_party', isOfficial: false }));

      await waitFor(() => expect(startWebOAuthSignIn).toHaveBeenCalledTimes(1));
      expect(startWebOAuthSignIn).toHaveBeenCalledWith({
        redirectUri: 'https://rp.example/callback',
        popup,
      });
      expect(openSpy).toHaveBeenCalledTimes(1);
    });

    it('hands the transport a null popup when the browser blocked it', async () => {
      openSpy.mockReturnValue(null);
      getPublicApplication.mockResolvedValue(makeApp({ type: 'third_party', isOfficial: false }));

      render(<OxySignInButton oauthRedirectUri="https://rp.example/callback" />);
      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => expect(startWebOAuthSignIn).toHaveBeenCalledTimes(1));
      expect(startWebOAuthSignIn).toHaveBeenCalledWith({
        redirectUri: 'https://rp.example/callback',
        popup: null,
      });
    });

    it('closes the pre-opened popup when the application turns out to be official', async () => {
      getPublicApplication.mockResolvedValue(makeApp({ type: 'first_party', isOfficial: true }));

      render(<OxySignInButton oauthRedirectUri="https://rp.example/callback" />);
      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => expect(openAccountDialog).toHaveBeenCalledWith('signin'));
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(startWebOAuthSignIn).not.toHaveBeenCalled();
    });

    it('opens no window for an application that has no registered redirect URI', async () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      getPublicApplication.mockResolvedValue(makeApp({ type: 'third_party', isOfficial: false }));

      render(<OxySignInButton />);
      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => expect(errorSpy).toHaveBeenCalled());
      expect(openSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
    });
  });

  it('opens no window in redirect mode, even for a third_party application', async () => {
    webAuthMode = 'redirect';
    const openSpy = jest.spyOn(window, 'open');
    getPublicApplication.mockResolvedValue(makeApp({ type: 'third_party', isOfficial: false }));

    render(<OxySignInButton oauthRedirectUri="https://rp.example/callback" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(startWebOAuthSignIn).toHaveBeenCalledTimes(1));
    expect(openSpy).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });
});
