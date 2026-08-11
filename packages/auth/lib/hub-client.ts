/**
 * The IdP page's client for its own edge layer, `auth.oxy.so/hub/*`
 * (issue #937 Phase 5, ADR 0003).
 *
 * ## The flag, and why the whole lane hangs off one
 *
 * `VITE_OXY_BROWSER_HUB` defaults OFF, and OFF means `auth.oxy.so` behaves
 * byte-for-byte as it does today: the SDK's per-origin `{deviceId,
 * deviceSecret}` in localStorage, the normal cold boot, no `/hub/*` request
 * ever made, no handle ever issued. Merging the hub therefore changes nothing
 * observable, which is what makes it safe to land before anybody has run it in
 * a browser.
 *
 * ON means the hub handle is AUTHORITATIVE at this origin and the per-origin
 * device credential is retired here — `main.tsx` mounts `OxyProvider` with
 * `deviceCredentialStorage="ephemeral"`, so nothing durable is written. It is
 * deliberately not a fallback order: "try the hub, else localStorage" is the
 * same dual authority under a politer name, and its failure mode is a revoked
 * hub that the browser silently survives.
 *
 * **Flipping the flag is the browser-verification gate.** It comes out when
 * somebody has actually run Chrome, Safari and Firefox, private windows, and
 * third-party cookies blocked against this lane — not on reasoning, and not on
 * these tests, which cannot see a cookie jar.
 *
 * ## What crosses this boundary
 *
 * Nothing secret, in either direction. The handle is in an `HttpOnly` cookie
 * the browser attaches and this script cannot read; the device-wide access
 * token never leaves the edge. Everything below therefore sends a body with no
 * credential in it and reads a body with no credential in it.
 */

import {
    hubAuthorizeResultSchema,
    hubSessionSchema,
    safeParseContract,
    type HubAuthorizeRequest,
    type HubAuthorizeResult,
    type HubSession,
} from "@oxyhq/contracts"

/**
 * The env shape the flag is read from — `import.meta.env` in the app, a plain
 * object in a test. Taking it as an argument is what makes the OFF branch
 * testable at all; a module-level read of `import.meta.env` has exactly one
 * value per build and the off path would go unexercised.
 */
export interface BrowserHubEnv {
    VITE_OXY_BROWSER_HUB?: string
}

/**
 * Whether the browser hub lane is enabled for this build.
 *
 * Strictly `"1"`. Anything else — unset, `"0"`, `"true"`, `"yes"`, whitespace —
 * is OFF, because a flag that turns a credential model on deserves one spelling
 * and no guessing at intent.
 */
export function isBrowserHubEnabled(env: BrowserHubEnv): boolean {
    return env.VITE_OXY_BROWSER_HUB === "1"
}

/** The header the edge requires; see `hub/handlers.ts` for why it is a gate. */
const HUB_REQUEST_HEADER = "X-Oxy-Hub"

/** `signed_out` is the honest answer whenever the lane cannot produce a session. */
const SIGNED_OUT: HubSession = { status: "signed_out" }

/**
 * A hub call's outcome.
 *
 * `disabled` is a distinct arm from `signed_out` on purpose: one means the
 * browser has no hub session, the other means this build never asks. Collapsing
 * them would let a caller render a sign-in prompt for a lane that does not
 * exist.
 */
export type HubOutcome<T> =
    | { status: "disabled" }
    | { status: "unavailable" }
    | { status: "ok"; value: T }

export interface HubClient {
    readonly enabled: boolean
    session(): Promise<HubOutcome<HubSession>>
    claim(sessionToken: string): Promise<HubOutcome<HubSession>>
    activate(contextId: string): Promise<HubOutcome<HubSession>>
    authorize(request: HubAuthorizeRequest): Promise<HubOutcome<HubAuthorizeResult>>
    revoke(): Promise<HubOutcome<HubSession>>
}

interface HubClientOptions {
    enabled: boolean
    /** Injected so a test can assert the OFF branch makes no request at all. */
    fetchImpl?: typeof fetch
}

/**
 * Build the client.
 *
 * Every method short-circuits to `disabled` BEFORE touching `fetch` when the
 * flag is off — the one behaviour the off-state test pins, since a feature flag
 * whose off-branch is untested is just a second code path nobody looks at.
 */
export function createHubClient({ enabled, fetchImpl }: HubClientOptions): HubClient {
    const doFetch = fetchImpl ?? globalThis.fetch

    async function post<T>(
        path: string,
        body: unknown,
        parse: (value: unknown) => T | null
    ): Promise<HubOutcome<T>> {
        if (!enabled) return { status: "disabled" }

        let response: Response
        try {
            response = await doFetch(path, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    [HUB_REQUEST_HEADER]: "1",
                },
                // The handle is a first-party cookie on THIS origin. `same-origin`
                // is the default for a relative URL, and it is stated rather than
                // assumed because the whole lane depends on the cookie riding.
                credentials: "same-origin",
                body: JSON.stringify(body),
            })
        } catch {
            return { status: "unavailable" }
        }

        if (!response.ok) return { status: "unavailable" }

        let payload: unknown
        try {
            payload = await response.json()
        } catch {
            return { status: "unavailable" }
        }

        const parsed = parse(payload)
        // A body the contract rejects is an outage, never coerced and never read
        // as a session — the caller then behaves as if the hub were unreachable,
        // which is the safe direction.
        return parsed === null ? { status: "unavailable" } : { status: "ok", value: parsed }
    }

    const parseSession = (value: unknown) => safeParseContract(hubSessionSchema, value)
    const parseAuthorize = (value: unknown) =>
        safeParseContract(hubAuthorizeResultSchema, value)

    return {
        enabled,
        session: () => post("/hub/session", {}, parseSession),
        claim: (sessionToken) => post("/hub/claim", { sessionToken }, parseSession),
        activate: (contextId) => post("/hub/activate", { contextId }, parseSession),
        authorize: (request) => post("/hub/authorize", request, parseAuthorize),
        revoke: () => post("/hub/revoke", {}, parseSession),
    }
}

/**
 * Read a hub outcome as a session, treating every non-`ok` arm as signed out.
 *
 * The distinction between `disabled`, `unavailable` and a real `signed_out`
 * matters to the caller deciding whether the lane applies at all; it does not
 * matter to a surface that only needs "is there a session to render". This is
 * the one place the collapse happens, so it cannot happen inconsistently.
 */
export function hubSessionOf(outcome: HubOutcome<HubSession>): HubSession {
    return outcome.status === "ok" ? outcome.value : SIGNED_OUT
}

/** The app's client, built from the build's own flag. */
export const hubClient: HubClient = createHubClient({
    enabled: isBrowserHubEnabled(import.meta.env as BrowserHubEnv),
})
