/**
 * App assertions (ADR 0045), without Zod. Schemas: `../appAssertions.ts`.
 *
 * An Oxy app proves which app it is by trading platform evidence (the browser's
 * `Origin`, a Play Integrity verdict, an App Attest assertion) for a short-lived
 * `OXY-APP+JWT` signed by Oxy. A service that needs to know the app reads it
 * from {@link OXY_APP_ASSERTION_HEADER} and verifies it against Oxy's JWKS
 * (`verifyAppAssertion` in `@oxy.so/core/server`).
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type {
  AppAssertionChallengeResponse,
  AppAssertionResponse,
  AppAttestKeyResponse,
} from '../appAssertions';
import { datetime, exact, oneOf, optional, pattern, strictObject, string } from './check';

/** How an app proves itself: the browser's origin, Play Integrity, or App Attest. */
export const APP_ASSERTION_PLATFORMS = ['web', 'android', 'ios'] as const;

/**
 * What a device challenge is spent on: an assertion, or (iOS only) registering
 * an App Attest key. A challenge minted for one is refused for the other.
 */
export const APP_ASSERTION_CHALLENGE_PURPOSES = ['assertion', 'attest_key'] as const;

/** The JOSE `typ` of an app assertion. No other Oxy token carries it. */
export const OXY_APP_ASSERTION_TYPE = 'OXY-APP+JWT';

/** The `aud` of every app assertion. */
export const OXY_APP_ASSERTION_AUDIENCE = 'oxy-apps';

/** The request header an app (or an SDK acting for it) sends the assertion in. */
export const OXY_APP_ASSERTION_HEADER = 'X-Oxy-App-Assertion';

/** Oxy signs an app assertion for exactly this long. */
export const OXY_APP_ASSERTION_TTL_SECONDS = 300;

/**
 * Why Oxy refused an app assertion, a challenge or an App Attest key. The API
 * answers `{ error: <code>, message }`.
 *
 * - `application_unavailable`: no active application has that id.
 * - `session_other_application`: the bearer's session belongs to another application.
 * - `platform_not_registered`: the application declares no recognition for that platform.
 * - `origin_not_registered`: the request's `Origin` is not one of the application's web origins.
 * - `challenge_invalid`: the challenge is unknown, used, expired, or minted for something else.
 * - `integrity_refused`: the Play Integrity verdict does not name this app, a registered
 *   certificate, a Play-recognised install and this challenge.
 * - `integrity_unconfigured` / `integrity_unavailable`: Oxy cannot ask Google (503).
 * - `attest_key_unknown`: no App Attest key with that id is registered for the app; attest a new one.
 * - `attest_key_exists`: that App Attest key is already registered.
 * - `attestation_invalid`: the App Attest attestation does not verify.
 * - `assertion_invalid`: the App Attest assertion does not verify, or its counter did not advance.
 * - `signing_unavailable`: Oxy cannot sign (503).
 */
export const APP_ASSERTION_ERROR_CODES = [
  'application_unavailable',
  'session_other_application',
  'platform_not_registered',
  'origin_not_registered',
  'challenge_invalid',
  'integrity_refused',
  'integrity_unconfigured',
  'integrity_unavailable',
  'attest_key_unknown',
  'attest_key_exists',
  'attestation_invalid',
  'assertion_invalid',
  'signing_unavailable',
] as const;

/** 32 random bytes, base64url: a challenge, or the SHA-256 it is bound into. */
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
/** An App Attest key id: the standard base64 of a SHA-256. */
const APP_ATTEST_KEY_ID = /^[A-Za-z0-9+/]{43}=$/;

export const appAssertionChallengeResponseCheck = exact<AppAssertionChallengeResponse>()(
  strictObject({
    challenge: string(pattern(BASE64URL_32)),
    requestHash: string(pattern(BASE64URL_32)),
    expiresAt: string(datetime),
    cloudProjectNumber: optional(string(pattern(/^[0-9]{1,20}$/))),
  }),
);

export const appAttestKeyResponseCheck = exact<AppAttestKeyResponse>()(
  strictObject({ keyId: string(pattern(APP_ATTEST_KEY_ID)) }),
);

export const appAssertionResponseCheck = exact<AppAssertionResponse>()(
  strictObject({
    assertion: string(pattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)),
    applicationId: string(pattern(/^\S{1,255}$/)),
    platform: oneOf(APP_ASSERTION_PLATFORMS),
    expiresAt: string(datetime),
  }),
);
