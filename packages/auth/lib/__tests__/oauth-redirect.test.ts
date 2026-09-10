import { describe, expect, test } from 'bun:test';
import { safeMcpRedirectUrl, safeRedirectUrl } from '@/lib/oauth-redirect';

describe('safeRedirectUrl', () => {
  test('accepts https origins without trailing slash noise', () => {
    expect(safeRedirectUrl('https://accounts.oxy.so/')).toBe('https://accounts.oxy.so');
    expect(safeRedirectUrl('https://accounts.oxy.so')).toBe('https://accounts.oxy.so');
  });

  test('preserves path and query on https redirects', () => {
    expect(safeRedirectUrl('https://inbox.oxy.so/callback?x=1')).toBe(
      'https://inbox.oxy.so/callback?x=1',
    );
  });

  test('rejects raw IP hosts', () => {
    expect(safeRedirectUrl('https://127.0.0.1/callback')).toBeNull();
  });

  test('rejects unknown schemes', () => {
    expect(safeRedirectUrl('javascript:alert(1)')).toBeNull();
  });

  test('allows registered native schemes', () => {
    expect(safeRedirectUrl('astro://oauth/callback')).toBe('astro://oauth/callback');
  });
});

describe('safeMcpRedirectUrl', () => {
  test('accepts HTTPS and HTTP loopback redirects', () => {
    expect(safeMcpRedirectUrl('https://client.example/callback')).toBe('https://client.example/callback');
    expect(safeMcpRedirectUrl('https://client.example/')).toBe('https://client.example/');
    expect(safeMcpRedirectUrl('http://127.0.0.1:43123/callback')).toBe('http://127.0.0.1:43123/callback');
    expect(safeMcpRedirectUrl('http://localhost:43123/callback')).toBe('http://localhost:43123/callback');
  });

  test('rejects insecure remote, credentialed and fragment redirects', () => {
    expect(safeMcpRedirectUrl('http://client.example/callback')).toBeNull();
    expect(safeMcpRedirectUrl('https://user:pass@client.example/callback')).toBeNull();
    expect(safeMcpRedirectUrl('https://client.example/callback#token')).toBeNull();
  });
});
