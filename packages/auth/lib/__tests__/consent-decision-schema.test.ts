/**
 * Contract tests for `oauthConsentDecisionSchema` + `consentRequiredFromBody` —
 * the `GET /auth/oauth/consent` decision the authorize page runs to decide
 * whether the OAuth consent screen must be shown or the request can be
 * auto-approved.
 *
 * The page calls this for the OAuth code path right after an account is
 * selected. The security-critical invariant: ANY response the schema cannot
 * validate (transport failure, malformed body, missing field, unknown `reason`)
 * MUST fail safe to `consentRequired: true` so the consent screen is shown — we
 * never silently auto-approve on a parse error.
 *
 * The schema moved to `@oxyhq/contracts` when the browser hub's edge layer
 * became a second consumer of the same response (issue #937 Phase 5), and it is
 * a discriminated union there rather than the flat object this file used to
 * hold. The cases below are unchanged and still pass; the union additionally
 * rejects reason/flag pairs the server can never emit, which the last test
 * pins.
 */
import { describe, expect, test } from "bun:test"
import { oauthConsentDecisionSchema } from "@oxyhq/contracts"
import {
    consentRequiredFromBody,
    mcpConsentFromBody,
    mcpConsentRequiredFromBody,
    safeParse,
} from "@/lib/schemas"

describe("oauthConsentDecisionSchema", () => {
    test("parses every valid reason", () => {
        for (const reason of ["trusted", "granted", "new", "scope_changed"]) {
            const parsed = safeParse(oauthConsentDecisionSchema, {
                consentRequired: reason === "new" || reason === "scope_changed",
                reason,
            })
            expect(parsed).not.toBeNull()
            expect(parsed?.reason).toBe(
                reason as "trusted" | "granted" | "new" | "scope_changed"
            )
        }
    })

    test("rejects an unknown reason enum value", () => {
        expect(
            safeParse(oauthConsentDecisionSchema, {
                consentRequired: false,
                reason: "because_i_said_so",
            })
        ).toBeNull()
    })

    test("rejects a missing consentRequired field", () => {
        expect(
            safeParse(oauthConsentDecisionSchema, { reason: "trusted" })
        ).toBeNull()
    })

    test("rejects a non-boolean consentRequired", () => {
        expect(
            safeParse(oauthConsentDecisionSchema, {
                consentRequired: "false",
                reason: "trusted",
            })
        ).toBeNull()
    })

    test("rejects a reason that contradicts its own flag", () => {
        // `trusted` means "do not ask", so it cannot ride on `true`; `new` means
        // "ask", so it cannot ride on `false`. The flat schema this replaced
        // accepted both, and a consumer reading `reason` first would then have
        // auto-approved a request the server said to ask about.
        expect(
            safeParse(oauthConsentDecisionSchema, {
                consentRequired: true,
                reason: "trusted",
            })
        ).toBeNull()
        expect(
            safeParse(oauthConsentDecisionSchema, {
                consentRequired: false,
                reason: "new",
            })
        ).toBeNull()
    })

    test("carries the scopes that forced the screen", () => {
        const parsed = safeParse(oauthConsentDecisionSchema, {
            consentRequired: true,
            reason: "new",
            userConsentScopes: ["follows:read"],
        })
        expect(parsed).not.toBeNull()
        expect(
            parsed?.consentRequired === true ? parsed.userConsentScopes : null
        ).toEqual(["follows:read"])
    })
})

describe("consentRequiredFromBody", () => {
    test("unwraps the API `{ data: { ... } }` envelope (trusted → auto-approve)", () => {
        expect(
            consentRequiredFromBody({
                data: { consentRequired: false, reason: "trusted" },
            })
        ).toBe(false)
    })

    test("unwraps a covering grant (granted → auto-approve)", () => {
        expect(
            consentRequiredFromBody({
                data: { consentRequired: false, reason: "granted" },
            })
        ).toBe(false)
    })

    test("requires consent for a new app", () => {
        expect(
            consentRequiredFromBody({
                data: { consentRequired: true, reason: "new" },
            })
        ).toBe(true)
    })

    test("requires consent when scopes changed", () => {
        expect(
            consentRequiredFromBody({
                data: { consentRequired: true, reason: "scope_changed" },
            })
        ).toBe(true)
    })

    test("accepts a bare (unwrapped) decision object", () => {
        expect(
            consentRequiredFromBody({
                consentRequired: false,
                reason: "trusted",
            })
        ).toBe(false)
    })

    // ---- fail-safe: never auto-approve on a body the schema can't validate ----

    test("fails safe to true for null", () => {
        expect(consentRequiredFromBody(null)).toBe(true)
    })

    test("fails safe to true for undefined", () => {
        expect(consentRequiredFromBody(undefined)).toBe(true)
    })

    test("fails safe to true for an empty object", () => {
        expect(consentRequiredFromBody({})).toBe(true)
    })

    test("fails safe to true for an empty data envelope", () => {
        expect(consentRequiredFromBody({ data: {} })).toBe(true)
    })

    test("fails safe to true for an unknown reason", () => {
        expect(
            consentRequiredFromBody({
                data: { consentRequired: false, reason: "mystery" },
            })
        ).toBe(true)
    })

    test("fails safe to true for a non-object body", () => {
        expect(consentRequiredFromBody("not json")).toBe(true)
        expect(consentRequiredFromBody(42)).toBe(true)
    })
})

describe("mcpConsentRequiredFromBody", () => {
    const context = {
        client: {
            id: "client-record-1",
            clientId: "oxy_mcp_client",
            name: "Desktop Assistant",
            type: "third_party" as const,
            isOfficial: false,
            isInternal: false,
            scopes: ["email.read", "email.send"],
        },
        account: { id: "mailbox-account", displayName: "Oxy Mail" },
        resource: {
            appId: "inbox",
            uri: "https://mcp.inbox.oxy.so",
            application: {
                id: "inbox-app",
                name: "Inbox",
                type: "first_party" as const,
                isOfficial: true,
                isInternal: true,
                scopes: [],
            },
        },
        capabilities: ["email.read", "email.send"],
        writeActions: [{
            name: "sendEmail",
            version: "1.0.0",
            description: "Send an email from the selected mailbox.",
            requiredCapabilities: ["email.send"],
            effect: "external" as const,
        }],
    }

    test("accepts only an explicit MCP consent decision", () => {
        expect(mcpConsentRequiredFromBody({ consentRequired: false, context })).toBe(false)
        expect(mcpConsentRequiredFromBody({ data: { consentRequired: true, context } })).toBe(true)
        expect(mcpConsentFromBody({ consentRequired: true, context })?.context).toEqual(context)
    })

    test("fails safe for malformed or widened responses", () => {
        expect(mcpConsentRequiredFromBody(null)).toBe(true)
        expect(mcpConsentRequiredFromBody({ consentRequired: "false" })).toBe(true)
        expect(mcpConsentRequiredFromBody({ consentRequired: false })).toBe(true)
        expect(mcpConsentRequiredFromBody({ consentRequired: false, context, extra: true })).toBe(true)
    })
})
