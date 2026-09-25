import { describe, expect, test } from 'bun:test';
import { buildPostLoginRedirect, postLoginRedirectFrom, withRequestQuery } from '@/lib/auth-utils';

const CODE = '0123456789abcdef0123456789abcdef';

describe('buildPostLoginRedirect', () => {
  test('a device approval code returns to /device with the code, never to /authorize', () => {
    expect(buildPostLoginRedirect({ userCode: CODE })).toBe(`/device?user_code=${CODE}`);
  });

  test('the device hop carries no OAuth parameters, even if some were present', () => {
    const next = buildPostLoginRedirect({
      userCode: CODE,
      redirectUri: 'https://evil.example/cb',
      clientId: 'client-1',
      state: 's',
    });
    expect(next).toBe(`/device?user_code=${CODE}`);
  });

  test('without a device code the OAuth hop is unchanged', () => {
    const next = buildPostLoginRedirect({
      clientId: 'client-1',
      redirectUri: 'https://app.example/cb',
      state: 's',
    });
    const url = new URL(next, 'https://auth.oxy.so');
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('user_code')).toBeNull();
  });

  test('an MCP link intent still takes precedence', () => {
    expect(buildPostLoginRedirect({ mcpLinkIntent: 'i1', userCode: CODE })).toBe(
      '/mcp/link?intent=i1',
    );
  });
});

describe('the request a sign-in continues to, read off the page query', () => {
  const query = new URLSearchParams({
    client_id: 'client-1',
    redirect_uri: 'https://app.example/cb',
    state: 's',
    response_mode: 'web_message',
    login_hint: 'alice',
    error: 'shown once',
  });

  test('carries the request between /login and /signup, and nothing else', () => {
    const url = new URL(withRequestQuery('/signup', query), 'https://auth.oxy.so');
    expect(url.pathname).toBe('/signup');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('response_mode')).toBe('web_message');
    // The page's own one-shot parameters are not part of the request.
    expect(url.searchParams.get('login_hint')).toBeNull();
    expect(url.searchParams.get('error')).toBeNull();
  });

  test('continues to /authorize with the same request', () => {
    const url = new URL(postLoginRedirectFrom(query), 'https://auth.oxy.so');
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/cb');
    expect(url.searchParams.get('response_mode')).toBe('web_message');
  });

  test('a device code on the page still wins', () => {
    expect(postLoginRedirectFrom(new URLSearchParams({ user_code: CODE, client_id: 'c' }))).toBe(
      `/device?user_code=${CODE}`,
    );
  });
});
