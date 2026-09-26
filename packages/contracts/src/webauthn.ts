/**
 * WebAuthn / passkey ceremony contracts (Fase B/b1).
 *
 * These schemas describe ONLY the outer Oxy envelope that wraps a WebAuthn
 * ceremony request — the username the client is registering/authenticating as,
 * plus non-authoritative device metadata. The browser
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON` payloads are NOT
 * mirrored here: they are validated by `@simplewebauthn/server` inside the route
 * (`verifyRegistrationResponse` / `verifyAuthenticationResponse`), which is the
 * single source of truth for their structure. Re-encoding them in Zod would just
 * create a second, drift-prone definition of a shape we do not own.
 */

import { z } from 'zod';
import { emailAddressSchema, emailTicketSchema } from './accountEmail';
import { deviceProofSchema } from './deviceSession';

/** A WebAuthn credential id, base64url as the browser reports it. */
export const webauthnCredentialIdSchema = z
  .string()
  .trim()
  .min(16)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/, 'credentialId must be base64url');

/**
 * A WebAuthn assertion by one of the account's EXISTING passkeys over a server
 * challenge — the fresh use of the factor the account already has (linking
 * Commons to a passkey account, deleting a passkey account). The API verifies
 * it with `@simplewebauthn/server`; this only bounds its shape.
 */
export const webauthnAssertionResponseSchema = z
  .object({
    id: webauthnCredentialIdSchema,
    rawId: z.string().min(1).max(2048),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: z.string().min(1).max(8192),
        authenticatorData: z.string().min(1).max(8192),
        signature: z.string().min(1).max(2048),
        userHandle: z.string().max(2048).optional(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().optional(),
  })
  .passthrough();
export type WebauthnAssertionResponse = z.infer<typeof webauthnAssertionResponseSchema>;

/**
 * Device-session options shared by every first-party sign-in body
 * (`deviceName`/`deviceFingerprint`). Mirrors what
 * `sessionCreateOptionsFromBody` reads in the API so a WebAuthn login/verify can
 * name its resulting session exactly like `/auth/login` or `/auth/verify`.
 *
 * There is deliberately no `deviceId` here. `createSession` treats an explicit
 * device id as authoritative — `deviceId > stableDeviceKey > UA/IP > random` —
 * and stamps it verbatim, so on an UNAUTHENTICATED sign-in body it is a caller
 * naming somebody else's device and having a session, and then a device secret,
 * minted against it. The legitimate callers that pin a device id are
 * server-side and already authorized (the account-switch route threading the
 * operator's own central device id); they pass it to `createSession` directly
 * and never through a request body.
 *
 * `device` is different: it PROVES a device (its id and one of its holder
 * secrets) rather than naming one, so the caller already holds that device's
 * credential and the session added to it discloses nothing new (ADR 0029 D2).
 * An invalid proof is ignored and the sign-in proceeds as without it.
 */
const deviceSessionEnvelope = {
  deviceName: z.string().trim().min(1).max(120).optional(),
  deviceFingerprint: z.string().trim().min(1).max(256).optional(),
  device: deviceProofSchema.optional(),
} as const;

/**
 * `POST /webauthn/register/options` — request registration options. Three flows:
 *
 * - a bearer: the caller adds a passkey to their signed-in account;
 * - `recoveryTicket` (no bearer): a new passkey for the account a recovery code
 *   was confirmed for (`POST /auth/email/verify/confirm`, purpose `recovery`);
 * - `username` (no bearer): a prospective sign-up; the handle is not created yet.
 */
export const webauthnRegisterOptionsRequestSchema = z.object({
  username: z.string().trim().min(1).max(60).optional(),
  recoveryTicket: emailTicketSchema.optional(),
});
export type WebauthnRegisterOptionsRequest = z.infer<typeof webauthnRegisterOptionsRequestSchema>;

/**
 * `POST /webauthn/login/options` — request authentication options. When
 * `username` is present the server scopes `allowCredentials` to that user's
 * passkeys (username-first); when omitted it returns an empty allow-list for the
 * usernameless / discoverable-credential flow (the default).
 */
export const webauthnLoginOptionsRequestSchema = z.object({
  username: z.string().trim().min(1).max(60).optional(),
});
export type WebauthnLoginOptionsRequest = z.infer<typeof webauthnLoginOptionsRequestSchema>;

/**
 * `POST /webauthn/register/verify` — the outer envelope. The browser
 * `RegistrationResponseJSON` travels alongside these fields under `response` and
 * is validated by `@simplewebauthn/server`, not here.
 *
 * - Sign-up (no bearer, ADR 0029 D3): `username`, the recovery `email` and the
 *   `emailTicket` its code was confirmed with. The account is created with the
 *   passkey and that verified email, and no key.
 * - Recovery (no bearer): `recoveryTicket`; the passkey is added to its account
 *   and a session minted.
 * - A bearer: the passkey is added to the signed-in account.
 */
export const webauthnRegisterVerifyRequestSchema = z.object({
  username: z.string().trim().min(1).max(60).optional(),
  email: emailAddressSchema.optional(),
  emailTicket: emailTicketSchema.optional(),
  recoveryTicket: emailTicketSchema.optional(),
  ...deviceSessionEnvelope,
});
export type WebauthnRegisterVerifyRequest = z.infer<typeof webauthnRegisterVerifyRequestSchema>;

/**
 * `POST /webauthn/login/verify` — the outer envelope. The browser
 * `AuthenticationResponseJSON` travels alongside these fields under `response`
 * and is validated by `@simplewebauthn/server`, not here.
 */
export const webauthnLoginVerifyRequestSchema = z.object({
  ...deviceSessionEnvelope,
});
export type WebauthnLoginVerifyRequest = z.infer<typeof webauthnLoginVerifyRequestSchema>;
