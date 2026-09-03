/**
 * `oauthNavigation` — platform navigation for the third-party OAuth flow.
 *
 * Covers the native `openAuthorizeUrlNative` contract: it returns the deep-link
 * URL the auth session came back to, falls back to `Linking.openURL` when the
 * auth session is unavailable, and never throws out of the sign-in flow even
 * when the fallback itself rejects.
 */

import { Linking } from 'react-native';
import { logger } from '@oxyhq/core';

const mockOpenAuthSessionAsync = jest.fn();
jest.mock(
  'expo-web-browser',
  () => ({ __esModule: true, openAuthSessionAsync: mockOpenAuthSessionAsync }),
  { virtual: true },
);

// eslint-disable-next-line import/first
import { openAuthorizeUrlNative } from '../../src/ui/components/oauthNavigation';

const AUTHORIZE_URL = 'https://auth.oxy.so/authorize?client_id=c&state=s';
const REDIRECT_URI = 'myapp://cb';

describe('openAuthorizeUrlNative', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the redirect URL when the auth session succeeds', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'success', url: 'myapp://cb?code=1&state=s' });
    const openURLSpy = jest.spyOn(Linking, 'openURL');

    const result = await openAuthorizeUrlNative(AUTHORIZE_URL, REDIRECT_URI);

    expect(mockOpenAuthSessionAsync).toHaveBeenCalledWith(AUTHORIZE_URL, REDIRECT_URI);
    expect(result).toEqual({ redirectUrl: 'myapp://cb?code=1&state=s' });
    expect(openURLSpy).not.toHaveBeenCalled();

    openURLSpy.mockRestore();
  });

  it('returns null for a dismissed/cancelled auth session (no fallback)', async () => {
    mockOpenAuthSessionAsync.mockResolvedValue({ type: 'cancel' });
    const openURLSpy = jest.spyOn(Linking, 'openURL');

    const result = await openAuthorizeUrlNative(AUTHORIZE_URL, REDIRECT_URI);

    expect(result).toEqual({ redirectUrl: null });
    expect(openURLSpy).not.toHaveBeenCalled();

    openURLSpy.mockRestore();
  });

  it('falls back to Linking and returns null when the auth session throws', async () => {
    mockOpenAuthSessionAsync.mockRejectedValue(new Error('no browser'));
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    const result = await openAuthorizeUrlNative(AUTHORIZE_URL, REDIRECT_URI);

    expect(openURLSpy).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(result).toEqual({ redirectUrl: null });
    expect(warnSpy).toHaveBeenCalled();

    openURLSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('does not launch an unobservable fallback for explicit consent', async () => {
    mockOpenAuthSessionAsync.mockRejectedValue(new Error('no browser'));
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

    const result = await openAuthorizeUrlNative(AUTHORIZE_URL, REDIRECT_URI, {
      allowExternalFallback: false,
    });

    expect(result).toEqual({ redirectUrl: null });
    expect(openURLSpy).not.toHaveBeenCalled();

    openURLSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('logs and returns null when the Linking fallback rejects (invalid scheme)', async () => {
    mockOpenAuthSessionAsync.mockRejectedValue(new Error('no browser'));
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no activity found'));

    const result = await openAuthorizeUrlNative(AUTHORIZE_URL, REDIRECT_URI);

    expect(result).toEqual({ redirectUrl: null });
    // Two warns: the auth-session failure and the Linking rejection.
    expect(warnSpy).toHaveBeenCalledTimes(2);

    openURLSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
