import { resolveSignInMethods } from '../../../src/ui/components/signIn/signInMethods';

describe('resolveSignInMethods — one screen, the transport behind each block', () => {
  it('on an oxy.so origin runs the passkey right here, beside the Commons QR', () => {
    expect(resolveSignInMethods({ web: true, oxyRpOrigin: true, commonsAvailability: 'unknown' })).toEqual({
      commons: 'qr',
      passkey: 'direct',
    });
  });

  it('on any other web origin opens the identity window for the passkey', () => {
    expect(resolveSignInMethods({ web: true, oxyRpOrigin: false, commonsAvailability: 'unknown' })).toEqual({
      commons: 'qr',
      passkey: 'identity-window',
    });
  });

  it('on native continues with Oxy and offers no passkey', () => {
    expect(resolveSignInMethods({ web: false, oxyRpOrigin: false, commonsAvailability: 'available' })).toEqual({
      commons: 'continue',
      passkey: 'none',
    });
  });

  it('on native without Commons leads with getting it', () => {
    expect(resolveSignInMethods({ web: false, oxyRpOrigin: false, commonsAvailability: 'unavailable' }).commons).toBe(
      'get-commons',
    );
  });

  it('on native keeps "Continue with Oxy" while the probe has not answered', () => {
    for (const commonsAvailability of ['unknown', 'checking'] as const) {
      expect(resolveSignInMethods({ web: false, oxyRpOrigin: false, commonsAvailability }).commons).toBe('continue');
    }
  });
});
