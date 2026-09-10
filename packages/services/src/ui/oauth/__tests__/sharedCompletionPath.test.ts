/**
 * Both web transports MUST finish through the same completion function.
 *
 * A duplicated exchange/commit implementation is how the popup and redirect
 * lanes would silently drift apart on `state` validation, PKCE replay, or the
 * session commit — so this suite mocks `completeOAuthCode` and proves each lane
 * routes through it and performs no exchange of its own.
 */

jest.mock('../completeOAuthCode', () => ({
  completeOAuthCode: jest.fn(),
}));
jest.mock('../../components/oauthNavigation', () => ({
  redirectToAuthorize: jest.fn(),
}));

import type { OxyServices } from '@oxy.so/core';
import {
  OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY,
  OXY_OAUTH_STATE_STORAGE_KEY,
} from '@oxy.so/core';
import { tryCompleteOAuthReturn } from '../../utils/oauthReturn';
import { startWebOAuthSignIn, type WebOAuthTransportContext } from '../browserAuthTransport';
import { completeOAuthCode } from '../completeOAuthCode';
import { OXY_OAUTH_CODE_MESSAGE_TYPE } from '../oauthPopupMessages';
import type { CompleteOAuthCodeInput } from '../completeOAuthCode';
import type { OAuthPopupHandle } from '../types';

const mockCompleteOAuthCode = completeOAuthCode as jest.Mock;

const CLIENT_ID = 'oxy_dk_test';
const REDIRECT_URI = 'https://mention.earth';
const IDP_ORIGIN = 'https://auth.oxy.so';

function fakePopup(): OAuthPopupHandle {
  return { closed: false, close: jest.fn(), location: { href: '' } };
}

function makeContext(mode: 'popup' | 'redirect'): WebOAuthTransportContext & {
  exchangeOAuthCode: jest.Mock;
} {
  const exchangeOAuthCode = jest.fn();
  return {
    mode,
    oxyServices: { exchangeOAuthCode } as unknown as OxyServices,
    clientId: CLIENT_ID,
    authorizeBaseUrl: `${IDP_ORIGIN}/authorize`,
    identityBound: false,
    commitSession: jest.fn().mockResolvedValue(undefined),
    exchangeOAuthCode,
  };
}

async function waitForAuthorizeUrl(popup: OAuthPopupHandle): Promise<URL> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (popup.location.href) return new URL(popup.location.href);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error('the popup was never navigated to the authorize URL');
}

describe('shared OAuth completion path', () => {
  beforeEach(() => {
    mockCompleteOAuthCode.mockReset();
    mockCompleteOAuthCode.mockResolvedValue({ ok: true });
    globalThis.sessionStorage?.clear();
    window.history.replaceState({}, '', '/');
  });

  it('the popup transport completes through completeOAuthCode with its in-memory handshake', async () => {
    const context = makeContext('popup');
    const popup = fakePopup();

    const pending = startWebOAuthSignIn(context, { redirectUri: REDIRECT_URI, popup });
    const authorizeUrl = await waitForAuthorizeUrl(popup);
    const state = authorizeUrl.searchParams.get('state');
    const event = new Event('message');
    Object.assign(event, {
      data: { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'code-1', state },
      origin: IDP_ORIGIN,
      source: popup,
    });
    window.dispatchEvent(event);

    await expect(pending).resolves.toEqual({ status: 'signed-in' });

    expect(mockCompleteOAuthCode).toHaveBeenCalledTimes(1);
    const input = mockCompleteOAuthCode.mock.calls[0][0] as CompleteOAuthCodeInput;
    expect(input.code).toBe('code-1');
    expect(input.clientId).toBe(CLIENT_ID);
    expect(input.redirectUri).toBe(REDIRECT_URI);
    expect(input.returnedState).toBe(state);
    expect(input.handshake?.state).toBe(state);
    expect(input.handshake?.codeVerifier).toEqual(expect.any(String));
    // Nothing was persisted, so there is nothing for this lane to clean up.
    expect(input.cleanup).toBeUndefined();
    // The transport never exchanges the code itself.
    expect(context.exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it('the redirect return leg completes through completeOAuthCode with the persisted handshake', async () => {
    const exchangeOAuthCode = jest.fn();
    const oxyServices = { exchangeOAuthCode } as unknown as OxyServices;
    sessionStorage.setItem(OXY_OAUTH_STATE_STORAGE_KEY, 'state-from-storage');
    sessionStorage.setItem(OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY, 'verifier-from-storage');
    window.history.replaceState({}, '', '/feed?code=code-2&state=state-from-storage');

    await expect(
      tryCompleteOAuthReturn({
        oxyServices,
        clientId: CLIENT_ID,
        authRedirectUri: REDIRECT_URI,
        commitSession: jest.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe(true);

    expect(mockCompleteOAuthCode).toHaveBeenCalledTimes(1);
    const input = mockCompleteOAuthCode.mock.calls[0][0] as CompleteOAuthCodeInput;
    expect(input.code).toBe('code-2');
    expect(input.returnedState).toBe('state-from-storage');
    expect(input.handshake).toEqual({
      state: 'state-from-storage',
      codeVerifier: 'verifier-from-storage',
    });
    expect(input.redirectUri).toBe(REDIRECT_URI);
    // This lane DOES have persisted state + a dirty URL to clear.
    expect(typeof input.cleanup).toBe('function');
    // The return leg never exchanges the code itself.
    expect(exchangeOAuthCode).not.toHaveBeenCalled();
  });

  it('reports the shared path failing rather than committing a session', async () => {
    mockCompleteOAuthCode.mockResolvedValue({ ok: false, reason: 'state-mismatch' });
    sessionStorage.setItem(OXY_OAUTH_STATE_STORAGE_KEY, 'state-from-storage');
    sessionStorage.setItem(OXY_OAUTH_CODE_VERIFIER_STORAGE_KEY, 'verifier-from-storage');
    window.history.replaceState({}, '', '/?code=code-3&state=state-from-storage');

    await expect(
      tryCompleteOAuthReturn({
        oxyServices: { exchangeOAuthCode: jest.fn() } as unknown as OxyServices,
        clientId: CLIENT_ID,
        commitSession: jest.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe(false);
  });

  it('never reaches the shared path without a clientId', async () => {
    window.history.replaceState({}, '', '/?code=code-4&state=state-from-storage');

    await expect(
      tryCompleteOAuthReturn({
        oxyServices: { exchangeOAuthCode: jest.fn() } as unknown as OxyServices,
        clientId: null,
        commitSession: jest.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe(false);
    expect(mockCompleteOAuthCode).not.toHaveBeenCalled();
  });

  it('never reaches the shared path when the IdP returned an error instead of a code', async () => {
    window.history.replaceState({}, '', '/?error=access_denied&state=state-from-storage');

    await expect(
      tryCompleteOAuthReturn({
        oxyServices: { exchangeOAuthCode: jest.fn() } as unknown as OxyServices,
        clientId: CLIENT_ID,
        commitSession: jest.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe(false);
    expect(mockCompleteOAuthCode).not.toHaveBeenCalled();
  });
});
