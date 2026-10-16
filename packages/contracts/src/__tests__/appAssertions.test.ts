import {
  APP_ASSERTION_PLATFORMS,
  OXY_APP_ASSERTION_HEADER,
  appAssertionChallengeRequestSchema,
  appAssertionRequestSchema,
  applicationRecognitionWriteSchema,
  isExactHttpsOrigin,
} from '../index';
import * as client from '../client';

const CHALLENGE = 'A'.repeat(43);
const KEY_ID = `${'B'.repeat(43)}=`;
const CERT = 'ab'.repeat(32);

describe('application recognition (ADR 0045)', () => {
  const declaration = {
    webOrigins: ['https://mention.earth', 'https://app.mention.earth:8443'],
    android: { packageName: 'earth.mention.app', signingCertSha256: [CERT] },
    ios: { teamId: 'ABCDE12345', bundleId: 'earth.mention.app' },
  };

  it('accepts a whole declaration and an empty one', () => {
    expect(applicationRecognitionWriteSchema.parse(declaration)).toEqual(declaration);
    expect(
      applicationRecognitionWriteSchema.parse({ webOrigins: [], android: null, ios: null }),
    ).toEqual({ webOrigins: [], android: null, ios: null });
  });

  it.each([
    'http://mention.earth',
    'https://mention.earth/',
    'https://mention.earth/app',
    'https://Mention.earth',
    'https://mention.earth:443',
    'https://user@mention.earth',
    'mention.earth',
  ])('refuses %s as a web origin', (origin) => {
    expect(isExactHttpsOrigin(origin)).toBe(false);
    expect(
      applicationRecognitionWriteSchema.safeParse({ ...declaration, webOrigins: [origin] }).success,
    ).toBe(false);
  });

  it('refuses duplicate origins and certificates, colon digests and an empty certificate list', () => {
    const parse = (value: unknown) => applicationRecognitionWriteSchema.safeParse(value).success;
    expect(parse({ ...declaration, webOrigins: ['https://a.example', 'https://a.example'] })).toBe(
      false,
    );
    expect(
      parse({ ...declaration, android: { packageName: 'a.b', signingCertSha256: [CERT, CERT] } }),
    ).toBe(false);
    expect(
      parse({
        ...declaration,
        android: { packageName: 'a.b', signingCertSha256: [CERT.match(/../g)?.join(':')] },
      }),
    ).toBe(false);
    expect(parse({ ...declaration, android: { packageName: 'a.b', signingCertSha256: [] } })).toBe(
      false,
    );
    expect(
      parse({ ...declaration, android: { packageName: 'app', signingCertSha256: [CERT] } }),
    ).toBe(false);
    expect(parse({ ...declaration, ios: { teamId: 'abcde12345', bundleId: 'a.b' } })).toBe(false);
  });
});

describe('the exchange (ADR 0045)', () => {
  it('a web request carries no proof; a device request carries its own', () => {
    expect(appAssertionRequestSchema.parse({ applicationId: 'app', platform: 'web' })).toEqual({
      applicationId: 'app',
      platform: 'web',
    });
    expect(
      appAssertionRequestSchema.safeParse({
        applicationId: 'app',
        platform: 'web',
        proof: { challenge: CHALLENGE },
      }).success,
    ).toBe(false);
    expect(
      appAssertionRequestSchema.parse({
        applicationId: 'app',
        platform: 'android',
        proof: { challenge: CHALLENGE, integrityToken: 'token' },
      }).platform,
    ).toBe('android');
    expect(
      appAssertionRequestSchema.parse({
        applicationId: 'app',
        platform: 'ios',
        proof: { challenge: CHALLENGE, keyId: KEY_ID, assertion: 'b21nCg==' },
      }).platform,
    ).toBe('ios');
    expect(
      appAssertionRequestSchema.safeParse({
        applicationId: 'app',
        platform: 'ios',
        proof: { challenge: CHALLENGE, integrityToken: 'token' },
      }).success,
    ).toBe(false);
  });

  it('only iOS registers keys: an Android challenge has no purpose', () => {
    expect(
      appAssertionChallengeRequestSchema.safeParse({
        applicationId: 'app',
        platform: 'ios',
        purpose: 'attest_key',
      }).success,
    ).toBe(true);
    expect(
      appAssertionChallengeRequestSchema.safeParse({
        applicationId: 'app',
        platform: 'android',
        purpose: 'attest_key',
      }).success,
    ).toBe(false);
    expect(
      appAssertionChallengeRequestSchema.safeParse({ applicationId: 'app', platform: 'web' })
        .success,
    ).toBe(false);
  });

  it('the client entry carries the same vocabulary and the header name', () => {
    expect(client.APP_ASSERTION_PLATFORMS).toBe(APP_ASSERTION_PLATFORMS);
    expect(client.OXY_APP_ASSERTION_HEADER).toBe(OXY_APP_ASSERTION_HEADER);
    expect(OXY_APP_ASSERTION_HEADER).toBe('X-Oxy-App-Assertion');
    expect(client.OXY_APP_ASSERTION_TYPE).toBe('OXY-APP+JWT');
    expect(client.OXY_APP_ASSERTION_AUDIENCE).toBe('oxy-apps');
  });
});
