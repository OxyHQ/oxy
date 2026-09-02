/**
 * Zod schemas for validating API responses in the auth app.
 *
 * The user / account / session RESPONSE contracts (`currentUserResponseSchema`,
 * `deviceLinkedSessionsResponseSchema`) plus the
 * device-flow `publicApplicationSchema` / `sessionStatusSchema` are NOT defined
 * here — they are owned by `@oxyhq/contracts` as the single source of truth
 * shared between the API (producer) and every consumer. Importing them straight
 * from the contracts package (not via the client SDK) keeps the wire shape from
 * drifting (a local `name: z.string()` previously rejected every structured-name
 * account and broke session restore; a local `sessionId: z.string().optional()`
 * rejected the producer's PENDING `null` and broke device-flow consent).
 * Re-exporting them keeps the existing `@/lib/schemas` import sites working. Only
 * the auth-app-specific schemas (login, signup, lookup, token, refresh, OAuth
 * state) live locally.
 */
import { z } from "zod"
import {
    currentUserResponseSchema,
    deviceLinkedSessionsResponseSchema,
    oauthConsentDecisionSchema,
    publicApplicationSchema,
    sessionStatusSchema,
    safeParseContract,
} from "@oxyhq/contracts"
import type {
    PublicApplicationResponse,
    SessionStatusResponse,
    ApplicationTypeContract,
} from "@oxyhq/contracts"

// Canonical, contracts-owned schemas re-exported for local import sites.
export {
    currentUserResponseSchema,
    deviceLinkedSessionsResponseSchema,
    publicApplicationSchema,
    sessionStatusSchema,
}
export type {
    PublicApplicationResponse,
    SessionStatusResponse,
    ApplicationTypeContract,
}

export const lookupResponseSchema = z.object({
    exists: z.boolean(),
    username: z.string(),
    color: z.string().nullable(),
    avatar: z.string().nullable(),
    displayName: z.string().optional(),
})

export const tokenResponseSchema = z.object({
    accessToken: z.string(),
    expiresAt: z.string().optional(),
})

export const oauthStateSchema = z.object({
    provider: z.string(),
    sessionToken: z.string().optional(),
    redirectUri: z.string().optional(),
    state: z.string().optional(),
})

/**
 * Decide whether the OAuth consent screen must be shown, from the raw
 * `GET /auth/oauth/consent` response body. Accepts either the API's wrapped
 * `{ data: { ... } }` envelope or a bare decision object. Fails safe: any body
 * the schema cannot validate (malformed, missing fields, unknown `reason`,
 * `null`) returns `true` so the caller renders the consent screen rather than
 * auto-approving on a parse error.
 *
 * The schema is `oauthConsentDecisionSchema` from `@oxyhq/contracts`, which the
 * API now also parses its own response against. The local copy this file used to
 * carry was a flat `{consentRequired: boolean, reason: enum}` and admitted pairs
 * the server can never emit — `{consentRequired: true, reason: 'trusted'}` among
 * them. The contract's discriminated union rejects those, and rejecting means
 * showing the consent screen, so the tightening moves in the safe direction.
 */
export function consentRequiredFromBody(body: unknown): boolean {
    const inner =
        body && typeof body === "object" && "data" in body
            ? (body as { data: unknown }).data
            : body
    const parsed = safeParse(oauthConsentDecisionSchema, inner)
    return parsed ? parsed.consentRequired : true
}

/**
 * Parse the deliberately smaller decision returned by the resource-bound MCP
 * OAuth lane. A missing, wrapped incorrectly, or non-boolean value always means
 * "show consent"; only an explicit `false` may skip the screen.
 */
export function mcpConsentRequiredFromBody(body: unknown): boolean {
    const inner =
        body && typeof body === "object" && "data" in body
            ? (body as { data: unknown }).data
            : body
    const parsed = z.object({ consentRequired: z.boolean() }).strict().safeParse(inner)
    return parsed.success ? parsed.data.consentRequired : true
}

/**
 * Safely parse a JSON response with a Zod schema. Returns the parsed data or
 * `null` if validation fails. Delegates to the contracts package's
 * `safeParseContract` so there is exactly one parse helper across the ecosystem.
 */
export const safeParse = safeParseContract
