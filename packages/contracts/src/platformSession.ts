/**
 * A platform that holds the Oxy session (ADR 0058).
 *
 * OxyOS (`oxyos-accountd`) and Astro hold the person's Oxy session on a
 * PLATFORM CREDENTIAL: a device holder credential issued to the platform's own
 * sign-in, the one that names it with {@link platformClientSchema}
 * (`POST /auth/signin/password`, completed by `POST /auth/signin/second-factor`).
 * Applications they run hold nothing; the platform asks
 * `POST /session/device/app-token` for a five-minute token named for each one
 * (`azp`, and the `host` claim naming the platform and its credential).
 *
 * The Zod-free half (vocabularies, the response check) is
 * `./client/platformSession.ts`.
 */

import { z } from 'zod';
import {
  applicationWebOriginSchema,
  oxyosDesktopEntryIdSchema,
  platformHostSchema,
} from './appAssertions';
import {
  APP_TOKEN_DEVICE_ACCESS_DENIED,
  DEVICE_APP_TOKEN_ERROR_CODES,
  DEVICE_APP_TOKEN_TTL_SECONDS,
  OXYOS_DESKTOP_ENTRY_ID_PATTERN,
  PLATFORM_HOSTS,
} from './client/platformSession';
import { deviceProofSchema } from './deviceSession';
import { isoDateTime, utf16MaxLength, utf16MinLength } from './stringChecks';

export {
  APP_TOKEN_DEVICE_ACCESS_DENIED,
  DEVICE_APP_TOKEN_ERROR_CODES,
  DEVICE_APP_TOKEN_TTL_SECONDS,
  OXYOS_DESKTOP_ENTRY_ID_PATTERN,
  PLATFORM_HOSTS,
};

const publicClientIdSchema = z.string().check(utf16MinLength(1)).check(utf16MaxLength(256));

/**
 * Names the platform on its own password sign-in, and on the second factor
 * completing it. Honoured only when the request has NO web `Origin` and
 * `clientId` is a live public client id of an active Oxy application whose
 * registry entry declares `platformHost` equal to `platform`; anything else is
 * refused with the ordinary invalid-request answer before any account lookup or
 * password work. When honoured, the device credential the sign-in returns is a
 * platform credential, and a credential the sign-in's `device` proof presented
 * is retired.
 */
export const platformClientSchema = z.strictObject({
  platform: platformHostSchema,
  clientId: publicClientIdSchema,
});

/**
 * `POST /session/device/platform`: a platform's credential from the QR
 * approval (ADR 0058 2.1, amended 2026-11-08). `device` is the holder
 * credential a device-sign-in claim (`POST /auth/session/claim`) issued to the
 * platform's setup client a few minutes ago, the request having been started by
 * the application `platformClient` names. Honoured as `platformClient` is on
 * the password sign-in (no web `Origin`, the registry's `platformHost`). The
 * proof is spent once; the answer is the password sign-in's (`LoginResult`),
 * its `deviceSecret` the platform credential. Every proof that is not
 * redeemable gets the same 401 (`invalid_grant`).
 */
export const devicePlatformRequestSchema = z.strictObject({
  device: z.strictObject(deviceProofSchema.shape),
  platformClient: platformClientSchema,
});

/**
 * Which application the token is for, as the platform vouches for it:
 *
 * - `{ platform: 'oxyos', desktopEntryId }`: an application OxyOS launched,
 *   by the desktop entry id its registry entry declares;
 * - `{ platform, self: true }`: the platform's own application (OxyOS's
 *   Settings and shell, Astro's chrome);
 * - `{ platform: 'astro', origin, clientId }`: an Oxy web application Astro
 *   shows, by the exact origin it committed and the application's client id.
 */
export const deviceAppTokenAttestationSchema = z.union([
  z.strictObject({ platform: z.literal('oxyos'), desktopEntryId: oxyosDesktopEntryIdSchema }),
  z.strictObject({ platform: platformHostSchema, self: z.literal(true) }),
  z.strictObject({
    platform: z.literal('astro'),
    origin: applicationWebOriginSchema,
    clientId: publicClientIdSchema,
  }),
]);

/**
 * `POST /session/device/app-token`: the platform credential (no bearer;
 * possession is the proof, as at `POST /session/device/token`), the
 * attestation, and optionally `accountId` (pins the account, as that mint's
 * does) and `clientId` (when given, a public client id of the SAME application
 * the attestation names).
 */
export const deviceAppTokenRequestSchema = z.strictObject({
  deviceId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(128)),
  deviceSecret: z.string().check(utf16MinLength(1)).check(utf16MaxLength(256)),
  accountId: z.string().check(utf16MinLength(1)).check(utf16MaxLength(128)).optional(),
  clientId: publicClientIdSchema.optional(),
  attestation: deviceAppTokenAttestationSchema,
});

/**
 * The application's token: a fresh access token of the device's shared session
 * for `accountId`, named for `applicationId` (`azp`, its public client id) and
 * carrying `host`. `expiresAt` is the token's own `exp`
 * ({@link DEVICE_APP_TOKEN_TTL_SECONDS} after it was minted).
 */
export const deviceAppTokenResponseSchema = z.object({
  accessToken: z.string().check(utf16MinLength(1)),
  expiresAt: z.string().check(isoDateTime()),
  applicationId: z.string().check(utf16MinLength(1)),
  accountId: z.string().check(utf16MinLength(1)),
});

/**
 * The `host` claim of an application token: the platform that vouched for the
 * application and the id of its platform credential. Oxy re-checks both on
 * every request (the credential is live and the platform's, `azp` is a live
 * public client of an active Oxy application).
 */
export const hostTokenClaimSchema = z.strictObject({
  platform: platformHostSchema,
  credential: z.string().check(utf16MinLength(1)).check(utf16MaxLength(128)),
});

/**
 * What `GET /session/validate-header/:sessionId` adds for an application token:
 * the application it is named for and the platform that vouched for it.
 */
export const hostTokenValidationSchema = z.object({
  applicationId: z.string().check(utf16MinLength(1)),
  platform: platformHostSchema,
});

export type PlatformHost = (typeof PLATFORM_HOSTS)[number];
export type DeviceAppTokenErrorCode = (typeof DEVICE_APP_TOKEN_ERROR_CODES)[number];
export type PlatformClient = z.infer<typeof platformClientSchema>;
export type DevicePlatformRequest = z.infer<typeof devicePlatformRequestSchema>;
export type DeviceAppTokenAttestation = z.infer<typeof deviceAppTokenAttestationSchema>;
export type DeviceAppTokenRequest = z.infer<typeof deviceAppTokenRequestSchema>;
export type DeviceAppTokenResponse = z.infer<typeof deviceAppTokenResponseSchema>;
export type HostTokenClaim = z.infer<typeof hostTokenClaimSchema>;
export type HostTokenValidation = z.infer<typeof hostTokenValidationSchema>;
