import { describe, expect, test, jest, beforeEach } from '@jest/globals';
import { tryCompleteOAuthReturn, replaceUrlAfterOAuthReturn } from '../../src/ui/utils/oauthReturn';
import {
  OXY_OAUTH_RETURN_PATH_STORAGE_KEY,
  persistOAuthHandshake,
  persistOAuthReturnPath,
} from '@oxyhq/core';

describe('tryCompleteOAuthReturn', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/?error=access_denied&state=abc');
  });

  test('strips OAuth error params from the URL without exchanging', async () => {
    persistOAuthHandshake('state-abc', 'verifier-abc');
    const replaceState = jest
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);
    const commitSession = jest.fn();

    const result = await tryCompleteOAuthReturn({
      oxyServices: {} as never,
      clientId: 'oxy_dk_test',
      commitSession,
    });

    expect(result).toBe(false);
    expect(commitSession).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalled();
    const cleanedUrl = String(replaceState.mock.calls[0]?.[2] ?? '');
    expect(cleanedUrl).not.toContain('error=');
    expect(cleanedUrl).not.toContain('state=');
    expect(window.sessionStorage.getItem('oxy_oauth_state')).toBeNull();
    replaceState.mockRestore();
  });

  /**
   * This is the ONLY cleanup path for an OAuth error landing on the URL now that
   * `consumeSilentOAuthError` is gone (#691 phase 7b). A tab that was mid-flight
   * through the deleted silent restore when the new bundle shipped comes back
   * with `?error=login_required` — it must still be stripped, and the visitor
   * must still land on the page they started on rather than the bare origin the
   * IdP redirected to.
   */
  test('returns the visitor to the page they started on after a login_required landing', async () => {
    window.history.replaceState(null, '', '/?error=login_required&state=abc');
    persistOAuthReturnPath('/pricing');
    persistOAuthHandshake('state-abc', 'verifier-abc');

    const replaceState = jest
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);

    const result = await tryCompleteOAuthReturn({
      oxyServices: {} as never,
      clientId: 'oxy_dk_test',
      commitSession: jest.fn(),
    });

    expect(result).toBe(false);
    expect(String(replaceState.mock.calls[0]?.[2] ?? '')).toBe('/pricing');
    expect(window.sessionStorage.getItem('oxy_oauth_state')).toBeNull();
    replaceState.mockRestore();
  });
});

/**
 * The regression this guards: `redirect_uri` is a registered apex origin, so the
 * IdP always returns the tab to `/`. Before the return path was persisted, every
 * deep link — a shared URL, a search result — silently became the home page for
 * signed-out visitors on their first navigation in a tab.
 */
describe('deep-link preservation across the authorize round trip', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/?error=access_denied&state=abc');
  });

  test('returns the visitor to the page they started on, not the origin', async () => {
    // The tab was on /company/team before being bounced to the IdP.
    persistOAuthReturnPath('/company/team?tab=eng');

    const replaceState = jest
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);

    await tryCompleteOAuthReturn({
      oxyServices: {} as never,
      clientId: 'oxy_dk_test',
      commitSession: jest.fn(),
    });

    expect(String(replaceState.mock.calls[0]?.[2] ?? '')).toBe('/company/team?tab=eng');
    replaceState.mockRestore();
  });

  test('falls back to the cleaned current URL when no path was recorded', async () => {
    const replaceState = jest
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);

    await tryCompleteOAuthReturn({
      oxyServices: {} as never,
      clientId: 'oxy_dk_test',
      commitSession: jest.fn(),
    });

    const url = String(replaceState.mock.calls[0]?.[2] ?? '');
    expect(url).toBe('/');
    replaceState.mockRestore();
  });

  test('ignores a hostile stored path instead of leaving the origin', async () => {
    window.sessionStorage.setItem(OXY_OAUTH_RETURN_PATH_STORAGE_KEY, '//evil.com');

    const replaceState = jest
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);

    await tryCompleteOAuthReturn({
      oxyServices: {} as never,
      clientId: 'oxy_dk_test',
      commitSession: jest.fn(),
    });

    expect(String(replaceState.mock.calls[0]?.[2] ?? '')).toBe('/');
    replaceState.mockRestore();
  });

  test('restores the deep link on a successful code exchange', async () => {
    window.sessionStorage.clear();
    persistOAuthHandshake('state-xyz', 'verifier-abc');
    persistOAuthReturnPath('/newsroom');
    window.history.replaceState(null, '', '/?code=auth-code&state=state-xyz');

    const replaceState = jest
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);
    const commitSession = jest.fn().mockResolvedValue(undefined);
    const exchangeOAuthCode = jest.fn().mockResolvedValue({
      sessionId: 'sess-1',
      accessToken: 'token',
      deviceId: 'dev-1',
      deviceSecret: 'secret',
      user: { id: 'user-1' },
    });

    const result = await tryCompleteOAuthReturn({
      oxyServices: { exchangeOAuthCode } as never,
      clientId: 'oxy_dk_test',
      commitSession,
    });

    expect(result).toBe(true);
    expect(exchangeOAuthCode).toHaveBeenCalled();
    expect(commitSession).toHaveBeenCalled();
    expect(String(replaceState.mock.calls[0]?.[2] ?? '')).toBe('/newsroom');
    replaceState.mockRestore();
  });

  test('replays the exact path-qualified redirect_uri stored in the handshake', async () => {
    window.sessionStorage.clear();
    const redirectUri = 'https://app.example/oauth/callback';
    persistOAuthHandshake('state-xyz', 'verifier-abc', redirectUri);
    persistOAuthReturnPath('/newsroom');
    window.history.replaceState(null, '', '/oauth/callback?code=auth-code&state=state-xyz');

    const replaceState = jest
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);
    const commitSession = jest.fn().mockResolvedValue(undefined);
    const exchangeOAuthCode = jest.fn().mockResolvedValue({
      sessionId: 'sess-1',
      accessToken: 'token',
      deviceId: 'dev-1',
      deviceSecret: 'secret',
      user: { id: 'user-1' },
    });

    const result = await tryCompleteOAuthReturn({
      oxyServices: { exchangeOAuthCode } as never,
      clientId: 'oxy_dk_test',
      commitSession,
    });

    expect(result).toBe(true);
    expect(exchangeOAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri }),
    );
    replaceState.mockRestore();
  });
});

/**
 * `history.replaceState` fires no event. Cold boot runs inside the mounted app,
 * so the router has already rendered the route for the URL the IdP landed on —
 * without a `popstate` the address bar shows the deep link while the page still
 * shows the home page.
 */
describe('router notification after restoring the URL', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  test('dispatches popstate so a history router re-reads location', () => {
    persistOAuthReturnPath('/newsroom');
    const seen: string[] = [];
    const onPopState = () => seen.push('popstate');
    window.addEventListener('popstate', onPopState);

    replaceUrlAfterOAuthReturn('/');

    expect(seen).toEqual(['popstate']);
    window.removeEventListener('popstate', onPopState);
  });

  test('stays silent when the URL did not actually change', () => {
    const seen: string[] = [];
    const onPopState = () => seen.push('popstate');
    window.addEventListener('popstate', onPopState);

    replaceUrlAfterOAuthReturn('/');

    expect(seen).toEqual([]);
    window.removeEventListener('popstate', onPopState);
  });
});
