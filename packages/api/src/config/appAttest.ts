/**
 * Apple App Attest configuration (ADR 0045).
 *
 * There is no secret: the trust anchor is Apple's public App Attestation Root
 * CA, pinned here, and each app's team id and bundle id live in the registry
 * (`application_recognition`). The one setting is which App Attest environment
 * a key may come from.
 *
 * - `APP_ATTEST_ENVIRONMENTS`: comma-separated, `production` (the default) and/or
 *   `development`. A development key is one an app built from Xcode with the
 *   development entitlement attests; accept it only where such builds should be
 *   recognised.
 */

import { X509Certificate } from 'node:crypto';
import { APP_ATTEST_ENVIRONMENTS, type AppAttestEnvironment } from '../db/schema/appAttestKeys';

export const APP_ATTEST_ENVIRONMENTS_VARIABLE = 'APP_ATTEST_ENVIRONMENTS';

/**
 * Apple App Attestation Root CA, from
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * (valid 2020-03-18 to 2045-03-15; SHA-256 fingerprint
 * 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32).
 */
export const APPLE_APP_ATTESTATION_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;

let root: X509Certificate | undefined;

export function appleAppAttestationRootCertificate(): X509Certificate {
  root ??= new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM);
  return root;
}

/** The environments an App Attest key may come from. Throws on a value it does not know. */
export function appAttestAllowedEnvironments(): readonly AppAttestEnvironment[] {
  const configured = process.env[APP_ATTEST_ENVIRONMENTS_VARIABLE]?.trim();
  if (!configured) return ['production'];
  const names = configured.split(',').map((name) => name.trim());
  for (const name of names) {
    if (!(APP_ATTEST_ENVIRONMENTS as readonly string[]).includes(name)) {
      throw new Error(
        `${APP_ATTEST_ENVIRONMENTS_VARIABLE} must list production and/or development, not ${name}`,
      );
    }
  }
  return names as AppAttestEnvironment[];
}
