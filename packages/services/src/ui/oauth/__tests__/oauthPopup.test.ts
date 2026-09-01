import {
  awaitOAuthPopupResult,
  closeOAuthPopup,
  navigateOAuthPopup,
  openOAuthPopup,
  OXY_OAUTH_POPUP_WINDOW_NAME,
} from '../oauthPopup';
import { OXY_OAUTH_CODE_MESSAGE_TYPE, OXY_OAUTH_ERROR_MESSAGE_TYPE } from '../oauthPopupMessages';
import type { OAuthPopupHandle, OAuthPopupOutcome } from '../types';

const IDP_ORIGIN = 'https://auth.oxy.so';
const REDIRECT_URI = 'https://mention.earth';
const STATE = 'state-abc';

interface ControllablePopup extends OAuthPopupHandle {
  close: jest.Mock;
  setClosed: () => void;
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
    setClosed: () => {
      closed = true;
    },
  };
}

function dispatchMessage(init: { data: unknown; origin: string; source: unknown }): void {
  const event = new Event('message');
  Object.assign(event, init);
  window.dispatchEvent(event);
}

function codeMessage(source: unknown, state = STATE, origin = IDP_ORIGIN) {
  return {
    data: { type: OXY_OAUTH_CODE_MESSAGE_TYPE, code: 'code-1', state },
    origin,
    source,
  };
}

/** Resolve the outcome, or `'pending'` when the promise has not settled yet. */
async function outcomeOrPending(
  promise: Promise<OAuthPopupOutcome>,
): Promise<OAuthPopupOutcome | 'pending'> {
  return Promise.race([
    promise,
    Promise.resolve().then(() => 'pending' as const),
  ]);
}

describe('openOAuthPopup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens an empty, named window so a second press reuses it', () => {
    const handle = fakePopup();
    const openSpy = jest
      .spyOn(window, 'open')
      .mockReturnValue(handle as unknown as Window);

    expect(openOAuthPopup()).toBe(handle);
    expect(openSpy).toHaveBeenCalledWith('', OXY_OAUTH_POPUP_WINDOW_NAME, expect.any(String));
    // The window is navigated later, once the authorize URL exists.
    expect(openSpy.mock.calls[0][0]).toBe('');
  });

  it('returns null when the browser blocks the popup', () => {
    jest.spyOn(window, 'open').mockReturnValue(null);
    expect(openOAuthPopup()).toBeNull();
  });

  it('returns null instead of throwing when window.open throws', () => {
    jest.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(openOAuthPopup()).toBeNull();
  });
});

describe('navigateOAuthPopup', () => {
  it('points the popup at the authorize URL', () => {
    const popup = fakePopup();
    expect(navigateOAuthPopup(popup, `${IDP_ORIGIN}/authorize?x=1`)).toBe(true);
    expect(popup.location.href).toBe(`${IDP_ORIGIN}/authorize?x=1`);
  });

  it('reports failure instead of throwing when the window is gone', () => {
    const popup: OAuthPopupHandle = {
      closed: true,
      close: () => undefined,
      get location(): { href: string } {
        throw new Error('window closed');
      },
    };
    expect(navigateOAuthPopup(popup, `${IDP_ORIGIN}/authorize`)).toBe(false);
  });
});

describe('closeOAuthPopup', () => {
  it('is a no-op for null and for an already-closed window', () => {
    expect(() => closeOAuthPopup(null)).not.toThrow();
    const popup = fakePopup();
    popup.setClosed();
    closeOAuthPopup(popup);
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('closes an open window and swallows a close that throws', () => {
    const popup = fakePopup();
    closeOAuthPopup(popup);
    expect(popup.close).toHaveBeenCalledTimes(1);

    const hostile: OAuthPopupHandle = {
      closed: false,
      close: () => {
        throw new Error('denied');
      },
      location: { href: '' },
    };
    expect(() => closeOAuthPopup(hostile)).not.toThrow();
  });
});

describe('awaitOAuthPopupResult', () => {
  let addSpy: jest.SpyInstance;
  let removeSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    addSpy = jest.spyOn(window, 'addEventListener');
    removeSpy = jest.spyOn(window, 'removeEventListener');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Every exit path must leave zero listeners and zero timers behind. */
  function expectFullCleanup(): void {
    const registered = addSpy.mock.calls.filter(([type]) => type === 'message');
    const removed = removeSpy.mock.calls.filter(([type]) => type === 'message');
    expect(registered).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(removed[0][1]).toBe(registered[0][1]);
    expect(jest.getTimerCount()).toBe(0);
  }

  it('resolves with the authorization code on a valid message', async () => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
    });

    dispatchMessage(codeMessage(popup));

    await expect(promise).resolves.toEqual({ kind: 'code', code: 'code-1', state: STATE });
    expectFullCleanup();
  });

  it('resolves with a typed IdP error', async () => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
    });

    dispatchMessage({
      data: {
        type: OXY_OAUTH_ERROR_MESSAGE_TYPE,
        error: 'access_denied',
        errorDescription: 'user declined',
        state: STATE,
      },
      origin: IDP_ORIGIN,
      source: popup,
    });

    await expect(promise).resolves.toEqual({
      kind: 'oauth-error',
      error: 'access_denied',
      errorDescription: 'user declined',
    });
    expectFullCleanup();
  });

  it('resolves with a state mismatch when our popup answers another request', async () => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
    });

    dispatchMessage(codeMessage(popup, 'a-different-state'));

    await expect(promise).resolves.toEqual({ kind: 'state-mismatch' });
    expectFullCleanup();
  });

  it.each([
    ['a foreign origin', () => codeMessage(fakePopup(), STATE, 'https://evil.example')],
    ['a foreign window', () => codeMessage(fakePopup())],
  ])('keeps waiting after a message from %s', async (_label, build) => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
      timeoutMs: 60_000,
    });

    dispatchMessage(build());
    expect(await outcomeOrPending(promise)).toBe('pending');

    // The real popup can still complete the flow afterwards.
    dispatchMessage(codeMessage(popup));
    await expect(promise).resolves.toEqual({ kind: 'code', code: 'code-1', state: STATE });
    expectFullCleanup();
  });

  it('keeps waiting after a malformed payload from the real popup', async () => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
      timeoutMs: 60_000,
    });

    dispatchMessage({ data: { type: 'oxy:oauth:code' }, origin: IDP_ORIGIN, source: popup });
    expect(await outcomeOrPending(promise)).toBe('pending');

    dispatchMessage(codeMessage(popup));
    await expect(promise).resolves.toEqual({ kind: 'code', code: 'code-1', state: STATE });
    expectFullCleanup();
  });

  it('ignores a duplicate result: the first message wins and the listener is gone', async () => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
    });

    dispatchMessage(codeMessage(popup));
    await expect(promise).resolves.toEqual({ kind: 'code', code: 'code-1', state: STATE });

    // A late redelivery (or a second, contradicting message) reaches nothing.
    expect(() =>
      dispatchMessage({
        data: { type: OXY_OAUTH_ERROR_MESSAGE_TYPE, error: 'access_denied', state: STATE },
        origin: IDP_ORIGIN,
        source: popup,
      }),
    ).not.toThrow();
    await expect(promise).resolves.toEqual({ kind: 'code', code: 'code-1', state: STATE });
    expectFullCleanup();
  });

  it('reports cancellation once the user closes the window', async () => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
    });

    popup.setClosed();
    jest.advanceTimersByTime(1000);
    // The close is not reported instantly: an already-queued message may still win.
    expect(await outcomeOrPending(promise)).toBe('pending');

    jest.advanceTimersByTime(400);
    await expect(promise).resolves.toEqual({ kind: 'closed' });
    expectFullCleanup();
  });

  it('lets a result that arrived just before the close win the race', async () => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
    });

    // The IdP posts its result and immediately closes itself.
    popup.setClosed();
    jest.advanceTimersByTime(1000);
    dispatchMessage(codeMessage(popup));
    jest.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({ kind: 'code', code: 'code-1', state: STATE });
    expectFullCleanup();
  });

  it('times out when nothing ever answers', async () => {
    const popup = fakePopup();
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
      timeoutMs: 30_000,
    });

    jest.advanceTimersByTime(29_999);
    expect(await outcomeOrPending(promise)).toBe('pending');

    jest.advanceTimersByTime(1);
    await expect(promise).resolves.toEqual({ kind: 'timed-out' });
    expectFullCleanup();
  });

  it('reads a same-origin redirect fallback from the popup URL when postMessage is unavailable', async () => {
    const popup = fakePopup();
    popup.location.href = `${REDIRECT_URI}?code=auth-code&state=${STATE}`;
    const promise = awaitOAuthPopupResult({
      popup,
      expectedOrigin: IDP_ORIGIN,
      expectedState: STATE,
      redirectUri: REDIRECT_URI,
    });

    jest.advanceTimersByTime(1000);

    await expect(promise).resolves.toEqual({ kind: 'code', code: 'auth-code', state: STATE });
    expectFullCleanup();
  });
});
