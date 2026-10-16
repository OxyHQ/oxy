/**
 * App assertions (ADR 0045): how an Oxy app proves which app it is.
 *
 * ## The registry
 *
 * Each application may declare how it is recognised, written only by Oxy staff
 * through the application administration lane
 * (`PUT /applications/:appId/recognition`): its exact `https://` web origins,
 * its Android package and signing certificates, and its iOS team and bundle.
 * A platform it does not declare can never assert it.
 *
 * ## The exchange
 *
 * With the person's own bearer, the app asks `POST /apps/assertions` for an
 * `OXY-APP+JWT` naming the application, and proves itself by platform: on the
 * web the browser's `Origin`; on Android a Play Integrity token whose request
 * hash is a challenge from `POST /apps/assertions/challenge`; on iOS an App
 * Attest assertion over such a challenge, made with a key registered through
 * `POST /apps/attest-keys`. The assertion lives five minutes and names the
 * person (`sub`) and the session (`sid`) it was issued to.
 *
 * The Zod-free half (vocabularies, header name, response checks) is
 * `./client/appAssertions.ts`.
 */

import { z } from 'zod';
import {
  APP_ASSERTION_CHALLENGE_PURPOSES,
  APP_ASSERTION_ERROR_CODES,
  APP_ASSERTION_PLATFORMS,
  OXY_APP_ASSERTION_AUDIENCE,
  OXY_APP_ASSERTION_HEADER,
  OXY_APP_ASSERTION_TTL_SECONDS,
  OXY_APP_ASSERTION_TYPE,
} from './client/appAssertions';

export {
  APP_ASSERTION_CHALLENGE_PURPOSES,
  APP_ASSERTION_ERROR_CODES,
  APP_ASSERTION_PLATFORMS,
  OXY_APP_ASSERTION_AUDIENCE,
  OXY_APP_ASSERTION_HEADER,
  OXY_APP_ASSERTION_TTL_SECONDS,
  OXY_APP_ASSERTION_TYPE,
};

const applicationIdSchema = z.string().trim().min(1).max(255);
const base64Url32Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const base64Schema = (max: number) =>
  z
    .string()
    .min(4)
    .max(max)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const appAssertionPlatformSchema = z.enum(APP_ASSERTION_PLATFORMS);
export const appAssertionErrorCodeSchema = z.enum(APP_ASSERTION_ERROR_CODES);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** True for an exact origin: `https:`, no path, query, fragment or credentials, in canonical form. */
export function isExactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

/** An exact `https://` origin, in the form a browser sends in `Origin` (`https://mention.earth`). */
export const applicationWebOriginSchema = z
  .string()
  .max(255)
  .refine(isExactHttpsOrigin, 'Must be an exact https origin, as a browser sends it');

/** A Java-style Android application id, at least two segments. */
export const androidPackageNameSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/, 'Must be an Android package name');

/** A signing certificate's SHA-256, 64 lowercase hex characters (keytool's digest without colons). */
export const signingCertSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Must be 64 lowercase hex characters');

/** An Apple Developer team id. */
export const appleTeamIdSchema = z.string().regex(/^[A-Z0-9]{10}$/, 'Must be an Apple team id');

/** An Apple bundle id. */
export const appleBundleIdSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/, 'Must be an Apple bundle id');

const unique = (values: readonly string[]) => new Set(values).size === values.length;

export const applicationAndroidRecognitionSchema = z
  .object({
    packageName: androidPackageNameSchema,
    signingCertSha256: z
      .array(signingCertSha256Schema)
      .min(1)
      .max(10)
      .refine(unique, 'Certificates must be unique'),
  })
  .strict();

export const applicationIosRecognitionSchema = z
  .object({ teamId: appleTeamIdSchema, bundleId: appleBundleIdSchema })
  .strict();

/**
 * What Oxy staff write for an application: the whole declaration, replaced at
 * once. `null` and `[]` declare nothing for that platform.
 */
export const applicationRecognitionWriteSchema = z
  .object({
    webOrigins: z
      .array(applicationWebOriginSchema)
      .max(20)
      .refine(unique, 'Origins must be unique'),
    android: applicationAndroidRecognitionSchema.nullable(),
    ios: applicationIosRecognitionSchema.nullable(),
  })
  .strict();

/** An application's recognition as the registry holds it; `updatedAt` is `null` when none was written. */
export const applicationRecognitionSchema = applicationRecognitionWriteSchema
  .extend({
    applicationId: applicationIdSchema,
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

/** `POST /apps/assertions/challenge`: a single-use challenge for a device proof. */
export const appAssertionChallengeRequestSchema = z.discriminatedUnion('platform', [
  z.object({ applicationId: applicationIdSchema, platform: z.literal('android') }).strict(),
  z
    .object({
      applicationId: applicationIdSchema,
      platform: z.literal('ios'),
      purpose: z.enum(APP_ASSERTION_CHALLENGE_PURPOSES),
    })
    .strict(),
]);

/**
 * The challenge, and `requestHash`: what the device signs or hands to Play
 * Integrity, binding the challenge to this application, platform, purpose and
 * session. `cloudProjectNumber` is the Google Cloud project Play Integrity
 * tokens are requested for (Android only).
 */
export const appAssertionChallengeResponseSchema = z
  .object({
    challenge: base64Url32Schema,
    requestHash: base64Url32Schema,
    expiresAt: z.string().datetime(),
    cloudProjectNumber: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .optional(),
  })
  .strict();

/** An App Attest key id: the standard base64 of the SHA-256 of the key. */
export const appAttestKeyIdSchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);

/** `POST /apps/attest-keys`: register an App Attest key, attested over a `attest_key` challenge. */
export const appAttestKeyRequestSchema = z
  .object({
    applicationId: applicationIdSchema,
    keyId: appAttestKeyIdSchema,
    challenge: base64Url32Schema,
    attestation: base64Schema(32_768),
  })
  .strict();

export const appAttestKeyResponseSchema = z.object({ keyId: appAttestKeyIdSchema }).strict();

/**
 * `POST /apps/assertions`. The body names the application and the platform;
 * the proof is the platform's: none on the web (the browser's `Origin` is), a
 * Play Integrity token on Android, an App Attest assertion on iOS, each over a
 * challenge minted for `assertion`.
 */
export const appAssertionRequestSchema = z.discriminatedUnion('platform', [
  z.object({ applicationId: applicationIdSchema, platform: z.literal('web') }).strict(),
  z
    .object({
      applicationId: applicationIdSchema,
      platform: z.literal('android'),
      proof: z
        .object({
          challenge: base64Url32Schema,
          integrityToken: z.string().min(1).max(16_384),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      applicationId: applicationIdSchema,
      platform: z.literal('ios'),
      proof: z
        .object({
          challenge: base64Url32Schema,
          keyId: appAttestKeyIdSchema,
          assertion: base64Schema(4_096),
        })
        .strict(),
    })
    .strict(),
]);

/** The assertion, and what it says. Send it as {@link OXY_APP_ASSERTION_HEADER}. */
export const appAssertionResponseSchema = z
  .object({
    assertion: z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    applicationId: z.string().regex(/^\S{1,255}$/),
    platform: appAssertionPlatformSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export type AppAssertionPlatform = (typeof APP_ASSERTION_PLATFORMS)[number];
export type AppAssertionChallengePurpose = (typeof APP_ASSERTION_CHALLENGE_PURPOSES)[number];
export type AppAssertionErrorCode = (typeof APP_ASSERTION_ERROR_CODES)[number];
export type ApplicationAndroidRecognition = z.infer<typeof applicationAndroidRecognitionSchema>;
export type ApplicationIosRecognition = z.infer<typeof applicationIosRecognitionSchema>;
export type ApplicationRecognitionWrite = z.infer<typeof applicationRecognitionWriteSchema>;
export type ApplicationRecognition = z.infer<typeof applicationRecognitionSchema>;
export type AppAssertionChallengeRequest = z.infer<typeof appAssertionChallengeRequestSchema>;
export type AppAssertionChallengeResponse = z.infer<typeof appAssertionChallengeResponseSchema>;
export type AppAttestKeyRequest = z.infer<typeof appAttestKeyRequestSchema>;
export type AppAttestKeyResponse = z.infer<typeof appAttestKeyResponseSchema>;
export type AppAssertionRequest = z.infer<typeof appAssertionRequestSchema>;
export type AppAssertionResponse = z.infer<typeof appAssertionResponseSchema>;
