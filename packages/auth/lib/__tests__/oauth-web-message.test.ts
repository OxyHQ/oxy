import { describe, expect, test } from 'bun:test';
import {
  OAUTH_CODE_MESSAGE_TYPE,
  OAUTH_ERROR_MESSAGE_TYPE,
  WEB_MESSAGE_RESPONSE_MODE,
  buildOAuthRedirectUrl,
  buildRelayMessage,
  deliverOAuthResult,
  resolveWebMessageTarget,
  webMessageTargetOrigin,
  type OAuthRelayMessage,
  type OAuthResult,
} from '@/lib/oauth-web-message';

const REDIRECT_URI = 'https://inbox.oxy.so/oauth/callback';
const REDIRECT_ORIGIN = 'https://inbox.oxy.so';
const CODE = 'authorization-code-abc123';
const STATE = 'opaque-state-xyz';

type PostedMessage = { message: OAuthRelayMessage; targetOrigin: string };

/**
 * A fake `window` implementing only the surface `deliverOAuthResult` touches,
 * recording the call order so "closed AFTER posting" is assertable.
 */
class FakeWindow {
  opener: unknown = null;
  location = { href: '' };
  closed = false;
  closeCalls = 0;
  posted: PostedMessage[] = [];
  calls: string[] = [];

  /** An opener whose `postMessage` records into this window's log. */
  openerWindow(): { postMessage: (m: OAuthRelayMessage, o: string) => void } {
    return {
      postMessage: (message: OAuthRelayMessage, targetOrigin: string) => {
        this.posted.push({ message, targetOrigin });
        this.calls.push('postMessage');
      },
    };
  }

  close(): void {
    this.closed = true;
    this.closeCalls += 1;
    this.calls.push('close');
  }
}

function windowWithOpener(): FakeWindow {
  const win = new FakeWindow();
  win.opener = win.openerWindow();
  return win;
}

const codeResult: OAuthResult = { kind: 'code', code: CODE, state: STATE };
const denyResult: OAuthResult = {
  kind: 'error',
  error: 'access_denied',
  state: STATE,
};

/** Every key appearing anywhere in a (possibly nested) posted payload. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

describe('webMessageTargetOrigin', () => {
  test('is the exact origin of the validated redirect URI', () => {
    expect(webMessageTargetOrigin(REDIRECT_URI)).toBe(REDIRECT_ORIGIN);
    expect(webMessageTargetOrigin('https://inbox.oxy.so/deep/path?x=1#y')).toBe(REDIRECT_ORIGIN);
  });

  test('keeps the port as part of the origin', () => {
    expect(webMessageTargetOrigin('http://localhost:8081/callback')).toBe('http://localhost:8081');
    expect(webMessageTargetOrigin('https://inbox.oxy.so:8443/cb')).toBe(
      'https://inbox.oxy.so:8443',
    );
  });

  test('never widens to a wildcard or a parent domain', () => {
    const origin = webMessageTargetOrigin('https://a.b.inbox.oxy.so/cb');
    expect(origin).toBe('https://a.b.inbox.oxy.so');
    expect(origin).not.toBe('*');
    expect(origin).not.toBe(REDIRECT_ORIGIN);
  });

  test('rejects redirect targets with no web origin', () => {
    // Native schemes serialize to the opaque `null` origin — they can never be
    // a postMessage target, so those requests must fall back to the redirect.
    expect(webMessageTargetOrigin('astro://oauth/callback')).toBeNull();
    expect(webMessageTargetOrigin('not a url')).toBeNull();
  });
});

describe('resolveWebMessageTarget', () => {
  test('requires BOTH response_mode=web_message and a real opener', () => {
    const win = windowWithOpener();
    expect(
      resolveWebMessageTarget({
        responseMode: WEB_MESSAGE_RESPONSE_MODE,
        safeRedirectUri: REDIRECT_URI,
        window: win,
      }),
    ).not.toBeNull();

    // response_mode missing / not web_message
    for (const responseMode of [null, '', 'query', 'fragment', 'form_post']) {
      expect(
        resolveWebMessageTarget({
          responseMode,
          safeRedirectUri: REDIRECT_URI,
          window: windowWithOpener(),
        }),
      ).toBeNull();
    }

    // no opener
    expect(
      resolveWebMessageTarget({
        responseMode: WEB_MESSAGE_RESPONSE_MODE,
        safeRedirectUri: REDIRECT_URI,
        window: new FakeWindow(),
      }),
    ).toBeNull();
  });

  test('rejects an opener that is this window itself', () => {
    const win = new FakeWindow();
    win.opener = win;
    expect(
      resolveWebMessageTarget({
        responseMode: WEB_MESSAGE_RESPONSE_MODE,
        safeRedirectUri: REDIRECT_URI,
        window: win,
      }),
    ).toBeNull();
  });

  test('rejects an opener that cannot receive messages', () => {
    const win = new FakeWindow();
    win.opener = { name: 'not-a-window' };
    expect(
      resolveWebMessageTarget({
        responseMode: WEB_MESSAGE_RESPONSE_MODE,
        safeRedirectUri: REDIRECT_URI,
        window: win,
      }),
    ).toBeNull();
  });

  test('resolves the target origin from the redirect URI, not the opener', () => {
    const win = windowWithOpener();
    const resolved = resolveWebMessageTarget({
      responseMode: WEB_MESSAGE_RESPONSE_MODE,
      safeRedirectUri: REDIRECT_URI,
      window: win,
    });
    expect(resolved?.targetOrigin).toBe(REDIRECT_ORIGIN);
  });
});

describe('buildRelayMessage', () => {
  test('code messages carry only type + code + state', () => {
    const message = buildRelayMessage(codeResult);
    expect(message).toEqual({
      type: OAUTH_CODE_MESSAGE_TYPE,
      code: CODE,
      state: STATE,
    });
    expect(Object.keys(message).sort()).toEqual(['code', 'state', 'type']);
  });

  test("a missing state still produces the contract's string field", () => {
    const message = buildRelayMessage({ kind: 'code', code: CODE, state: null });
    expect(message).toEqual({
      type: OAUTH_CODE_MESSAGE_TYPE,
      code: CODE,
      state: '',
    });
  });

  test('error messages carry only type + error (+ optional state/description)', () => {
    expect(buildRelayMessage(denyResult)).toEqual({
      type: OAUTH_ERROR_MESSAGE_TYPE,
      error: 'access_denied',
      state: STATE,
    });
    expect(buildRelayMessage({ kind: 'error', error: 'server_error', state: null })).toEqual({
      type: OAUTH_ERROR_MESSAGE_TYPE,
      error: 'server_error',
    });
    expect(
      buildRelayMessage({
        kind: 'error',
        error: 'invalid_request',
        errorDescription: 'redirect_uri mismatch',
        state: STATE,
      }),
    ).toEqual({
      type: OAUTH_ERROR_MESSAGE_TYPE,
      error: 'invalid_request',
      errorDescription: 'redirect_uri mismatch',
      state: STATE,
    });
  });
});

describe('deliverOAuthResult — web message transport', () => {
  test("posts the code to the opener at the redirect URI's exact origin", () => {
    const win = windowWithOpener();
    const delivery = deliverOAuthResult({
      result: codeResult,
      safeRedirectUri: REDIRECT_URI,
      responseMode: WEB_MESSAGE_RESPONSE_MODE,
      window: win,
    });

    expect(delivery.mode).toBe('web_message');
    expect(win.posted).toHaveLength(1);
    expect(win.posted[0].targetOrigin).toBe(REDIRECT_ORIGIN);
    expect(win.posted[0].targetOrigin).not.toBe('*');
    expect(win.posted[0].message).toEqual({
      type: OAUTH_CODE_MESSAGE_TYPE,
      code: CODE,
      state: STATE,
    });
    // The window is NOT navigated in popup mode.
    expect(win.location.href).toBe('');
  });

  test('closes the window AFTER posting', () => {
    const win = windowWithOpener();
    deliverOAuthResult({
      result: codeResult,
      safeRedirectUri: REDIRECT_URI,
      responseMode: WEB_MESSAGE_RESPONSE_MODE,
      window: win,
    });

    expect(win.calls).toEqual(['postMessage', 'close']);
    expect(win.closed).toBe(true);
    expect(win.closeCalls).toBe(1);
  });

  test('a refused close still reports a completed delivery', () => {
    const win = windowWithOpener();
    win.close = () => {
      throw new Error('Scripts may close only the windows that were opened by them');
    };

    const delivery = deliverOAuthResult({
      result: codeResult,
      safeRedirectUri: REDIRECT_URI,
      responseMode: WEB_MESSAGE_RESPONSE_MODE,
      window: win,
    });

    expect(delivery.mode).toBe('web_message');
    expect(win.posted).toHaveLength(1);
  });

  test('the payload leaks nothing but the code, the state and the type', () => {
    const win = windowWithOpener();
    deliverOAuthResult({
      result: codeResult,
      safeRedirectUri: REDIRECT_URI,
      responseMode: WEB_MESSAGE_RESPONSE_MODE,
      window: win,
    });

    const message = win.posted[0].message;
    expect([...collectKeys(message)].sort()).toEqual(['code', 'state', 'type']);

    // No token / session / device / user material may ever cross the window
    // boundary, in any casing or nesting.
    const serialized = JSON.stringify(message).toLowerCase();
    for (const forbidden of [
      'token',
      'accesstoken',
      'refresh',
      'session',
      'device',
      'secret',
      'user',
      'email',
      'password',
      'bearer',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // Every value is a plain string — no objects smuggled through.
    for (const value of Object.values(message)) {
      expect(typeof value).toBe('string');
    }
  });

  test('deny relays access_denied instead of redirecting', () => {
    const win = windowWithOpener();
    const delivery = deliverOAuthResult({
      result: denyResult,
      safeRedirectUri: REDIRECT_URI,
      responseMode: WEB_MESSAGE_RESPONSE_MODE,
      window: win,
    });

    expect(delivery.mode).toBe('web_message');
    expect(win.posted[0].targetOrigin).toBe(REDIRECT_ORIGIN);
    expect(win.posted[0].message).toEqual({
      type: OAUTH_ERROR_MESSAGE_TYPE,
      error: 'access_denied',
      state: STATE,
    });
    expect(win.location.href).toBe('');
    expect(win.closed).toBe(true);
  });
});

describe('deliverOAuthResult — redirect fallback', () => {
  test('no opener falls back to the redirect', () => {
    const win = new FakeWindow();
    const delivery = deliverOAuthResult({
      result: codeResult,
      safeRedirectUri: REDIRECT_URI,
      responseMode: WEB_MESSAGE_RESPONSE_MODE,
      window: win,
    });

    expect(delivery.mode).toBe('redirect');
    expect(win.posted).toHaveLength(0);
    expect(win.closed).toBe(false);
    expect(win.location.href).toBe(`${REDIRECT_URI}?code=${CODE}&state=${STATE}`);
  });

  test('no response_mode falls back to the redirect even with an opener', () => {
    const win = windowWithOpener();
    const delivery = deliverOAuthResult({
      result: codeResult,
      safeRedirectUri: REDIRECT_URI,
      responseMode: null,
      window: win,
    });

    expect(delivery.mode).toBe('redirect');
    expect(win.posted).toHaveLength(0);
    expect(win.closed).toBe(false);
    expect(win.location.href).toBe(`${REDIRECT_URI}?code=${CODE}&state=${STATE}`);
  });

  test('a redirect target with no web origin falls back to the redirect', () => {
    const win = windowWithOpener();
    const delivery = deliverOAuthResult({
      result: codeResult,
      safeRedirectUri: 'astro://oauth/callback',
      responseMode: WEB_MESSAGE_RESPONSE_MODE,
      window: win,
    });

    expect(delivery.mode).toBe('redirect');
    expect(win.posted).toHaveLength(0);
    expect(win.location.href).toBe(`astro://oauth/callback?code=${CODE}&state=${STATE}`);
  });

  test('deny falls back to ?error=access_denied', () => {
    const win = new FakeWindow();
    deliverOAuthResult({
      result: denyResult,
      safeRedirectUri: REDIRECT_URI,
      responseMode: null,
      window: win,
    });

    expect(win.location.href).toBe(`${REDIRECT_URI}?error=access_denied&state=${STATE}`);
  });

  test('preserves query params already on the redirect URI', () => {
    expect(buildOAuthRedirectUrl(codeResult, 'https://inbox.oxy.so/cb?from=app')).toBe(
      `https://inbox.oxy.so/cb?from=app&code=${CODE}&state=${STATE}`,
    );
  });

  test('omits state when the request carried none', () => {
    expect(buildOAuthRedirectUrl({ kind: 'code', code: CODE, state: null }, REDIRECT_URI)).toBe(
      `${REDIRECT_URI}?code=${CODE}`,
    );
  });
});
