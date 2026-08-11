/**
 * `auth.oxy.so/hub/*` — the edge layer, against a stubbed API.
 *
 * `fetch` is replaced with a recorder so every assertion is about what the edge
 * ITSELF does: which CSRF gates it enforces, what it puts in the cookie, what it
 * refuses to put in a response body, and whether it can be made to mint an
 * authorization code without the consent the server asked for. The API's own
 * behaviour is held by `packages/api/src/routes/__tests__/browserHub.test.ts`
 * against a real Postgres.
 *
 * The recurring assertion, and the one worth restating: no response body ever
 * contains the hub handle or the device-wide access token. Both cross this layer
 * on every call; neither may cross it outward.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
    handleHubActivate,
    handleHubAuthorize,
    handleHubClaim,
    handleHubRevoke,
    handleHubRotate,
    handleHubSession,
} from "../handlers"
import type { HubEnv } from "../upstream"

const ORIGIN = "https://auth.oxy.so"
const ENV: HubEnv = { OXY_API_URL: "https://api.test" }
const HANDLE = "handle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const NEXT_HANDLE = "handle-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const ACCESS_TOKEN = "device-wide-access-token-value"

const DIRECTORY = {
    deviceId: "dev-1",
    revision: 7,
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
                    kind: "personal" as const,
                    relationship: "self" as const,
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

interface Recorded {
    url: string
    method: string
    body: unknown
    authorization: string | null
}

type Responder = (call: Recorded) => { status: number; body: unknown }

let calls: Recorded[] = []
let responder: Responder
const realFetch = globalThis.fetch

beforeEach(() => {
    calls = []
    responder = () => ({ status: 500, body: { error: "no_responder" } })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        const headers = new Headers(init?.headers)
        const call: Recorded = {
            url,
            method: init?.method ?? "GET",
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
            authorization: headers.get("authorization"),
        }
        calls.push(call)
        const { status, body } = responder(call)
        return new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        })
    }) as typeof fetch
})

afterEach(() => {
    globalThis.fetch = realFetch
})

/** A well-formed hub request: correct method, origin, fetch metadata and header. */
function hubRequest(
    path: string,
    options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}
): Request {
    const headers: Record<string, string> = {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "x-oxy-hub": "1",
        "content-type": "application/json",
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.headers ?? {}),
    }
    return new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(options.body ?? {}),
    })
}

const withHandle = (path: string, body?: unknown) =>
    hubRequest(path, { body, cookie: `__Host-oxy-device=${HANDLE}` })

/** Answer `/session/browser-hub/resolve` with a live device session. */
function respondResolved(extra?: Responder): void {
    responder = (call) => {
        if (call.url.endsWith("/session/browser-hub/resolve")) {
            return {
                status: 200,
                body: {
                    data: {
                        accessToken: ACCESS_TOKEN,
                        expiresAt: "2026-08-11T00:00:00.000Z",
                        directory: DIRECTORY,
                    },
                },
            }
        }
        return extra ? extra(call) : { status: 500, body: { error: "unexpected" } }
    }
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>
}

/**
 * The single `Set-Cookie` line, or null.
 *
 * Read through `getSetCookie()` rather than `headers.get('set-cookie')`:
 * `Set-Cookie` is the one header the Fetch spec forbids `get()` from combining,
 * and the accessor is the only one guaranteed to see it. Asserting there is
 * exactly one also means a second `Set-Cookie` — a handler writing the cookie
 * twice, or writing a stray one — fails here rather than silently winning.
 */
function setCookieOf(response: Response): string | null {
    const all = response.headers.getSetCookie()
    expect(all.length).toBeLessThanOrEqual(1)
    return all[0] ?? null
}

/** Neither credential may ever appear in what the browser receives. */
async function expectNoCredentialLeak(response: Response): Promise<void> {
    const raw = await response.clone().text()
    expect(raw).not.toContain(ACCESS_TOKEN)
    expect(raw).not.toContain(HANDLE)
    expect(raw).not.toContain(NEXT_HANDLE)
}

describe("the CSRF gates", () => {
    const handlers = [
        ["session", handleHubSession],
        ["claim", handleHubClaim],
        ["rotate", handleHubRotate],
        ["revoke", handleHubRevoke],
        ["activate", handleHubActivate],
        ["authorize", handleHubAuthorize],
    ] as const

    test("every endpoint refuses a GET", async () => {
        for (const [name, handler] of handlers) {
            const request = new Request(`${ORIGIN}/hub/${name}`, {
                method: "GET",
                headers: { origin: ORIGIN, "x-oxy-hub": "1" },
            })
            const response = await handler(request, ENV)
            expect(response.status).toBe(405)
        }
        expect(calls).toHaveLength(0)
    })

    test("every endpoint refuses a cross-site Origin", async () => {
        for (const [name, handler] of handlers) {
            const request = new Request(`${ORIGIN}/hub/${name}`, {
                method: "POST",
                headers: {
                    origin: "https://evil.example",
                    "x-oxy-hub": "1",
                    cookie: `__Host-oxy-device=${HANDLE}`,
                },
                body: "{}",
            })
            const response = await handler(request, ENV)
            expect(response.status).toBe(403)
        }
        expect(calls).toHaveLength(0)
    })

    test("every endpoint refuses a MISSING Origin", async () => {
        // Browsers attach `Origin` to every non-GET request, so absent is an
        // anomaly here rather than the `curl` case the API's own guard tolerates.
        for (const [name, handler] of handlers) {
            const request = new Request(`${ORIGIN}/hub/${name}`, {
                method: "POST",
                headers: { "x-oxy-hub": "1", cookie: `__Host-oxy-device=${HANDLE}` },
                body: "{}",
            })
            const response = await handler(request, ENV)
            expect(response.status).toBe(403)
        }
        expect(calls).toHaveLength(0)
    })

    test("every endpoint refuses a cross-site Sec-Fetch-Site", async () => {
        for (const [name, handler] of handlers) {
            const request = hubRequest(`/hub/${name}`, {
                cookie: `__Host-oxy-device=${HANDLE}`,
                headers: { "sec-fetch-site": "cross-site" },
            })
            const response = await handler(request, ENV)
            expect(response.status).toBe(403)
        }
        expect(calls).toHaveLength(0)
    })

    test("every endpoint refuses a request without the custom header", async () => {
        // The header is what a form POST, an <img> or sendBeacon cannot set, and
        // what forces a CORS preflight this layer never answers.
        for (const [name, handler] of handlers) {
            const request = new Request(`${ORIGIN}/hub/${name}`, {
                method: "POST",
                headers: {
                    origin: ORIGIN,
                    "sec-fetch-site": "same-origin",
                    cookie: `__Host-oxy-device=${HANDLE}`,
                },
                body: "{}",
            })
            const response = await handler(request, ENV)
            expect(response.status).toBe(403)
        }
        expect(calls).toHaveLength(0)
    })
})

describe("POST /hub/session", () => {
    test("reports signed_out with no cookie, and calls nothing upstream", async () => {
        const response = await handleHubSession(hubRequest("/hub/session"), ENV)
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
        expect(calls).toHaveLength(0)
        expect(setCookieOf(response)).toBeNull()
    })

    test("returns the directory and NEITHER credential", async () => {
        respondResolved()
        const response = await handleHubSession(withHandle("/hub/session"), ENV)
        const body = await bodyOf(response)
        expect(body.status).toBe("active")
        expect(body.directory).toEqual(DIRECTORY)
        expect(body).not.toHaveProperty("accessToken")
        await expectNoCredentialLeak(response)
    })

    test("forwards the cookie's handle upstream, and only there", async () => {
        respondResolved()
        await handleHubSession(withHandle("/hub/session"), ENV)
        expect(calls[0].url).toBe("https://api.test/session/browser-hub/resolve")
        expect(calls[0].body).toEqual({ handle: HANDLE })
    })

    test("an invalid handle clears the cookie", async () => {
        responder = () => ({ status: 401, body: { error: "invalid_handle" } })
        const response = await handleHubSession(withHandle("/hub/session"), ENV)
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
        expect(setCookieOf(response)).toBe(
            "__Host-oxy-device=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
        )
    })

    test("a live handle with nothing signed in KEEPS the cookie", async () => {
        // The credential is fine; the device simply has no active session. Clearing
        // here would throw away a working hub on an ordinary sign-out.
        responder = () => ({ status: 401, body: { error: "no_active_session" } })
        const response = await handleHubSession(withHandle("/hub/session"), ENV)
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
        expect(setCookieOf(response)).toBeNull()
    })

    test("an upstream outage does not clear the cookie either", async () => {
        responder = () => ({ status: 503, body: { error: "gateway" } })
        const response = await handleHubSession(withHandle("/hub/session"), ENV)
        expect(setCookieOf(response)).toBeNull()
    })

    test("never caches, and never frames", async () => {
        respondResolved()
        const response = await handleHubSession(withHandle("/hub/session"), ENV)
        expect(response.headers.get("cache-control")).toBe("no-store")
        expect(response.headers.get("x-frame-options")).toBe("DENY")
        expect(response.headers.get("vary")).toBe("Cookie")
    })
})

describe("POST /hub/claim", () => {
    function respondClaimLane(): void {
        responder = (call) => {
            if (call.url.endsWith("/auth/session/claim")) {
                return {
                    status: 200,
                    body: {
                        data: {
                            accessToken: ACCESS_TOKEN,
                            sessionId: "sess-1",
                            deviceId: "dev-1",
                            expiresAt: "2026-08-11T00:00:00.000Z",
                            // The claim also mints this. The edge must not keep it.
                            deviceSecret: "device-secret-that-must-not-travel",
                            user: { id: "user-1" },
                        },
                    },
                }
            }
            if (call.url.endsWith("/session/device/add")) {
                return {
                    status: 200,
                    body: {
                        data: {
                            state: {
                                deviceId: "dev-1",
                                accounts: [{ accountId: "user-1", sessionId: "sess-1", authuser: 0 }],
                                activeAccountId: "user-1",
                                revision: 7,
                                updatedAt: 1_760_000_000_000,
                            },
                            activeToken: {
                                accessToken: ACCESS_TOKEN,
                                expiresAt: "2026-08-11T00:00:00.000Z",
                            },
                        },
                    },
                }
            }
            if (call.url.endsWith("/session/browser-hub/establish")) {
                return {
                    status: 200,
                    body: { data: { handle: NEXT_HANDLE, expiresAt: "2026-09-10T00:00:00.000Z" } },
                }
            }
            if (call.url.endsWith("/session/browser-hub/resolve")) {
                return {
                    status: 200,
                    body: {
                        data: {
                            accessToken: ACCESS_TOKEN,
                            expiresAt: "2026-08-11T00:00:00.000Z",
                            directory: DIRECTORY,
                        },
                    },
                }
            }
            return { status: 500, body: { error: "unexpected" } }
        }
    }

    test("claims, registers the device, establishes the hub, and sets the cookie", async () => {
        respondClaimLane()
        const response = await handleHubClaim(
            hubRequest("/hub/claim", { body: { sessionToken: "secret-session-token" } }),
            ENV
        )

        expect(calls.map((c) => c.url)).toEqual([
            "https://api.test/auth/session/claim",
            "https://api.test/session/device/add",
            "https://api.test/session/browser-hub/establish",
            "https://api.test/session/browser-hub/resolve",
        ])
        // Every step after the claim carries the bearer the claim produced.
        expect(calls[1].authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
        expect(calls[2].authorization).toBe(`Bearer ${ACCESS_TOKEN}`)

        expect(setCookieOf(response)).toBe(
            `__Host-oxy-device=${NEXT_HANDLE}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
        )
        const body = await bodyOf(response)
        expect(body.status).toBe("active")
        await expectNoCredentialLeak(response)
    })

    test("the deviceSecret the claim mints never reaches the browser", async () => {
        respondClaimLane()
        const response = await handleHubClaim(
            hubRequest("/hub/claim", { body: { sessionToken: "secret-session-token" } }),
            ENV
        )
        const raw = await response.text()
        expect(raw).not.toContain("device-secret-that-must-not-travel")
        expect(setCookieOf(response)).not.toContain(
            "device-secret-that-must-not-travel"
        )
    })

    test("a rejected sessionToken sets no cookie", async () => {
        responder = () => ({ status: 401, body: { error: "invalid_grant" } })
        const response = await handleHubClaim(
            hubRequest("/hub/claim", { body: { sessionToken: "replayed" } }),
            ENV
        )
        expect(response.status).toBe(400)
        expect(setCookieOf(response)).toBeNull()
    })

    test("a missing sessionToken is refused before any upstream call", async () => {
        const response = await handleHubClaim(hubRequest("/hub/claim", { body: {} }), ENV)
        expect(response.status).toBe(400)
        expect(calls).toHaveLength(0)
    })
})

describe("POST /hub/rotate", () => {
    test("replaces the cookie with the new handle", async () => {
        responder = (call) => {
            if (call.url.endsWith("/session/browser-hub/rotate")) {
                expect(call.body).toEqual({ handle: HANDLE })
                return {
                    status: 200,
                    body: { data: { handle: NEXT_HANDLE, expiresAt: "2026-09-10T00:00:00.000Z" } },
                }
            }
            return {
                status: 200,
                body: {
                    data: {
                        accessToken: ACCESS_TOKEN,
                        expiresAt: "2026-08-11T00:00:00.000Z",
                        directory: DIRECTORY,
                    },
                },
            }
        }
        const response = await handleHubRotate(withHandle("/hub/rotate"), ENV)
        expect(setCookieOf(response)).toContain(
            `__Host-oxy-device=${NEXT_HANDLE};`
        )
        await expectNoCredentialLeak(response)
    })

    test("a dead handle clears the cookie instead of rotating", async () => {
        responder = () => ({ status: 401, body: { error: "invalid_handle" } })
        const response = await handleHubRotate(withHandle("/hub/rotate"), ENV)
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
        expect(setCookieOf(response)).toContain("Max-Age=0")
    })
})

describe("POST /hub/revoke", () => {
    test("revokes upstream and clears the cookie", async () => {
        responder = () => ({ status: 200, body: { data: { revoked: true } } })
        const response = await handleHubRevoke(withHandle("/hub/revoke"), ENV)
        expect(calls[0].url).toBe("https://api.test/session/browser-hub/revoke")
        expect(calls[0].body).toEqual({ handle: HANDLE })
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
        expect(setCookieOf(response)).toContain("Max-Age=0")
    })

    test("clears the cookie even when the upstream call fails", async () => {
        responder = () => ({ status: 503, body: { error: "gateway" } })
        const response = await handleHubRevoke(withHandle("/hub/revoke"), ENV)
        expect(setCookieOf(response)).toContain("Max-Age=0")
    })

    test("is a no-op with no cookie, and still reports signed out", async () => {
        const response = await handleHubRevoke(hubRequest("/hub/revoke"), ENV)
        expect(calls).toHaveLength(0)
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
    })
})

describe("POST /hub/activate", () => {
    test("forwards the contextId with the browser's own bearer", async () => {
        respondResolved((call) => {
            if (call.url.endsWith("/session/device/activate")) {
                expect(call.body).toEqual({ contextId: "ctx-2" })
                expect(call.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
                return {
                    status: 200,
                    body: {
                        data: {
                            directory: { ...DIRECTORY, activeContextId: "ctx-2", revision: 8 },
                            activeToken: {
                                accessToken: ACCESS_TOKEN,
                                expiresAt: "2026-08-11T00:00:00.000Z",
                            },
                        },
                    },
                }
            }
            return { status: 500, body: { error: "unexpected" } }
        })
        const response = await handleHubActivate(
            withHandle("/hub/activate", { contextId: "ctx-2" }),
            ENV
        )
        const body = await bodyOf(response)
        expect(body.status).toBe("active")
        expect((body.directory as { activeContextId: string }).activeContextId).toBe("ctx-2")
        await expectNoCredentialLeak(response)
    })

    test("reports signed_out without a hub session", async () => {
        const response = await handleHubActivate(
            hubRequest("/hub/activate", { body: { contextId: "ctx-2" } }),
            ENV
        )
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
        expect(calls).toHaveLength(0)
    })
})

describe("POST /hub/authorize — a later official origin joining", () => {
    const JOIN = {
        clientId: "oxy_dk_mercaria",
        redirectUri: "https://mercaria.example/callback",
        state: "opaque-state",
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        codeChallengeMethod: "S256" as const,
        scope: "openid profile",
    }

    test("mints a code with no QR when the app is trusted", async () => {
        respondResolved((call) => {
            if (call.url.includes("/auth/oauth/consent")) {
                expect(call.authorization).toBe(`Bearer ${ACCESS_TOKEN}`)
                return { status: 200, body: { data: { consentRequired: false, reason: "trusted" } } }
            }
            if (call.url.endsWith("/auth/oauth/authorize")) {
                expect(call.body).toEqual({
                    clientId: JOIN.clientId,
                    redirectUri: JOIN.redirectUri,
                    state: JOIN.state,
                    codeChallenge: JOIN.codeChallenge,
                    codeChallengeMethod: "S256",
                    scope: JOIN.scope,
                })
                return {
                    status: 200,
                    body: {
                        data: {
                            code: "auth-code-1",
                            state: JOIN.state,
                            redirectUri: JOIN.redirectUri,
                            expiresIn: 300,
                        },
                    },
                }
            }
            return { status: 500, body: { error: "unexpected" } }
        })

        const response = await handleHubAuthorize(withHandle("/hub/authorize", JOIN), ENV)
        expect(await bodyOf(response)).toEqual({
            status: "code",
            code: "auth-code-1",
            state: JOIN.state,
            redirectUri: JOIN.redirectUri,
            expiresIn: 300,
        })
        await expectNoCredentialLeak(response)
    })

    test("asks for consent and mints NOTHING when the server says to ask", async () => {
        respondResolved((call) => {
            if (call.url.includes("/auth/oauth/consent")) {
                return {
                    status: 200,
                    body: {
                        data: {
                            consentRequired: true,
                            reason: "new",
                            userConsentScopes: ["follows:read"],
                        },
                    },
                }
            }
            return { status: 500, body: { error: "must_not_be_called" } }
        })

        const response = await handleHubAuthorize(withHandle("/hub/authorize", JOIN), ENV)
        expect(await bodyOf(response)).toEqual({
            status: "consent_required",
            reason: "new",
            userConsentScopes: ["follows:read"],
        })
        expect(calls.some((c) => c.url.endsWith("/auth/oauth/authorize"))).toBe(false)
    })

    test("re-reads the consent decision on the approving pass rather than trusting the client", async () => {
        let consentCalls = 0
        respondResolved((call) => {
            if (call.url.includes("/auth/oauth/consent")) {
                consentCalls += 1
                return {
                    status: 200,
                    body: { data: { consentRequired: true, reason: "new" } },
                }
            }
            if (call.url.endsWith("/auth/oauth/authorize")) {
                return {
                    status: 200,
                    body: {
                        data: {
                            code: "auth-code-2",
                            state: null,
                            redirectUri: JOIN.redirectUri,
                            expiresIn: 300,
                        },
                    },
                }
            }
            return { status: 500, body: { error: "unexpected" } }
        })

        const response = await handleHubAuthorize(
            withHandle("/hub/authorize", { ...JOIN, state: undefined, approve: true }),
            ENV
        )
        expect(consentCalls).toBe(1)
        expect((await bodyOf(response)).status).toBe("code")
    })

    test("refuses a non-S256 challenge before anything upstream runs", async () => {
        const response = await handleHubAuthorize(
            withHandle("/hub/authorize", { ...JOIN, codeChallengeMethod: "plain" }),
            ENV
        )
        expect(response.status).toBe(400)
        expect(calls).toHaveLength(0)
    })

    test("a `prompt` field cannot travel — the request schema has none", async () => {
        // Zod strips unknown keys, so a caller trying to smuggle `prompt=none`
        // gets an ordinary request. The assertion is on what reaches the API.
        respondResolved((call) => {
            if (call.url.includes("/auth/oauth/consent")) {
                return { status: 200, body: { data: { consentRequired: false, reason: "trusted" } } }
            }
            return {
                status: 200,
                body: {
                    data: {
                        code: "auth-code-3",
                        state: JOIN.state,
                        redirectUri: JOIN.redirectUri,
                        expiresIn: 300,
                    },
                },
            }
        })
        await handleHubAuthorize(
            withHandle("/hub/authorize", { ...JOIN, prompt: "none" }),
            ENV
        )
        const authorizeCall = calls.find((c) => c.url.endsWith("/auth/oauth/authorize"))
        expect(authorizeCall?.body).not.toHaveProperty("prompt")
        const consentCall = calls.find((c) => c.url.includes("/auth/oauth/consent"))
        expect(consentCall?.url).not.toContain("prompt")
    })

    test("a browser with no hub session is told so, and no redirect is issued", async () => {
        const response = await handleHubAuthorize(hubRequest("/hub/authorize", { body: JOIN }), ENV)
        expect(response.status).toBe(200)
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
        // A 3xx here would be an automatic redirect chain across Oxy origins.
        expect(response.headers.get("location")).toBeNull()
        expect(calls).toHaveLength(0)
    })

    test("an unregistered redirect_uri is reported, never followed", async () => {
        respondResolved((call) => {
            if (call.url.includes("/auth/oauth/consent")) {
                return { status: 403, body: { error: { code: "FORBIDDEN" } } }
            }
            return { status: 500, body: { error: "unexpected" } }
        })
        const response = await handleHubAuthorize(withHandle("/hub/authorize", JOIN), ENV)
        expect(response.status).toBe(400)
        expect(response.headers.get("location")).toBeNull()
    })

    test("an upstream 401 is not passed through as a 401", async () => {
        // The browser's credential here is the cookie, not a bearer. Surfacing the
        // API's 401 would make the SPA's fetch layer think ITS credentials were
        // rejected and start a sign-out it has no business starting.
        respondResolved((call) => {
            if (call.url.includes("/auth/oauth/consent")) {
                return { status: 401, body: { error: "Authentication required" } }
            }
            return { status: 500, body: { error: "unexpected" } }
        })
        const response = await handleHubAuthorize(withHandle("/hub/authorize", JOIN), ENV)
        expect(response.status).toBe(400)
    })
})

describe("upstream contract validation", () => {
    test("a resolve payload that does not match the contract is not coerced", async () => {
        responder = () => ({
            status: 200,
            body: { data: { accessToken: ACCESS_TOKEN, expiresAt: "x" } },
        })
        const response = await handleHubSession(withHandle("/hub/session"), ENV)
        // A missing directory reads as "no session", never as an empty one.
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
    })

    test("a non-JSON upstream body is an outage, not a verdict", async () => {
        globalThis.fetch = (async () =>
            new Response("<html>502</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
            })) as typeof fetch
        const response = await handleHubSession(withHandle("/hub/session"), ENV)
        expect(await bodyOf(response)).toEqual({ status: "signed_out" })
        expect(setCookieOf(response)).toBeNull()
    })
})
