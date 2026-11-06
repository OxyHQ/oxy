/**
 * A platform that holds the Oxy session (ADR 0058), without Zod. Schemas:
 * `../platformSession.ts`.
 *
 * OxyOS and Astro hold the person's Oxy session themselves, on a PLATFORM
 * CREDENTIAL, and ask Oxy for a short token named for each application they
 * run (`POST /session/device/app-token`). Applications hold no credential.
 *
 * Part of `@oxy.so/contracts/client`: never import `zod` here (see `./check.ts`).
 */

import type { DeviceAppTokenResponse } from '../platformSession';
import { datetime, exact, minLength, object, string } from './check';

/** The platforms that hold the Oxy session for the applications they run. */
export const PLATFORM_HOSTS = ['oxyos', 'astro'] as const;

/**
 * An OxyOS desktop entry id (`so.oxy.dropsea`): the reverse-DNS id OxyOS names
 * an application by in its registry and launch records. Lowercase, at least two
 * segments, unique across applications like a web origin.
 */
export const OXYOS_DESKTOP_ENTRY_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** An application token lives exactly this long (ADR 0058 2.3). */
export const DEVICE_APP_TOKEN_TTL_SECONDS = 300;

/**
 * Why `POST /session/device/app-token` refused. The API answers `{ error: <code> }`.
 *
 * - `invalid_request` (400): the body is not the contract's.
 * - `browser_not_allowed` (403): the request carries a web `Origin` (or
 *   `Sec-Fetch-Site`); only a platform's own native service mints.
 * - `invalid_device_secret` (401): the secret proves no PLATFORM credential of
 *   that device. A wrong secret counts toward the device-secret lockout.
 * - `application_not_recognised` (403): the credential is another platform's,
 *   or the attestation names no active Oxy application recognised for this
 *   platform (an unknown desktop entry id, an origin that is not the
 *   application's, auth.oxy.so's application, a third-party application, a
 *   `clientId` of another application).
 * - `no_active_session` / `account_not_on_device` (401): as
 *   `POST /session/device/token`: nothing live to mint for, or the pinned
 *   account is not live on the device.
 */
export const DEVICE_APP_TOKEN_ERROR_CODES = [
  'invalid_request',
  'browser_not_allowed',
  'invalid_device_secret',
  'application_not_recognised',
  'no_active_session',
  'account_not_on_device',
] as const;

/**
 * Every bearer-authenticated `/session/device/*` route answers an application
 * token (one carrying `host`) with `403 { error: APP_TOKEN_DEVICE_ACCESS_DENIED }`:
 * the device is the platform's, never an application's.
 */
export const APP_TOKEN_DEVICE_ACCESS_DENIED = 'app_token_device_access_denied';

export const deviceAppTokenResponseCheck = exact<DeviceAppTokenResponse>()(
  object({
    accessToken: string(minLength(1)),
    expiresAt: string(datetime),
    applicationId: string(minLength(1)),
    accountId: string(minLength(1)),
  }),
);
