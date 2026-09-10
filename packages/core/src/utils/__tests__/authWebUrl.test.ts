/**
 * Central IdP apex constant.
 *
 * `resolveCentralAuthUrl` + `CENTRAL_AUTH_URL` were removed in the device-first /
 * legacy-final cutovers. `CENTRAL_IDP_APEX` survives because live server-side
 * callers (the `@oxy.so/core/server` CORS helper + the IdP worker) import it.
 */

import { CENTRAL_IDP_APEX } from '../authWebUrl';

describe('CENTRAL_IDP_APEX', () => {
  it('is the central IdP registrable apex', () => {
    expect(CENTRAL_IDP_APEX).toBe('oxy.so');
  });
});
