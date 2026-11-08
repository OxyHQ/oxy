import {
  APP_ASSERTION_PLATFORMS,
  DEVICE_APP_TOKEN_TTL_SECONDS,
  PLATFORM_HOSTS,
  appAssertionRequestSchema,
  applicationRecognitionSchema,
  applicationRecognitionWriteSchema,
  deviceAppTokenRequestSchema,
  devicePlatformRequestSchema,
  hostTokenClaimSchema,
  passwordSignInRequestSchema,
  platformClientSchema,
  secondFactorSignInRequestSchema,
} from '../index';
import * as client from '../client';

const proof = { deviceId: 'dev-1', deviceSecret: 's'.repeat(43) };

describe('a platform that holds the session (ADR 0058)', () => {
  it('names the two platforms and a five-minute token, the same in both entries', () => {
    expect(PLATFORM_HOSTS).toEqual(['oxyos', 'astro']);
    expect(client.PLATFORM_HOSTS).toBe(PLATFORM_HOSTS);
    expect(DEVICE_APP_TOKEN_TTL_SECONDS).toBe(300);
    expect(APP_ASSERTION_PLATFORMS).toEqual(['web', 'android', 'ios', 'oxyos', 'astro']);
  });

  it('takes the three attestations, and nothing else', () => {
    const parse = (attestation: unknown) =>
      deviceAppTokenRequestSchema.safeParse({ ...proof, attestation }).success;
    expect(parse({ platform: 'oxyos', desktopEntryId: 'so.oxy.dropsea' })).toBe(true);
    expect(parse({ platform: 'oxyos', self: true })).toBe(true);
    expect(parse({ platform: 'astro', self: true })).toBe(true);
    expect(
      parse({ platform: 'astro', origin: 'https://mention.earth', clientId: 'oxy_dk_1' }),
    ).toBe(true);

    expect(parse({ platform: 'oxyos', self: false })).toBe(false);
    expect(parse({ platform: 'oxyos', desktopEntryId: 'So.Oxy.Dropsea' })).toBe(false);
    expect(parse({ platform: 'oxyos', desktopEntryId: 'dropsea' })).toBe(false);
    expect(parse({ platform: 'astro', desktopEntryId: 'so.oxy.dropsea' })).toBe(false);
    expect(parse({ platform: 'astro', origin: 'https://mention.earth/' })).toBe(false);
    expect(parse({ platform: 'oxyos', origin: 'https://mention.earth', clientId: 'x' })).toBe(
      false,
    );
    expect(parse({ platform: 'web', self: true })).toBe(false);
    expect(parse({ platform: 'oxyos', desktopEntryId: 'so.oxy.dropsea', pid: 42 })).toBe(false);
  });

  it('pins an account and names a client only optionally, and refuses unknown fields', () => {
    const attestation = { platform: 'oxyos', desktopEntryId: 'so.oxy.allo' };
    expect(
      deviceAppTokenRequestSchema.safeParse({
        ...proof,
        attestation,
        accountId: 'acc-1',
        clientId: 'oxy_dk_1',
      }).success,
    ).toBe(true);
    expect(
      deviceAppTokenRequestSchema.safeParse({ ...proof, attestation, scope: 'x' }).success,
    ).toBe(false);
    expect(deviceAppTokenRequestSchema.safeParse({ attestation }).success).toBe(false);
  });

  it('lets the password and second-factor sign-ins name a platform client', () => {
    const platformClient = { platform: 'oxyos', clientId: 'oxy_dk_os' };
    expect(
      passwordSignInRequestSchema.safeParse({
        identifier: 'nate',
        password: 'pw',
        device: proof,
        platformClient,
      }).success,
    ).toBe(true);
    expect(
      secondFactorSignInRequestSchema.safeParse({
        challengeId: 'A'.repeat(43),
        code: '123456',
        platformClient,
      }).success,
    ).toBe(true);
    expect(platformClientSchema.safeParse({ platform: 'web', clientId: 'x' }).success).toBe(false);
    expect(platformClientSchema.safeParse({ platform: 'oxyos', clientId: '' }).success).toBe(false);
  });

  it('redeems a QR proof with an optional redemption key of 256 bits or more (R7)', () => {
    const platformClient = { platform: 'oxyos', clientId: 'oxy_dk_os' };
    const parse = (extra: Record<string, unknown>) =>
      devicePlatformRequestSchema.safeParse({ device: proof, platformClient, ...extra }).success;
    expect(parse({})).toBe(true);
    expect(parse({ redemptionKey: 'k'.repeat(43) })).toBe(true);
    expect(parse({ redemptionKey: 'A-_9'.repeat(32) })).toBe(true);
    expect(parse({ redemptionKey: 'k'.repeat(42) })).toBe(false);
    expect(parse({ redemptionKey: 'k'.repeat(129) })).toBe(false);
    expect(parse({ redemptionKey: `${'k'.repeat(42)}=` })).toBe(false);
    expect(parse({ redemptionKey: `${'k'.repeat(42)}+` })).toBe(false);
    expect(parse({ redemptionKey: null })).toBe(false);
    expect(parse({ key: 'k'.repeat(43) })).toBe(false);
  });

  it('declares a platform host and OxyOS desktop entry ids on the registry, both optional to write', () => {
    const base = { webOrigins: [], android: null, ios: null };
    expect(applicationRecognitionWriteSchema.parse(base)).toEqual(base);
    expect(
      applicationRecognitionWriteSchema.parse({
        ...base,
        platformHost: 'oxyos',
        oxyosDesktopEntryIds: ['so.oxy.inbox'],
      }),
    ).toEqual({ ...base, platformHost: 'oxyos', oxyosDesktopEntryIds: ['so.oxy.inbox'] });
    expect(
      applicationRecognitionWriteSchema.safeParse({
        ...base,
        oxyosDesktopEntryIds: ['so.oxy.inbox', 'so.oxy.inbox'],
      }).success,
    ).toBe(false);
    expect(
      applicationRecognitionWriteSchema.safeParse({ ...base, platformHost: 'android' }).success,
    ).toBe(false);
    // The read always says both.
    expect(
      applicationRecognitionSchema.safeParse({
        ...base,
        applicationId: 'app-1',
        updatedAt: null,
      }).success,
    ).toBe(false);
    expect(
      applicationRecognitionSchema.safeParse({
        ...base,
        applicationId: 'app-1',
        platformHost: null,
        oxyosDesktopEntryIds: [],
        updatedAt: null,
      }).success,
    ).toBe(true);
  });

  it('asks an oxyos or astro assertion with no proof, and nothing more', () => {
    expect(
      appAssertionRequestSchema.safeParse({ applicationId: 'app-1', platform: 'oxyos' }).success,
    ).toBe(true);
    expect(
      appAssertionRequestSchema.safeParse({
        applicationId: 'app-1',
        platform: 'oxyos',
        proof: { challenge: 'A'.repeat(43) },
      }).success,
    ).toBe(false);
  });

  it('carries the platform and its credential id in the host claim', () => {
    expect(hostTokenClaimSchema.safeParse({ platform: 'oxyos', credential: 'c-1' }).success).toBe(
      true,
    );
    expect(hostTokenClaimSchema.safeParse({ platform: 'oxyos' }).success).toBe(false);
  });
});
