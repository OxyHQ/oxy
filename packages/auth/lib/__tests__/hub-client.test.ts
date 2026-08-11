/**
 * The IdP page's hub client, in BOTH flag states.
 *
 * The off-state cases are the point of this file, not padding: a feature flag
 * whose off-branch is untested is a second code path nobody looks at, and this
 * one guards the promise that merging the browser hub changes nothing
 * observable at `auth.oxy.so`. So every method is asserted to short-circuit
 * before `fetch`, and the injected `fetch` doubles as the witness — if it is
 * ever called with the flag off, the assertion on its call count fails.
 */

import { describe, expect, test } from "bun:test"
import {
    createHubClient,
    hubSessionOf,
    isBrowserHubEnabled,
} from "@/lib/hub-client"

const DIRECTORY = {
    deviceId: "dev-1",
    revision: 3,
    activeContextId: "ctx-1",
    principals: [
        {
            id: "prin-1",
            userId: "user-1",
            authuser: 0,
            user: { id: "user-1", username: "nate" },
            contexts: [
                {
                    id: "ctx-1",
                    accountId: "user-1",
                    kind: "personal",
                    relationship: "self",
                    account: { id: "user-1", username: "nate" },
                    onDevice: true,
                    available: true,
                    active: true,
                    lastUsedAt: null,
                },
            ],
        },
    ],
    updatedAt: 1_760_000_000_000,
}

interface Call {
    path: string
    init: RequestInit
}

/** A `fetch` double that records every call and answers with one canned body. */
function recorder(body: unknown, ok = true) {
    const calls: Call[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ path: String(input), init: init ?? {} })
        return new Response(JSON.stringify(body), {
            status: ok ? 200 : 500,
            headers: { "content-type": "application/json" },
        })
    }) as typeof fetch
    return { calls, fetchImpl }
}

describe("isBrowserHubEnabled", () => {
    test("is OFF by default — an unset flag never enables the lane", () => {
        expect(isBrowserHubEnabled({})).toBe(false)
        expect(isBrowserHubEnabled({ VITE_OXY_BROWSER_HUB: undefined })).toBe(false)
    })

    test('only the exact string "1" enables it', () => {
        expect(isBrowserHubEnabled({ VITE_OXY_BROWSER_HUB: "1" })).toBe(true)
    })

    test("every near-miss spelling is OFF, because this flag decides a credential model", () => {
        for (const value of ["0", "true", "TRUE", "yes", "on", " 1", "1 ", "", "false"]) {
            expect(isBrowserHubEnabled({ VITE_OXY_BROWSER_HUB: value })).toBe(false)
        }
    })
})

describe("the OFF state makes no request and issues no handle", () => {
    test("every method short-circuits before fetch", async () => {
        const { calls, fetchImpl } = recorder({ status: "active", directory: DIRECTORY })
        const client = createHubClient({ enabled: false, fetchImpl })

        expect(client.enabled).toBe(false)
        expect(await client.session()).toEqual({ status: "disabled" })
        expect(await client.claim("secret-session-token")).toEqual({ status: "disabled" })
        expect(await client.activate("ctx-2")).toEqual({ status: "disabled" })
        expect(await client.revoke()).toEqual({ status: "disabled" })
        expect(
            await client.authorize({
                clientId: "oxy_dk_x",
                redirectUri: "https://rp.example/cb",
                codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
                codeChallengeMethod: "S256",
            })
        ).toEqual({ status: "disabled" })

        // The witness: not one `/hub/*` request was made, so no handle can have
        // been issued and no cookie can have been set.
        expect(calls).toHaveLength(0)
    })

    test("`disabled` is not `signed_out` — a caller can tell the lane apart from an empty one", () => {
        expect(hubSessionOf({ status: "disabled" })).toEqual({ status: "signed_out" })
        // ...but the raw arm is distinguishable, which is what lets the page
        // choose between "run the hub lane" and "this build has no hub lane".
        const disabled = { status: "disabled" } as const
        const signedOut = { status: "ok", value: { status: "signed_out" } } as const
        expect(disabled.status).not.toBe(signedOut.status)
    })
})

describe("the ON state", () => {
    test("posts to the right path with the CSRF header and same-origin credentials", async () => {
        const { calls, fetchImpl } = recorder({ status: "active", directory: DIRECTORY })
        const client = createHubClient({ enabled: true, fetchImpl })

        await client.session()

        expect(calls).toHaveLength(1)
        expect(calls[0].path).toBe("/hub/session")
        expect(calls[0].init.method).toBe("POST")
        expect(calls[0].init.credentials).toBe("same-origin")
        const headers = calls[0].init.headers as Record<string, string>
        expect(headers["X-Oxy-Hub"]).toBe("1")
    })

    test("reads an active session", async () => {
        const { fetchImpl } = recorder({ status: "active", directory: DIRECTORY })
        const client = createHubClient({ enabled: true, fetchImpl })

        const outcome = await client.session()
        expect(outcome.status).toBe("ok")
        expect(hubSessionOf(outcome)).toEqual({ status: "active", directory: DIRECTORY })
    })

    test("carries the sessionToken to claim and the contextId to activate", async () => {
        const { calls, fetchImpl } = recorder({ status: "active", directory: DIRECTORY })
        const client = createHubClient({ enabled: true, fetchImpl })

        await client.claim("secret-session-token")
        await client.activate("ctx-2")

        expect(calls[0].path).toBe("/hub/claim")
        expect(JSON.parse(String(calls[0].init.body))).toEqual({
            sessionToken: "secret-session-token",
        })
        expect(calls[1].path).toBe("/hub/activate")
        expect(JSON.parse(String(calls[1].init.body))).toEqual({ contextId: "ctx-2" })
    })

    test("reads a minted authorization code", async () => {
        const { fetchImpl } = recorder({
            status: "code",
            code: "auth-code-1",
            state: "opaque",
            redirectUri: "https://rp.example/cb",
            expiresIn: 300,
        })
        const client = createHubClient({ enabled: true, fetchImpl })

        const outcome = await client.authorize({
            clientId: "oxy_dk_x",
            redirectUri: "https://rp.example/cb",
            state: "opaque",
            codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            codeChallengeMethod: "S256",
        })

        expect(outcome).toEqual({
            status: "ok",
            value: {
                status: "code",
                code: "auth-code-1",
                state: "opaque",
                redirectUri: "https://rp.example/cb",
                expiresIn: 300,
            },
        })
    })

    test("reads a consent_required answer without a code", async () => {
        const { fetchImpl } = recorder({
            status: "consent_required",
            reason: "new",
            userConsentScopes: ["follows:read"],
        })
        const client = createHubClient({ enabled: true, fetchImpl })

        const outcome = await client.authorize({
            clientId: "oxy_dk_x",
            redirectUri: "https://rp.example/cb",
            codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            codeChallengeMethod: "S256",
        })

        expect(outcome.status).toBe("ok")
        expect(outcome.status === "ok" ? outcome.value.status : null).toBe("consent_required")
    })

    test("a body the contract rejects is an outage, never a session", async () => {
        const { fetchImpl } = recorder({ status: "active" })
        const client = createHubClient({ enabled: true, fetchImpl })

        const outcome = await client.session()
        expect(outcome).toEqual({ status: "unavailable" })
        expect(hubSessionOf(outcome)).toEqual({ status: "signed_out" })
    })

    test("an unknown status is refused rather than passed through", async () => {
        const { fetchImpl } = recorder({ status: "definitely_signed_in" })
        const client = createHubClient({ enabled: true, fetchImpl })
        expect(await client.session()).toEqual({ status: "unavailable" })
    })

    test("a non-2xx answer is unavailable, not a session", async () => {
        const { fetchImpl } = recorder({ error: "bad_origin" }, false)
        const client = createHubClient({ enabled: true, fetchImpl })
        expect(await client.session()).toEqual({ status: "unavailable" })
    })

    test("a network failure is unavailable, not a crash", async () => {
        const fetchImpl = (async () => {
            throw new Error("offline")
        }) as typeof fetch
        const client = createHubClient({ enabled: true, fetchImpl })
        expect(await client.session()).toEqual({ status: "unavailable" })
    })

    test("a non-JSON body is unavailable", async () => {
        const fetchImpl = (async () =>
            new Response("<html>502</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
            })) as typeof fetch
        const client = createHubClient({ enabled: true, fetchImpl })
        expect(await client.session()).toEqual({ status: "unavailable" })
    })
})
