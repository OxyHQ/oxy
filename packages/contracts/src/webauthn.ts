/**
 * WebAuthn / passkey ceremony contracts (Fase B/b1).
 *
 * These schemas describe ONLY the outer Oxy envelope that wraps a WebAuthn
 * ceremony request — the username the client is registering/authenticating as,
 * plus the device-session options every first-party sign-in accepts. The browser
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON` payloads are NOT
 * mirrored here: they are validated by `@simplewebauthn/server` inside the route
 * (`verifyRegistrationResponse` / `verifyAuthenticationResponse`), which is the
 * single source of truth for their structure. Re-encoding them in Zod would just
 * create a second, drift-prone definition of a shape we do not own.
 */

import { z } from 'zod';

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
 */
const deviceSessionEnvelope = {
  deviceName: z.string().trim().min(1).max(120).optional(),
  deviceFingerprint: z.string().trim().min(1).max(256).optional(),
} as const;

/**
 * `POST /webauthn/register/options` — request registration options. With a bearer
 * token the caller links a passkey to their signed-in account and `username` is
 * ignored; without one it is a prospective signup and `username` is the desired
 * (not-yet-created) handle.
 */
export const webauthnRegisterOptionsRequestSchema = z.object({
  username: z.string().trim().min(1).max(60).optional(),
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
 * is validated by `@simplewebauthn/server`, not here. `username` is required only
 * for the prospective-signup branch (no bearer); the linking branch ignores it.
 */
export const webauthnRegisterVerifyRequestSchema = z.object({
  username: z.string().trim().min(1).max(60).optional(),
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
