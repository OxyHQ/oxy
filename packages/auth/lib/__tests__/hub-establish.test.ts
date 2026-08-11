/**
 * The hub establishment lane — one Commons approval becoming a browser session.
 *
 * The assertions that matter are about the SECRET and about single-shot claim:
 * the `sessionToken` must never appear in anything renderable, and an ambiguous
 * claim must never be retried, because the server spends the request atomically
 * and a retry burns a fresh one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
    HubEstablishRequest,
    type HubEstablishDeps,
    type HubEstablishSnapshot,
} from "@/lib/hub-establish"

const SESSION_TOKEN = "secret-session-token-never-rendered"

const DIRECTORY = {
    deviceId: "dev-1",
    revision: 1,
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

/**
 * The cadence these cases run at. The product default is 3 s, which is a
 * statement about how fast a QR should react and not something a state-machine
 * suite should sit through.
 */
const TEST_POLL_INTERVAL_MS = 5

/** Advance past one poll tick. */
async function tick(): Promise<void> {
    await Bun.sleep(TEST_POLL_INTERVAL_MS + 20)
}

interface Harness {
    deps: HubEstablishDeps
    claims: string[]
    polls: number
    setAuthorized(): void
    setStatus(status: string): void
}

function harness(claimResult?: Awaited<ReturnType<HubEstablishDeps["hub"]["claim"]>>): Harness {
    const state = { authorized: false, status: "pending" }
    const claims: string[] = []
    const h: Harness = {
        polls: 0,
        claims,
        setAuthorized() {
            state.authorized = true
            state.status = "authorized"
        },
        setStatus(status: string) {
            state.status = status
        },
        deps: {
            pollIntervalMs: TEST_POLL_INTERVAL_MS,
            startCommonsSignIn: async () => ({
                sessionToken: SESSION_TOKEN,
                authorizeCode: "public-authorize-code",
                qrPayload: "oxycommons://approve?v=1&code=public-authorize-code",
                expiresAt: Date.now() + 300_000,
                status: "pending",
            }),
            pollSessionStatus: async () => {
                h.polls += 1
                return { authorized: state.authorized, status: state.status }
            },
            hub: {
                claim: async (token: string) => {
                    claims.push(token)
                    return (
                        claimResult ?? {
                            status: "ok" as const,
                            value: { status: "active" as const, directory: DIRECTORY },
                        }
                    )
                },
            },
        },
    }
    return h
}

let requests: HubEstablishRequest[] = []

beforeEach(() => {
    requests = []
})

afterEach(() => {
    for (const request of requests) request.cancel()
})

function make(h: Harness): HubEstablishRequest {
    const request = new HubEstablishRequest(h.deps, "oxy_dk_auth")
    requests.push(request)
    return request
}

function snapshots(request: HubEstablishRequest): HubEstablishSnapshot[] {
    const seen: HubEstablishSnapshot[] = []
    request.subscribe((s) => seen.push(s))
    return seen
}

describe("the secret never becomes renderable state", () => {
    test("no snapshot, at any phase, carries the sessionToken", async () => {
        const h = harness()
        const request = make(h)
        const seen = snapshots(request)

        await request.start()
        h.setAuthorized()
        await tick()

        expect(seen.length).toBeGreaterThan(0)
        for (const snapshot of seen) {
            expect(JSON.stringify(snapshot)).not.toContain(SESSION_TOKEN)
        }
        // The public half IS exposed — that is what the QR renders.
        expect(request.getSnapshot().authorizeCode).toBe("public-authorize-code")
        expect(request.getSnapshot().qrPayload).toContain("public-authorize-code")
    })

    test("the token reaches /hub/claim and nowhere else", async () => {
        const h = harness()
        const request = make(h)
        await request.start()
        h.setAuthorized()
        await tick()

        expect(h.claims).toEqual([SESSION_TOKEN])
    })
})

describe("the happy path", () => {
    test("waits, claims, and lands on an active session", async () => {
        const h = harness()
        const request = make(h)

        await request.start()
        expect(request.getSnapshot().phase).toBe("waiting")

        h.setAuthorized()
        await tick()

        const snapshot = request.getSnapshot()
        expect(snapshot.phase).toBe("established")
        expect(snapshot.session).toEqual({ status: "active", directory: DIRECTORY })
        expect(snapshot.error).toBeNull()
    })

    test("keeps polling while the request is pending", async () => {
        const h = harness()
        const request = make(h)
        await request.start()
        await tick()
        await tick()

        expect(h.polls).toBeGreaterThanOrEqual(2)
        expect(request.getSnapshot().phase).toBe("waiting")
        expect(h.claims).toHaveLength(0)
    })
})

describe("single-shot claim", () => {
    test("a failed claim is NOT retried — recovery is a brand-new request", async () => {
        const h = harness({ status: "unavailable" })
        const request = make(h)

        await request.start()
        h.setAuthorized()
        await tick()
        await tick()
        await tick()

        expect(request.getSnapshot().phase).toBe("failed")
        expect(request.getSnapshot().error).toBe("claim_failed")
        // Exactly one attempt, ever. A second would burn a fresh request if the
        // first had in fact been spent.
        expect(h.claims).toHaveLength(1)
    })

    test("a hub that answers signed_out is a failure, not an empty success", async () => {
        const h = harness({ status: "ok", value: { status: "signed_out" } })
        const request = make(h)

        await request.start()
        h.setAuthorized()
        await tick()

        expect(request.getSnapshot().phase).toBe("failed")
        expect(request.getSnapshot().session).toBeNull()
    })
})

describe("terminal outcomes", () => {
    test("a declined request stops and says so", async () => {
        const h = harness()
        const request = make(h)
        await request.start()
        h.setStatus("cancelled")
        await tick()

        expect(request.getSnapshot().phase).toBe("failed")
        expect(request.getSnapshot().error).toBe("declined")
        expect(h.claims).toHaveLength(0)
    })

    test("an expired request stops and says so", async () => {
        const h = harness()
        const request = make(h)
        await request.start()
        h.setStatus("expired")
        await tick()

        expect(request.getSnapshot().error).toBe("expired")
    })

    test("a failure to create the request never starts a poll", async () => {
        const h = harness()
        const failing: HubEstablishDeps = {
            ...h.deps,
            startCommonsSignIn: async () => {
                throw new Error("network")
            },
        }
        const request = new HubEstablishRequest(failing, "oxy_dk_auth")
        requests.push(request)

        await request.start()
        await tick()

        expect(request.getSnapshot().phase).toBe("failed")
        expect(request.getSnapshot().error).toBe("request_failed")
        expect(h.polls).toBe(0)
    })

    test("a transient poll failure retries rather than settling", async () => {
        const h = harness()
        let first = true
        const flaky: HubEstablishDeps = {
            ...h.deps,
            pollSessionStatus: async () => {
                h.polls += 1
                if (first) {
                    first = false
                    throw new Error("blip")
                }
                return { authorized: true, status: "authorized" }
            },
        }
        const request = new HubEstablishRequest(flaky, "oxy_dk_auth")
        requests.push(request)

        await request.start()
        await tick()
        await tick()

        expect(request.getSnapshot().phase).toBe("established")
    })

    test("cancel stops the poll and is safe to repeat", async () => {
        const h = harness()
        const request = make(h)
        await request.start()
        request.cancel()
        request.cancel()

        const pollsAtCancel = h.polls
        await tick()
        await tick()

        expect(h.polls).toBe(pollsAtCancel)
        expect(h.claims).toHaveLength(0)
    })

    test("start is idempotent per instance", async () => {
        const h = harness()
        const request = make(h)
        await request.start()
        await request.start()
        expect(request.getSnapshot().authorizeCode).toBe("public-authorize-code")
    })
})
