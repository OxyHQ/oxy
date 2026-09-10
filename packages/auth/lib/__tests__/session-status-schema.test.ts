/**
 * Contract tests for `sessionStatusSchema` — the `/auth/session/status` payload
 * validator the authorize page runs over the device-flow status response.
 *
 * The status response carries the resolved `application` identity (a real
 * registered `Application`, surfaced as a `PublicApplication`). These tests pin
 * the contract:
 *   - a realistic status response with a full `application` object parses
 *     through with the application PRESERVED (never stripped);
 *   - `application: null` is accepted (no application could be resolved);
 *   - a status response with no `application` field at all is accepted;
 *   - an `application` with an invalid `type` enum collapses the parse to null.
 *
 * A field-shape mismatch here would collapse `safeParse` to null and route the
 * authorize page to its unresolved-application error path, so the schema must
 * mirror the API's real `/auth/session/status` shape exactly.
 *
 * The schema + parse helper now come from `@oxy.so/contracts` (the single source
 * of truth shared with the API producer). Importing them through `@/lib/schemas`
 * — which re-exports the contracts versions — also proves the auth app is wired
 * onto the canonical contract, not a local copy that could drift again.
 */
import { describe, expect, test } from "bun:test"
import { sessionStatusSchema as contractsSessionStatusSchema } from "@oxy.so/contracts"
import { sessionStatusSchema, safeParse } from "@/lib/schemas"

describe("sessionStatusSchema", () => {
    test("parses a status response with a full application object (application preserved)", () => {
        const payload = {
            status: "pending",
            authorized: false,
            sessionToken: "sess_abc123",
            application: {
                id: "app1",
                name: "Mention",
                description: "Social media for the fediverse",
                icon: "https://cdn.oxy.so/app/mention.png",
                websiteUrl: "https://mention.earth",
                type: "first_party",
                isOfficial: true,
                isInternal: false,
                scopes: ["user:read", "files:read"],
                developerName: "Oxy",
            },
            expiresAt: new Date().toISOString(),
            sessionId: "s1",
            publicKey: "0xabc",
            userId: "u1",
        }

        const parsed = safeParse(sessionStatusSchema, payload)
        expect(parsed).not.toBeNull()
        // The application object survives the parse intact — not stripped.
        expect(parsed?.application).not.toBeNull()
        expect(parsed?.application?.id).toBe("app1")
        expect(parsed?.application?.name).toBe("Mention")
        expect(parsed?.application?.type).toBe("first_party")
        expect(parsed?.application?.isOfficial).toBe(true)
        expect(parsed?.application?.scopes).toEqual(["user:read", "files:read"])
        expect(parsed?.application?.developerName).toBe("Oxy")
    })

    test("accepts application: null (no application could be resolved)", () => {
        const payload = {
            status: "pending",
            sessionToken: "sess_def456",
            application: null,
            expiresAt: new Date().toISOString(),
            sessionId: "s2",
        }

        const parsed = safeParse(sessionStatusSchema, payload)
        expect(parsed).not.toBeNull()
        expect(parsed?.application).toBeNull()
    })

    test("accepts a status response with no application field at all", () => {
        const payload = {
            status: "expired",
            sessionId: "s3",
        }

        const parsed = safeParse(sessionStatusSchema, payload)
        expect(parsed).not.toBeNull()
        expect(parsed?.status).toBe("expired")
        expect(parsed?.application).toBeUndefined()
    })

    test("parses the REAL pending device-flow payload (sessionId/userId/publicKey all null)", () => {
        // The exact production response for a PENDING device session. Before the
        // fix, `sessionId: z.string().optional()` REJECTED `null` (optional
        // permits undefined/missing but NOT null), collapsing the parse to null
        // → `application` resolved to null → the consent page rendered the
        // "Unable to identify the requesting application." error for EVERY app
        // while its session was pending (sessionId is null until authorized).
        // This locks out that regression: the payload must parse AND the
        // resolved application name must survive.
        const payload = {
            status: "pending",
            authorized: false,
            sessionToken: "sess_inbox_pending",
            application: {
                id: "6a2f851751b784a86fd0e8f6",
                name: "Oxy Inbox",
                type: "first_party",
                isOfficial: true,
                isInternal: false,
                scopes: ["user:read"],
                description: "Email for the Oxy ecosystem",
                websiteUrl: "https://inbox.oxy.so",
            },
            expiresAt: new Date().toISOString(),
            sessionId: null,
            publicKey: null,
            userId: null,
        }

        const parsed = safeParse(sessionStatusSchema, payload)
        expect(parsed).not.toBeNull()
        // The resolved application identity drives the consent UI — without it
        // the page shows the unresolved-application error.
        expect(parsed?.application?.name).toBe("Oxy Inbox")
        expect(parsed?.application?.id).toBe("6a2f851751b784a86fd0e8f6")
        // The producer emits these as `null` for a pending session; the schema
        // must accept null (not just undefined) for all three.
        expect(parsed?.sessionId).toBeNull()
        expect(parsed?.publicKey).toBeNull()
        expect(parsed?.userId).toBeNull()
        expect(parsed?.status).toBe("pending")
    })

    test("parses the authorized device-flow payload (sessionId/userId become strings)", () => {
        // Once the user authorizes, the producer fills in the previously-null
        // fields with strings. Both the pending (null) and authorized (string)
        // states must parse so the consent → authorized transition never breaks.
        const payload = {
            status: "authorized",
            authorized: true,
            sessionToken: "sess_inbox_authorized",
            application: {
                id: "6a2f851751b784a86fd0e8f6",
                name: "Oxy Inbox",
                type: "first_party",
                isOfficial: true,
                isInternal: false,
                scopes: ["user:read"],
            },
            expiresAt: new Date().toISOString(),
            sessionId: "sess_authorized_id",
            publicKey: "0xfeedface",
            userId: "user_123",
        }

        const parsed = safeParse(sessionStatusSchema, payload)
        expect(parsed).not.toBeNull()
        expect(parsed?.application?.name).toBe("Oxy Inbox")
        expect(parsed?.sessionId).toBe("sess_authorized_id")
        expect(parsed?.userId).toBe("user_123")
        expect(parsed?.publicKey).toBe("0xfeedface")
        expect(parsed?.status).toBe("authorized")
    })

    test("rejects an application with an invalid type enum value", () => {
        const payload = {
            status: "pending",
            application: {
                id: "app5",
                name: "Rogue",
                type: "not_a_real_type",
                isOfficial: false,
                isInternal: false,
                scopes: [],
            },
        }

        // A malformed application object collapses the whole parse to null,
        // which the authorize page treats as an unresolved request.
        expect(safeParse(sessionStatusSchema, payload)).toBeNull()
    })

    test("the @/lib/schemas re-export IS the @oxy.so/contracts schema (no local copy)", () => {
        // Identity check: if a local copy ever crept back in, this fails — the
        // whole point of centralizing the session-status contract is ONE schema
        // owned by @oxy.so/contracts and consumed (not redefined) by the auth app.
        expect(sessionStatusSchema).toBe(contractsSessionStatusSchema)
    })
})
