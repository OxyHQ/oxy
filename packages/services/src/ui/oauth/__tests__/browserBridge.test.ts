/**
 * The browser bridge, the app half (ADR 0029 D2): the window opens from the
 * press, carries a PKCE-bound request, accepts only its own answer, joins, and
 * always closes.
 */
import { createHash } from 'node:crypto';
import { OxyServices } from '@oxy.so/core';
import {
  OXY_BRIDGE_CODE_MESSAGE_TYPE,
  OXY_BRIDGE_ERROR_MESSAGE_TYPE,
  OXY_BRIDGE_WINDOW_NAME,
  openBridgeWindow,
  readBridgeMessage,
  resolveBridgeOrigin,
  runBrowserBridge,
} from '../browserBridge';
import { trackDeviceCredential } from '../../session/deviceCredentialTracker';
import type { OAuthPopupHandle } from '../types';

const AUTH = 'https://auth.oxy.so';
const APP = 'https://mention.earth';

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

function dispatchMessage(init: { data: unknown; origin: string; source: unknown }): void {
  const event = new Event('message');
  Object.assign(event, init);
  window.dispatchEvent(event);
}

/** Wait until the popup has been navigated to the bridge, and read its query. */
async function navigated(popup: OAuthPopupHandle): Promise<URL> {
  for (let i = 0; i < 100 && !popup.location.href; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return new URL(popup.location.href);
}

afterEach(() => jest.restoreAllMocks());

describe('resolveBridgeOrigin', () => {
  it('is auth.oxy.so by default and follows an authorize override', () => {
    expect(resolveBridgeOrigin()).toBe(AUTH);
    expect(resolveBridgeOrigin('http://localhost:8105/authorize')).toBe('http://localhost:8105');
    expect(resolveBridgeOrigin('not a url')).toBeNull();
  });
});

describe('openBridgeWindow', () => {
  it('opens an empty, tiny, separately named window', () => {
    const handle = fakePopup();
    const open = jest.spyOn(window, 'open').mockReturnValue(handle as unknown as Window);
    expect(openBridgeWindow()).toBe(handle);
    expect(open).toHaveBeenCalledWith('', OXY_BRIDGE_WINDOW_NAME, expect.stringContaining('width=1,height=1'));
  });

  it('is null when blocked or when open throws', () => {
    jest.spyOn(window, 'open').mockReturnValue(null);
    expect(openBridgeWindow()).toBeNull();
    jest.spyOn(window, 'open').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(openBridgeWindow()).toBeNull();
  });
});

describe('readBridgeMessage', () => {
  const popup = fakePopup();
  const context = { expectedOrigin: AUTH, expectedState: 'st', popup };
  const code = { type: OXY_BRIDGE_CODE_MESSAGE_TYPE, code: 'c1', state: 'st' };

  it('accepts only its own window, origin and state', () => {
    expect(readBridgeMessage({ origin: AUTH, source: popup as never, data: code }, context)).toEqual({ kind: 'code', code: 'c1' });
    expect(readBridgeMessage({ origin: 'https://evil.example', source: popup as never, data: code }, context).kind).toBe('ignore');
    expect(readBridgeMessage({ origin: AUTH, source: fakePopup() as never, data: code }, context).kind).toBe('ignore');
    expect(readBridgeMessage({ origin: AUTH, source: popup as never, data: { ...code, state: 'other' } }, context).kind).toBe('ignore');
    expect(readBridgeMessage({ origin: AUTH, source: popup as never, data: 'nope' }, context).kind).toBe('ignore');
    expect(
      readBridgeMessage(
        { origin: AUTH, source: popup as never, data: { type: OXY_BRIDGE_ERROR_MESSAGE_TYPE, error: 'x', state: 'st' } },
        context,
      ),
    ).toEqual({ kind: 'error', error: 'x' });
  });
});

describe('runBrowserBridge', () => {
  it('navigates with a PKCE-bound request, joins with the verifier, and closes', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    const join = jest.spyOn(oxy, 'joinBrowserDevice').mockResolvedValue({ deviceId: 'dev-1', deviceSecret: 'app-secret' });
    const popup = fakePopup();

    const result = runBrowserBridge({ popup, bridgeOrigin: AUTH, oxyServices: oxy, clientId: 'oxy_dk_1', redirectUri: APP });
    const url = await navigated(popup);
    expect(url.origin + url.pathname).toBe(`${AUTH}/bridge`);
    expect(url.searchParams.get('client_id')).toBe('oxy_dk_1');
    expect(url.searchParams.get('redirect_uri')).toBe(APP);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');

    dispatchMessage({ origin: 'https://evil.example', source: popup, data: { type: OXY_BRIDGE_CODE_MESSAGE_TYPE, code: 'forged', state } });
    dispatchMessage({ origin: AUTH, source: popup, data: { type: OXY_BRIDGE_CODE_MESSAGE_TYPE, code: 'code-1', state } });

    expect(await result).toEqual({ ok: true, deviceId: 'dev-1', deviceSecret: 'app-secret' });
    const [request] = join.mock.calls[0];
    expect(request.code).toBe('code-1');
    expect(request.clientId).toBe('oxy_dk_1');
    expect(request.redirectUri).toBe(APP);
    // The verifier is the one whose S256 digest was sent as the challenge.
    expect(createHash('sha256').update(request.codeVerifier).digest('base64url')).toBe(challenge);
    expect(popup.close).toHaveBeenCalled();
  });

  it('reports a bridge error, a closed window and a timeout, closing the window each time', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    const join = jest.spyOn(oxy, 'joinBrowserDevice');

    let popup = fakePopup();
    let result = runBrowserBridge({ popup, bridgeOrigin: AUTH, oxyServices: oxy, clientId: 'c', redirectUri: APP });
    let state = (await navigated(popup)).searchParams.get('state');
    dispatchMessage({ origin: AUTH, source: popup, data: { type: OXY_BRIDGE_ERROR_MESSAGE_TYPE, error: 'invalid_client', state } });
    expect(await result).toEqual({ ok: false, reason: 'bridge-error' });
    expect(popup.close).toHaveBeenCalled();

    popup = fakePopup();
    result = runBrowserBridge({ popup, bridgeOrigin: AUTH, oxyServices: oxy, clientId: 'c', redirectUri: APP });
    await navigated(popup);
    popup.close();
    expect(await result).toEqual({ ok: false, reason: 'closed' });

    popup = fakePopup();
    result = runBrowserBridge({ popup, bridgeOrigin: AUTH, oxyServices: oxy, clientId: 'c', redirectUri: APP, timeoutMs: 50 });
    state = (await navigated(popup)).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(await result).toEqual({ ok: false, reason: 'timed-out' });
    expect(popup.close).toHaveBeenCalled();
    expect(join).not.toHaveBeenCalled();
  });

  it('a failed join is a failed bridge, never a thrown error', async () => {
    const oxy = new OxyServices({ baseURL: 'http://test.invalid' });
    jest.spyOn(oxy, 'joinBrowserDevice').mockRejectedValue(new Error('invalid_grant'));
    const popup = fakePopup();
    const result = runBrowserBridge({ popup, bridgeOrigin: AUTH, oxyServices: oxy, clientId: 'c', redirectUri: APP });
    const state = (await navigated(popup)).searchParams.get('state');
    dispatchMessage({ origin: AUTH, source: popup, data: { type: OXY_BRIDGE_CODE_MESSAGE_TYPE, code: 'code-1', state } });
    expect(await result).toEqual({ ok: false, reason: 'join-failed' });
  });
});

describe('trackDeviceCredential', () => {
  it('knows the held credential synchronously once the store has been read', async () => {
    let stored: { sessionId: string; userId: string; deviceId?: string; deviceSecret?: string } | null = null;
    const store = trackDeviceCredential({
      load: async () => stored,
      save: async (state) => {
        stored = state;
        return true;
      },
      clear: async () => {
        stored = null;
      },
    });
    expect(store.heldDeviceCredential()).toBeUndefined();
    await store.load();
    expect(store.heldDeviceCredential()).toBeNull();
    await store.save({ sessionId: '', userId: '', deviceId: 'd', deviceSecret: 's' });
    expect(store.heldDeviceCredential()).toEqual({ deviceId: 'd', deviceSecret: 's' });
    await store.clear();
    expect(store.heldDeviceCredential()).toBeNull();
  });
});
