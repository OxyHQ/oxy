import { shouldSuppressHttpTrace } from '../telemetryRedaction';

describe('shouldSuppressHttpTrace', () => {
  it.each([
    '/auth/session/status/secret-token',
    '/auth/session/authorize/secret-token',
    '/auth/session/cancel/secret-token',
    '/auth/session/finalize/secret-token',
    '/session/status/secret-token',
  ])('suppresses credential-bearing auth-session path %s', (url) => {
    expect(shouldSuppressHttpTrace(url)).toBe(true);
  });

  it.each([
    '/oauth/callback?code=secret',
    'https://api.oxy.so/users?access_token=secret',
    '/health?',
  ])('suppresses raw query values in %s', (url) => {
    expect(shouldSuppressHttpTrace(url)).toBe(true);
  });

  it.each(['/health', '/auth/session/create', '/users/me', undefined])(
    'keeps non-sensitive target %s observable',
    (url) => {
      expect(shouldSuppressHttpTrace(url)).toBe(false);
    },
  );
});
