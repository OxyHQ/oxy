/**
 * `resolveSignInMethods` — which Commons way in a surface offers, from the
 * device it runs on. Every surface also takes an email or username; that part
 * does not depend on the device.
 */

import { resolveSignInMethods } from '../../../src/ui/components/signIn/signInMethods';

describe('resolveSignInMethods', () => {
  it('in a browser: the embedded QR (with "Continue with Oxy" below `md`)', () => {
    expect(resolveSignInMethods({ device: 'browser', commonsAvailability: 'unknown' })).toEqual({
      commons: 'qr',
    });
    expect(resolveSignInMethods({ device: 'browser', commonsAvailability: 'unavailable' })).toEqual(
      { commons: 'qr' },
    );
  });

  it('on a computer (OxyOS, macOS): the embedded QR a phone scans, as in a browser', () => {
    expect(resolveSignInMethods({ device: 'computer', commonsAvailability: 'unknown' })).toEqual({
      commons: 'qr',
    });
    // A computer is never asked whether Commons is installed; whatever the
    // controller holds, the QR stays.
    expect(
      resolveSignInMethods({ device: 'computer', commonsAvailability: 'unavailable' }),
    ).toEqual({ commons: 'qr' });
  });

  it('on a phone: "Continue with Oxy", or "Get Commons" without Commons', () => {
    expect(resolveSignInMethods({ device: 'phone', commonsAvailability: 'available' })).toEqual({
      commons: 'continue',
    });
    expect(resolveSignInMethods({ device: 'phone', commonsAvailability: 'unknown' })).toEqual({
      commons: 'continue',
    });
    expect(resolveSignInMethods({ device: 'phone', commonsAvailability: 'unavailable' })).toEqual({
      commons: 'get-commons',
    });
  });
});
