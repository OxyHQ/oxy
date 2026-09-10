/**
 * First-party login result contract.
 *
 * SINGLE SOURCE OF TRUTH for the first-party login result (the session arm). The
 * API validates its OUTPUT against this schema; every consumer (`@oxy.so/core`'s
 * auth mixin) validates its INPUT against the same definition, so producer and
 * consumers cannot drift. Sign-in is passkey (WebAuthn) or Commons handoff —
 * password and 2FA were removed, so the only outcome is a completed session.
 *
 * The device transport is `deviceId` + `deviceSecret` + `POST /session/device/token`
 * (see `deviceSession.ts`). The legacy cookie/bootstrap/refresh-family lanes were
 * removed in the zero-cookie cutover — nothing here carries a refresh token or a
 * boot fragment.
 *
 * Nested-object response shapes are declared as explicit `interface`s with the
 * runtime schema annotated `z.ZodType<Interface>` — the same rationale as
 * `identity.ts` / `userResponse.ts`: a `z.infer<>` of a nested object schema can
 * degrade to `{}` under a consumer's `moduleResolution: "node"` (node10), so the
 * load-bearing shapes are pinned by literal interfaces. Flat request/response
 * shapes (no nested-object hazard) are inferred via `z.infer<>`.
 *
 * Platform-agnostic — zod only, no react/react-native/expo. ESM-safe (no
 * `require()`).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*  First-party login result (session arm)                                    */
/* -------------------------------------------------------------------------- */

/** One anomalous signal the server flagged on a sign-in (new device, location, …). */
export interface SecurityAlertAnomaly {
    type: string;
    reason: string;
    details?: string;
}

/**
 * The "New sign-in detected" payload the API attaches to a successful
 * `POST /auth/login` when anomaly detection fires (`session.controller.ts`).
 * The IdP renders `message` and gates the flow on user acknowledgement before
 * continuing to the OAuth authorize step.
 */
export interface SecurityAlert {
    message: string;
    anomalies: SecurityAlertAnomaly[];
}

/**
 * A successful sign-in. Matches the API's `SessionAuthResponse` EXACTLY
 * (`buildSessionAuthResponse`). `user` is the truncated session-user shape the
 * sign-in endpoints emit (NOT the full `userResponseSchema`).
 */
export interface LoginSessionResult {
    sessionId: string;
    deviceId: string;
    expiresAt: string;
    accessToken?: string;
    /**
     * The device secret (zero-cookie transport). Emitted on every successful
     * sign-in; the client persists it first-party alongside `deviceId` and later
     * mints access tokens via `POST /session/device/token`. Optional only because
     * a best-effort mint can fail — it is the sole restore credential.
     */
    deviceSecret?: string;
    /**
     * Present only when the server's anomaly detection flagged this sign-in.
     * The IdP shows a "New sign-in detected" acknowledgement before proceeding.
     * The session is already established regardless — this is an interstitial,
     * not a gate on the credential check.
     */
    securityAlert?: SecurityAlert;
    user: {
        id: string;
        username?: string;
        avatar?: string;
    };
}

/** The outcome of a successful sign-in — always a completed session. */
export type LoginResult = LoginSessionResult;

const securityAlertSchema: z.ZodType<SecurityAlert> = z.object({
    message: z.string(),
    anomalies: z.array(
        z.object({
            type: z.string(),
            reason: z.string(),
            details: z.string().optional(),
        }),
    ),
});

const loginSessionResultSchema = z.object({
    sessionId: z.string(),
    deviceId: z.string(),
    expiresAt: z.string(),
    accessToken: z.string().optional(),
    deviceSecret: z.string().optional(),
    securityAlert: securityAlertSchema.optional(),
    user: z.object({
        id: z.string(),
        username: z.string().optional(),
        avatar: z.string().optional(),
    }),
});

export const loginResultSchema: z.ZodType<LoginResult> = loginSessionResultSchema;
