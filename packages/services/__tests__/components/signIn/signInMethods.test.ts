import { resolveSignInMethods } from '../../../src/ui/components/signIn/signInMethods';

describe('resolveSignInMethods — one screen, the transport behind each block', () => {
  it('on auth.oxy.so runs the passkey right here, beside the Commons QR', () => {
    expect(resolveSignInMethods({ web: true, host: 'page', commonsAvailability: 'unknown' })).toEqual({
      commons: 'qr',
      passkey: 'here',
    });
  });

  it("in an app's dialog on the web keeps the QR here and opens auth.oxy.so's window only for the passkey", () => {
    expect(resolveSignInMethods({ web: true, host: 'dialog', commonsAvailability: 'unknown' })).toEqual({
      commons: 'qr',
      passkey: 'window',
    });
  });

  it('on native continues with Oxy and offers no passkey', () => {
    expect(resolveSignInMethods({ web: false, host: 'dialog', commonsAvailability: 'available' })).toEqual({
      commons: 'continue',
      passkey: 'none',
    });
  });

  it('on native without Commons leads with getting it', () => {
    expect(resolveSignInMethods({ web: false, host: 'dialog', commonsAvailability: 'unavailable' }).commons).toBe(
      'get-commons',
    );
  });

  it('on native keeps "Continue with Oxy" while the probe has not answered', () => {
    for (const commonsAvailability of ['unknown', 'checking'] as const) {
      expect(resolveSignInMethods({ web: false, host: 'dialog', commonsAvailability }).commons).toBe('continue');
    }
  });
});
