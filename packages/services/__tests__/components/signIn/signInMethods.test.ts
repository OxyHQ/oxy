/**
 * `resolveSignInMethods` — which Commons way in a surface offers. Every surface
 * also takes an email or username; that part does not depend on the platform.
 */

import { resolveSignInMethods } from '../../../src/ui/components/signIn/signInMethods';

describe('resolveSignInMethods', () => {
  it('on the web: the embedded QR (with "Continue with Oxy" below `md`)', () => {
    expect(resolveSignInMethods({ web: true, commonsAvailability: 'unknown' })).toEqual({ commons: 'qr' });
    expect(resolveSignInMethods({ web: true, commonsAvailability: 'unavailable' })).toEqual({ commons: 'qr' });
  });

  it('on native: "Continue with Oxy", or "Get Commons" without Commons', () => {
    expect(resolveSignInMethods({ web: false, commonsAvailability: 'available' })).toEqual({ commons: 'continue' });
    expect(resolveSignInMethods({ web: false, commonsAvailability: 'unknown' })).toEqual({ commons: 'continue' });
    expect(resolveSignInMethods({ web: false, commonsAvailability: 'unavailable' })).toEqual({ commons: 'get-commons' });
  });
});
