/**
 * Establishing the browser hub from one Commons approval (issue #937 Phase 5,
 * ADR 0003).
 *
 * This is step 3 through 8 of the issue's fresh-browser flow: create ONE
 * `AuthSession`, let the person approve it in Commons, and turn that approval
 * into a first-party browser DeviceSession at `auth.oxy.so`. The approving
 * person becomes a principal of this browser and their personal context becomes
 * active; the browser is handed a handle. Only then does the relying party get
 * its code, from `/hub/authorize`, which is a separate step this module does not
 * perform.
 *
 * ## Why this is NOT `lib/commons-oauth-request.ts`
 *
 * That module runs an OAuth-BOUND request: the `AuthSession` carries the PKCE
 * binding, Commons approves it, and it finalizes straight into an authorization
 * code. The server refuses to claim such a session for an access token, on
 * purpose — an OAuth approval mints no session, ever. So it cannot establish a
 * hub, and the two lanes are different requests rather than one with a flag.
 *
 * The request here is an ordinary `device_sign_in`, and the thing it produces is
 * a browser session rather than a code.
 *
 * ## The secret, and where it goes
 *
 * `sessionToken` is the secret claim credential. It is held in a private field,
 * never returned in {@link HubEstablishSnapshot}, never rendered, and never in
 * the QR — only the public `authorizeCode`/`qrPayload` are. Its ONE destination
 * is `POST /hub/claim`, same-origin, where the edge spends it server-side and
 * discards the access token and device secret it yields. The page never sees
 * either.
 *
 * ## Single-shot, like the OAuth lane and for the same reason
 *
 * The server spends the request atomically, so a blind retry on an ambiguous
 * failure burns it. `claimStarted` is set BEFORE the call and never cleared;
 * recovery is a brand-new request, never a second claim of the old one.
 */

import type { CommonsSignInHandle, CommonsSignInStatus } from "@oxyhq/core"
import type { HubClient } from "@/lib/hub-client"
import type { HubSession } from "@oxyhq/contracts"

/** Poll cadence, matching the OAuth lane — this page bundles no socket client. */
export const HUB_ESTABLISH_POLL_INTERVAL_MS = 3000

/** What the view may render. Deliberately carries no secret. */
export interface HubEstablishSnapshot {
    phase: "idle" | "requesting" | "waiting" | "claiming" | "established" | "failed"
    /** The PUBLIC single-use handle in the QR. */
    authorizeCode: string | null
    /** Ready-to-render `oxycommons://approve?...` deep link. */
    qrPayload: string | null
    /** Server-authoritative expiry, epoch ms. */
    expiresAt: number | null
    /** Set once the browser holds a hub session. */
    session: HubSession | null
    /** A terminal, user-facing reason. */
    error: string | null
}

/** The SDK surface this lane needs. Injected so the module is testable alone. */
export interface HubEstablishDeps {
    startCommonsSignIn(params: { clientId: string }): Promise<CommonsSignInHandle>
    pollSessionStatus(sessionToken: string): Promise<CommonsSignInStatus>
    hub: Pick<HubClient, "claim">
    /**
     * Poll cadence. Configuration, not a test hook: the page's 3 s default is a
     * product choice about how fast a QR reacts, and a suite that had to wait it
     * out would spend a minute proving a state machine.
     */
    pollIntervalMs?: number
}

const IDLE: HubEstablishSnapshot = {
    phase: "idle",
    authorizeCode: null,
    qrPayload: null,
    expiresAt: null,
    session: null,
    error: null,
}

/**
 * One establishment attempt, as a small observable state machine.
 *
 * `subscribe` returns an unsubscribe; `cancel` stops the poll and is safe to
 * call at any point, including after settlement.
 */
export class HubEstablishRequest {
    private snapshot: HubEstablishSnapshot = IDLE
    private readonly listeners = new Set<(s: HubEstablishSnapshot) => void>()
    /** The SECRET. Never in the snapshot, never rendered, never in the QR. */
    private sessionToken: string | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private claimStarted = false
    private settled = false

    constructor(
        private readonly deps: HubEstablishDeps,
        private readonly clientId: string
    ) {}

    getSnapshot(): HubEstablishSnapshot {
        return this.snapshot
    }

    subscribe(listener: (s: HubEstablishSnapshot) => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    private emit(next: Partial<HubEstablishSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...next }
        for (const listener of this.listeners) listener(this.snapshot)
    }

    /** Create the request and begin polling. Idempotent per instance. */
    async start(): Promise<void> {
        if (this.snapshot.phase !== "idle") return
        this.emit({ phase: "requesting" })

        let handle: CommonsSignInHandle
        try {
            handle = await this.deps.startCommonsSignIn({ clientId: this.clientId })
        } catch {
            this.fail("request_failed")
            return
        }

        this.sessionToken = handle.sessionToken
        this.emit({
            phase: "waiting",
            authorizeCode: handle.authorizeCode,
            qrPayload: handle.qrPayload,
            expiresAt: handle.expiresAt,
        })
        this.schedulePoll()
    }

    private schedulePoll(): void {
        if (this.settled) return
        this.timer = setTimeout(() => {
            void this.poll()
        }, this.deps.pollIntervalMs ?? HUB_ESTABLISH_POLL_INTERVAL_MS)
    }

    private async poll(): Promise<void> {
        if (this.settled || this.sessionToken === null) return

        let status: CommonsSignInStatus
        try {
            status = await this.deps.pollSessionStatus(this.sessionToken)
        } catch {
            // A single failed poll is not a verdict — the next tick retries.
            this.schedulePoll()
            return
        }

        if (status.authorized) {
            await this.claim()
            return
        }
        if (status.status === "cancelled" || status.status === "expired") {
            this.fail(status.status === "cancelled" ? "declined" : "expired")
            return
        }
        this.schedulePoll()
    }

    private async claim(): Promise<void> {
        // Set BEFORE the call. An ambiguous failure must never be retried: the
        // server spent the request, and a second claim would only burn a fresh
        // one if the first had actually failed.
        if (this.claimStarted || this.sessionToken === null) return
        this.claimStarted = true
        this.emit({ phase: "claiming" })

        const outcome = await this.deps.hub.claim(this.sessionToken)
        // The secret has been spent; drop it rather than keeping it addressable.
        this.sessionToken = null

        if (outcome.status !== "ok" || outcome.value.status !== "active") {
            this.fail("claim_failed")
            return
        }
        this.settled = true
        this.clearTimer()
        this.emit({ phase: "established", session: outcome.value, error: null })
    }

    private fail(error: string): void {
        this.settled = true
        this.clearTimer()
        this.emit({ phase: "failed", error })
    }

    private clearTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer)
            this.timer = null
        }
    }

    /** Stop polling. Deterministic cleanup — safe after settlement. */
    cancel(): void {
        this.settled = true
        this.clearTimer()
        this.sessionToken = null
    }
}
