import {
  authRequestCodeFromPush,
  claimAuthRequestCode,
  COMMONS_AUTH_REQUEST_PUSH_TYPE,
} from '@/lib/notifications/auth-request-push';

/**
 * The "Sign in with Oxy" push payload is attacker-influencable. These tests pin
 * the two properties that make tapping one safe:
 *
 *   1. NOTHING but the authorize code is ever extracted — no app name, no
 *      origin, no message — so there is nothing from the payload a screen could
 *      render.
 *   2. Anything that is not a valid Commons approval link produces `null`, and
 *      `null` means the tap is dropped without navigating anywhere.
 */
describe('authRequestCodeFromPush', () => {
  const validPayload = {
    type: COMMONS_AUTH_REQUEST_PUSH_TYPE,
    approvalUrl: 'oxycommons://approve?v=1&code=abc123',
  };

  it('extracts the authorize code from a well-formed payload', () => {
    expect(authRequestCodeFromPush(validPayload)).toBe('abc123');
  });

  it('accepts the alternate app scheme and the universal link', () => {
    expect(
      authRequestCodeFromPush({
        type: COMMONS_AUTH_REQUEST_PUSH_TYPE,
        approvalUrl: 'commons://approve?code=scheme-2',
      }),
    ).toBe('scheme-2');
    expect(
      authRequestCodeFromPush({
        type: COMMONS_AUTH_REQUEST_PUSH_TYPE,
        approvalUrl: 'https://commons.oxy.so/approve?code=universal',
      }),
    ).toBe('universal');
  });

  it('returns ONLY the code — never any other field carried in the payload', () => {
    const result = authRequestCodeFromPush({
      ...validPayload,
      approvalUrl:
        'oxycommons://approve?v=1&code=abc123&app=Evil%20Bank&origin=https%3A%2F%2Fevil.example&title=Approve%20now',
      appName: 'Evil Bank',
      body: 'Tap to approve',
    });

    expect(result).toBe('abc123');
    expect(typeof result).toBe('string');
  });

  it.each([
    ['a foreign scheme', 'evil://approve?code=abc123'],
    ['a look-alike host', 'https://commons.oxy.so.evil.example/approve?code=abc123'],
    ['an http universal link', 'http://commons.oxy.so/approve?code=abc123'],
    ['a different Commons route', 'oxycommons://attest?subject=did:web:oxy.so:u:1'],
    ['a missing code', 'oxycommons://approve?v=1'],
    ['an empty code', 'oxycommons://approve?code='],
    ['a bare string', 'abc123'],
    ['an empty string', ''],
  ])('drops %s', (_label, approvalUrl) => {
    expect(
      authRequestCodeFromPush({ type: COMMONS_AUTH_REQUEST_PUSH_TYPE, approvalUrl }),
    ).toBeNull();
  });

  it('drops an already-expired approval link', () => {
    expect(
      authRequestCodeFromPush({
        type: COMMONS_AUTH_REQUEST_PUSH_TYPE,
        approvalUrl: `oxycommons://approve?code=stale&exp=${Date.now() - 60_000}`,
      }),
    ).toBeNull();
  });

  it.each([
    ['a foreign notification type', { type: 'marketing', approvalUrl: validPayload.approvalUrl }],
    ['a missing type', { approvalUrl: validPayload.approvalUrl }],
    ['a non-string approvalUrl', { type: COMMONS_AUTH_REQUEST_PUSH_TYPE, approvalUrl: 42 }],
    ['a missing approvalUrl', { type: COMMONS_AUTH_REQUEST_PUSH_TYPE }],
  ])('drops %s', (_label, payload) => {
    expect(authRequestCodeFromPush(payload)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'oxycommons://approve?code=abc123'],
    ['a number', 7],
    [
      'an array',
      [{ type: COMMONS_AUTH_REQUEST_PUSH_TYPE, approvalUrl: 'oxycommons://approve?code=x' }],
    ],
  ])('drops a payload that is %s', (_label, payload) => {
    expect(authRequestCodeFromPush(payload)).toBeNull();
  });
});

describe('claimAuthRequestCode', () => {
  it('lets exactly one caller own a code per app session', () => {
    expect(claimAuthRequestCode('single-use-1')).toBe(true);
    expect(claimAuthRequestCode('single-use-1')).toBe(false);
    expect(claimAuthRequestCode('single-use-1')).toBe(false);
  });

  it('tracks codes independently', () => {
    expect(claimAuthRequestCode('single-use-2')).toBe(true);
    expect(claimAuthRequestCode('single-use-3')).toBe(true);
    expect(claimAuthRequestCode('single-use-2')).toBe(false);
  });
});
