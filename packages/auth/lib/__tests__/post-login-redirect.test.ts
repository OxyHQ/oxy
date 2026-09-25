import { describe, expect, test } from 'bun:test';
import { buildPostLoginRedirect } from '@/lib/auth-utils';

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
