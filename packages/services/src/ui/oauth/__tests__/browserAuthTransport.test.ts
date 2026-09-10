// The platform redirect is spied on so no real navigation happens and the
// authorize URL each lane hands to the browser can be asserted.
jest.mock('../../components/oauthNavigation', () => ({
  redirectToAuthorize: jest.fn(),
}));

import type { OxyServices } from '@oxy.so/core';
import {
  computeCodeChallenge,
  OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY,
  OXY_OAUTH_STATE_STORAGE_KEY,
} from '@oxy.so/core';
import { redirectToAuthorize } from '../../components/oauthNavigation';
import {
  startWebOAuthSignIn,
  type WebOAuthTransportContext,
} from '../browserAuthTransport';
import { OXY_OAUTH_CODE_MESSAGE_TYPE, OXY_OAUTH_ERROR_MESSAGE_TYPE } from '../oauthPopupMessages';
import type { OAuthPopupHandle } from '../types';

const mockRedirect = redirectToAuthorize as jest.Mock;

const CLIENT_ID = 'oxy_dk_test';
const REDIRECT_URI = 'https://mention.earth';
const AUTHORIZE_BASE_URL = 'https://auth.oxy.so/authorize';
const IDP_ORIGIN = 'https://auth.oxy.so';

const SESSION = {
  sessionId: 'sess-1',
  deviceId: 'dev-1',
  deviceSecret: 'secret-1',
  accessToken: 'token-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: { id: 'user-1', username: 'nate' },
};

interface ControllablePopup extends OAuthPopupHandle {
  close: jest.Mock;
}

function fakePopup(): ControllablePopup {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    close: jest.fn(() => {
      closed = true;
    }),
    location: { href: '' },
  };
}

function makeContext(
  overrides: Partial<WebOAuthTransportContext> = {},
): WebOAuthTransportContext & { exchangeOAuthCode: jest.Mock; commitSession: jest.Mock } {
  const exchangeOAuthCode = jest.fn().mockResolvedValue(SESSION);
  const commitSession = jest.fn().mockResolvedValue(undefined);
  const base: WebOAuthTransportContext = {
    mode: 'popup',
    oxyServices: { exchangeOAuthCode } as unknown as OxyServices,
    clientId: CLIENT_ID,
    authorizeBaseUrl: AUTHORIZE_BASE_URL,
    identityBound: false,
    commitSession,
  };
  return { ...base, ...overrides, exchangeOAuthCode, commitSession };
}

/** Wait for the transport to finish preparing PKCE and navigate the popup. */
async function waitForAuthorizeUrl(popup: OAuthPopupHandle): Promise<URL> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (popup.location.href) return new URL(popup.location.href);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('the popup was never navigated to the authorize URL');
}

function dispatchFromPopup(data: unknown, source: unknown, origin = IDP_ORIGIN): void {
  const event = new Event('message');
  Object.assign(event, { data, origin, source });
  window.dispatchEvent(event);
}

describe('startWebOAuthSignIn', () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    globalThis.sessionStorage?.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('popup mode', () => {
    it('signs in without navigating the relying party', async () => {
      const context = makeContext();
      const popup = fakePopup();

      const pending = startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI, popup });
      const authorizeUrl = await waitForAuthorizeUrl(popup);

      // The IdP is asked for the popup channel, with the standard PKCE binding.
      expect(authorizeUrl.origin).toBe(IDP_ORIGIN);
      expect(authorizeUrl.searchParams.get('response_mode')).toBe('web_message');
      expect(authorizeUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');

      const state = authorizeUrl.searchParams.get('state');
      dispatchFromPopup(
        { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'code-1', state },
        popup,
      );

      await expect(pending).resolves.toEqual({ status: 'signed-in' });
      expect(mockRedirect).not.toHaveBeenCalled();

      // The verifier the main window replays is the one behind the challenge it
      // sent — the popup never saw either.
      const exchangeArgs = context.exchangeOAuthCode.mock.calls[0][0];
      expect(exchangeArgs.code).toBe('code-1');
      expect(exchangeArgs.redirectUri).toBe(REDIRECT_URI);
      await expect(computeCodeChallenge(exchangeArgs.codeVerifier)).resolves.toBe(
        authorizeUrl.searchParams.get('code_challenge'),
      );

      expect(context.commitSession).toHaveBeenCalledTimes(1);
      // Nothing about the popup handshake is left in storage.
      expect(sessionStorage.getItem(OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(OXY_OAUTH_STATE_STORAGE_KEY)).toBeNull();
    });

    it('opens the window itself when the caller did not pre-open one', async () => {
      const context = makeContext();
      const popup = fakePopup();
      const openSpy = jest.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      const pending = startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI });
      const authorizeUrl = await waitForAuthorizeUrl(popup);
      dispatchFromPopup(
        {
          type: OXY_OAUTH_CODE_MESSAGE_TYPE,
          code: 'code-1',
          state: authorizeUrl.searchParams.get('state'),
        },
        popup,
      );

      await expect(pending).resolves.toEqual({ status: 'signed-in' });
      expect(openSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to a full-page redirect when the popup was blocked', async () => {
      const context = makeContext();

      const result = await startWebOAuthSignIn(context, {
        redirectUri: REDIRECT_URI,
        popup: null,
      });

      expect(result).toEqual({ status: 'redirecting', via: 'popup-blocked' });
      expect(mockRedirect).toHaveBeenCalledTimes(1);
      // The fallback is a plain redirect request — no popup channel.
      const url = new URL(mockRedirect.mock.calls[0][0]);
      expect(url.searchParams.get('response_mode')).toBeNull();
      // …and its handshake survives the navigation.
      expect(sessionStorage.getItem(OXY_OAUTH_STATE_STORAGE_KEY)).toBe(
        url.searchParams.get('state'),
      );
      expect(sessionStorage.getItem(OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY)).toBeTruthy();
      expect(context.exchangeOAuthCode).not.toHaveBeenCalled();
    });

    it('falls back to a full-page redirect when the popup cannot be navigated', async () => {
      const context = makeContext();
      const deadPopup: OAuthPopupHandle = {
        closed: false,
        close: jest.fn(),
        get location(): { href: string } {
          throw new Error('window closed');
        },
      };

      const result = await startWebOAuthSignIn(context, {
        redirectUri: REDIRECT_URI,
        popup: deadPopup,
      });

      expect(result).toEqual({ status: 'redirecting', via: 'popup-navigation-failed' });
      expect(mockRedirect).toHaveBeenCalledTimes(1);
    });

    it('surfaces a typed IdP error and closes the window', async () => {
      const context = makeContext();
      const popup = fakePopup();

      const pending = startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI, popup });
      const authorizeUrl = await waitForAuthorizeUrl(popup);
      dispatchFromPopup(
        {
          type: OXY_OAUTH_ERROR_MESSAGE_TYPE,
          error: 'access_denied',
          errorDescription: 'user declined',
          state: authorizeUrl.searchParams.get('state'),
        },
        popup,
      );

      await expect(pending).resolves.toEqual({
        status: 'failed',
        reason: 'idp-error',
        description: 'user declined',
      });
      expect(context.exchangeOAuthCode).not.toHaveBeenCalled();
      expect(popup.close).toHaveBeenCalled();
    });

    it('refuses a result carrying the wrong state', async () => {
      const context = makeContext();
      const popup = fakePopup();

      const pending = startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI, popup });
      await waitForAuthorizeUrl(popup);
      dispatchFromPopup(
        { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'code-1', state: 'forged-state' },
        popup,
      );

      await expect(pending).resolves.toEqual({ status: 'failed', reason: 'state-mismatch' });
      expect(context.exchangeOAuthCode).not.toHaveBeenCalled();
      expect(context.commitSession).not.toHaveBeenCalled();
    });

    it('reports a timeout when the popup never answers', async () => {
      const context = makeContext();
      const popup = fakePopup();

      const result = await startWebOAuthSignIn(context, {
        redirectUri: REDIRECT_URI,
        popup,
        timeoutMs: 20,
      });

      expect(result).toEqual({ status: 'timed-out' });
      expect(popup.close).toHaveBeenCalled();
      expect(context.exchangeOAuthCode).not.toHaveBeenCalled();
    });

    it('reports a failed exchange', async () => {
      const context = makeContext();
      context.exchangeOAuthCode.mockRejectedValue(new Error('invalid_grant'));
      const popup = fakePopup();

      const pending = startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI, popup });
      const authorizeUrl = await waitForAuthorizeUrl(popup);
      dispatchFromPopup(
        {
          type: OXY_OAUTH_CODE_MESSAGE_TYPE,
          code: 'code-1',
          state: authorizeUrl.searchParams.get('state'),
        },
        popup,
      );

      await expect(pending).resolves.toEqual({ status: 'failed', reason: 'exchange-failed' });
      expect(context.commitSession).not.toHaveBeenCalled();
    });
  });

  describe('redirect mode', () => {
    it('hands the top-level document to the IdP and persists the handshake', async () => {
      const context = makeContext({ mode: 'redirect' });

      const result = await startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI });

      expect(result).toEqual({ status: 'redirecting', via: 'redirect-mode' });
      expect(mockRedirect).toHaveBeenCalledTimes(1);
      const url = new URL(mockRedirect.mock.calls[0][0]);
      expect(url.searchParams.get('response_mode')).toBeNull();
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(sessionStorage.getItem(OXY_OAUTH_STATE_STORAGE_KEY)).toBe(
        url.searchParams.get('state'),
      );
    });

    it('never opens a window, even if one was handed to it', async () => {
      const context = makeContext({ mode: 'redirect' });
      const popup = fakePopup();
      const openSpy = jest.spyOn(window, 'open');

      await startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI, popup });

      expect(openSpy).not.toHaveBeenCalled();
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(popup.location.href).toBe('');
    });

    it('aborts instead of redirecting when the handshake cannot be persisted', async () => {
      const context = makeContext({ mode: 'redirect' });
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage is disabled');
      });

      const result = await startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI });

      expect(result).toEqual({ status: 'failed', reason: 'handshake-storage' });
      expect(mockRedirect).not.toHaveBeenCalled();
    });
  });

  describe('inapplicable configurations', () => {
    it('refuses an identity-bound provider and closes any popup it was given', async () => {
      const context = makeContext({ identityBound: true });
      const popup = fakePopup();

      const result = await startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI, popup });

      expect(result).toEqual({ status: 'unsupported', reason: 'identity-bound' });
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(mockRedirect).not.toHaveBeenCalled();
    });

    it('refuses a provider with no clientId', async () => {
      const context = makeContext({ clientId: null });

      const result = await startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI });

      expect(result).toEqual({ status: 'unsupported', reason: 'missing-client-id' });
      expect(mockRedirect).not.toHaveBeenCalled();
    });
  });
});
