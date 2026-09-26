/**
 * The OAuth-bound "Sign in with Oxy" lane (issue #691).
 *
 * These tests are the contract for the additional no-session path on the
 * authorize page: create ONE request with the OAuth context already bound,
 * converge every delivery surface on it, finalize it into an authorization CODE
 * exactly once, and fail closed on anything ambiguous.
 *
 * They are also where the two credential invariants are pinned: the SECRET
 * `sessionToken` is the finalize credential and never appears in anything
 * renderable, while the PUBLIC `authorizeCode` is the only handle that travels.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import {
  buildCommonsOAuthBinding,
  CommonsOAuthRequest,
  type CommonsOAuthClient,
  type CommonsOAuthOutcome,
  type CommonsOAuthScheduler,
  type CommonsOAuthSnapshot,
} from "@/lib/commons-oauth-request"

const CLIENT_ID = "oxy_dk_test_client"
const REDIRECT_URI = "https://app.example.com/callback"
/** A real-shaped PKCE S256 challenge: 43 base64url characters. */
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

const SESSION_TOKEN = "secret-session-token-never-leaves-this-page"
const AUTHORIZE_CODE = "public-authorize-code"
const QR_PAYLOAD = `oxycommons://approve?v=1&code=${AUTHORIZE_CODE}&app=abc&origin=&nonce=n&exp=1`

const OAUTH_CONTEXT = {
  redirectUri: REDIRECT_URI,
  codeChallenge: CODE_CHALLENGE,
  codeChallengeMethod: "S256" as const,
  scope: "openid profile",
}

/** Drain the microtask queue so an in-flight `await` chain settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve()
}

/** A scheduler the test drives by hand — no timers, no wall clock, no races. */
function createScheduler() {
  let pending: (() => void) | null = null
  const schedule: CommonsOAuthScheduler = (run) => {
    pending = run
    return {
      cancel: () => {
        if (pending === run) pending = null
      },
    }
  }
  return {
    schedule,
    get hasPending(): boolean {
      return pending !== null
    },
    async tick(): Promise<void> {
      const run = pending
      pending = null
      if (!run) throw new Error("expected a scheduled poll")
      run()
      await flush()
    },
  }
}

interface ClientDouble extends CommonsOAuthClient {
  auth: {
    commons: {
      start: ReturnType<typeof mock>
      poll: ReturnType<typeof mock>
      finalizeOAuth: ReturnType<typeof mock>
      deny: ReturnType<typeof mock>
    }
  }
}

function createClient(): ClientDouble {
  let issued = 0
  const commons = {
    start: mock(async () => {
      issued += 1
      return {
        // A distinct secret per issued request, so a test can prove a retry
        // never finalizes the previous (spent) one.
        sessionToken: issued === 1 ? SESSION_TOKEN : `${SESSION_TOKEN}-${issued}`,
        authorizeCode: issued === 1 ? AUTHORIZE_CODE : `${AUTHORIZE_CODE}-${issued}`,
        qrPayload: QR_PAYLOAD,
        expiresAt: 10_000,
        status: "pending",
      }
    }),
    poll: mock(async () => ({
      authorized: false,
      status: "pending",
      pushSentAt: null,
      openedAt: null,
    })),
    finalizeOAuth: mock(async () => ({
      code: "minted-authorization-code",
      redirectUri: REDIRECT_URI,
      expiresIn: 600,
    })),
    deny: mock(async () => ({ success: true })),
  }
  return { auth: { commons } } as ClientDouble
}

function createLane(client: ClientDouble) {
  const scheduler = createScheduler()
  const outcomes: CommonsOAuthOutcome[] = []
  const request = new CommonsOAuthRequest({
    client,
    clientId: CLIENT_ID,
    oauth: OAUTH_CONTEXT,
    onOutcome: (outcome) => outcomes.push(outcome),
    schedule: scheduler.schedule,
    // Fixed clock, well inside the handle's `expiresAt`, so nothing expires
    // unless a test says so.
    now: () => 1_000,
  })
  return { request, scheduler, outcomes }
}

/** Start the lane and let the request-creation round trip settle. */
async function startLane(client: ClientDouble) {
  const lane = createLane(client)
  lane.request.start()
  await flush()
  return lane
}

/** Everything a surface could render, serialized. */
function renderable(snapshot: CommonsOAuthSnapshot): string {
  return JSON.stringify(snapshot)
}

describe("buildCommonsOAuthBinding", () => {
  test("binds the OAuth request context from the validated authorize parameters", () => {
    expect(
      buildCommonsOAuthBinding({
        clientId: CLIENT_ID,
        safeRedirectUri: REDIRECT_URI,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: "S256",
        scope: "openid   profile ",
      }),
    ).toEqual({
      clientId: CLIENT_ID,
      oauth: {
        redirectUri: REDIRECT_URI,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: "S256",
        scope: "openid profile",
      },
    })
  })

  test("omits the scope entirely when the request asked for none", () => {
    const binding = buildCommonsOAuthBinding({
      clientId: CLIENT_ID,
      safeRedirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: null,
      scope: null,
    })
    expect(binding?.oauth).toEqual({
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: "S256",
    })
  })

  test("rejects a request that cannot use the lane", () => {
    const base = {
      clientId: CLIENT_ID,
      safeRedirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: "S256",
      scope: null,
    }
    // No client id -> nothing to resolve the application or its allowlist from.
    expect(buildCommonsOAuthBinding({ ...base, clientId: null })).toBeNull()
    expect(buildCommonsOAuthBinding({ ...base, clientId: "   " })).toBeNull()
    // `safeRedirectUrl` already refused the redirect target.
    expect(buildCommonsOAuthBinding({ ...base, safeRedirectUri: null })).toBeNull()
    // PKCE is mandatory, and only S256 is accepted.
    expect(buildCommonsOAuthBinding({ ...base, codeChallenge: null })).toBeNull()
    expect(buildCommonsOAuthBinding({ ...base, codeChallenge: "too-short" })).toBeNull()
    expect(
      buildCommonsOAuthBinding({ ...base, codeChallenge: `${CODE_CHALLENGE}$$` }),
    ).toBeNull()
    expect(buildCommonsOAuthBinding({ ...base, codeChallengeMethod: "plain" })).toBeNull()
    // A scope the server would refuse is never silently truncated into a
    // different grant than the one that was requested.
    expect(
      buildCommonsOAuthBinding({ ...base, scope: "s".repeat(513) }),
    ).toBeNull()
  })
})

describe("CommonsOAuthRequest — the no-session lane", () => {
  let client: ClientDouble

  beforeEach(() => {
    client = createClient()
  })

  test("creates the request with the OAuth context already bound", async () => {
    await startLane(client)

    expect(client.auth.commons.start).toHaveBeenCalledTimes(1)
    expect(client.auth.commons.start).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      oauth: OAUTH_CONTEXT,
    })
  })

  test("exposes only the PUBLIC handle — the secret session token never reaches the snapshot", async () => {
    const { request } = await startLane(client)
    const snapshot = request.getSnapshot()

    expect(snapshot.authorizeCode).toBe(AUTHORIZE_CODE)
    expect(snapshot.qrPayload).toBe(QR_PAYLOAD)
    expect(renderable(snapshot)).not.toContain(SESSION_TOKEN)
  })

  test("resolves the QR route from the shared decision, without attempting a push", async () => {
    const { request } = await startLane(client)

    // An unauthenticated surface never pushes (bearer-required) and a browser
    // cannot verify a Commons app link, so the one primary route is the QR.
    expect(request.getSnapshot().route).toBe("qr")
    expect(request.getSnapshot().phase).toBe("waiting")
    expect(request.getSnapshot().progress).toBe("awaiting-approval")
  })

  test("reports 'opened in Commons' only from the approver's own signal", async () => {
    client.auth.commons.poll = mock(async () => ({
      authorized: false,
      status: "pending",
      pushSentAt: null,
      openedAt: "2026-07-27T10:00:00.000Z",
    }))
    const { request, scheduler } = await startLane(client)

    expect(request.getSnapshot().progress).toBe("awaiting-approval")
    await scheduler.tick()
    expect(request.getSnapshot().openedInCommons).toBe(true)
    expect(request.getSnapshot().progress).toBe("opened-in-commons")
  })

  test("finalizes exactly once on authorization and emits the code", async () => {
    client.auth.commons.poll = mock(async () => ({
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }))
    const { request, scheduler, outcomes } = await startLane(client)

    await scheduler.tick()

    // Finalization is authenticated by the SECRET token — never the public code.
    expect(client.auth.commons.finalizeOAuth).toHaveBeenCalledTimes(1)
    expect(client.auth.commons.finalizeOAuth).toHaveBeenCalledWith(SESSION_TOKEN)
    expect(outcomes).toEqual([{ kind: "code", code: "minted-authorization-code" }])
    expect(request.getSnapshot().phase).toBe("confirmed")
    // Nothing is left running that could finalize (or deliver) a second time.
    expect(scheduler.hasPending).toBe(false)
    expect(renderable(request.getSnapshot())).not.toContain(SESSION_TOKEN)
  })

  test("a finalize failure fails closed: no retry, no outcome, no partial delivery", async () => {
    client.auth.commons.poll = mock(async () => ({
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }))
    client.auth.commons.finalizeOAuth = mock(async () => {
      throw new Error("finalize refused")
    })
    const { request, scheduler, outcomes } = await startLane(client)

    await scheduler.tick()

    expect(client.auth.commons.finalizeOAuth).toHaveBeenCalledTimes(1)
    expect(request.getSnapshot().phase).toBe("failed")
    expect(request.getSnapshot().failure).toBe("finalize_failed")
    // The request is spent server-side: nothing is scheduled that would poll or
    // finalize it again, and the relying party was told nothing.
    expect(scheduler.hasPending).toBe(false)
    expect(outcomes).toEqual([])
  })

  test("'try again' after a failure starts a BRAND-NEW request, never a second finalize", async () => {
    client.auth.commons.poll = mock(async () => ({
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }))
    let attempt = 0
    client.auth.commons.finalizeOAuth = mock(async (token: string) => {
      attempt += 1
      if (attempt === 1) throw new Error("finalize refused")
      return { code: `code-for-${token}`, redirectUri: REDIRECT_URI, expiresIn: 600 }
    })
    const { request, scheduler, outcomes } = await startLane(client)

    await scheduler.tick()
    expect(request.getSnapshot().phase).toBe("failed")

    request.start()
    await flush()
    expect(client.auth.commons.start).toHaveBeenCalledTimes(2)

    await scheduler.tick()
    // The second finalization used the NEW request's secret, so the spent one
    // was never re-presented to the server.
    expect(client.auth.commons.finalizeOAuth).toHaveBeenCalledTimes(2)
    expect(client.auth.commons.finalizeOAuth).toHaveBeenLastCalledWith(`${SESSION_TOKEN}-2`)
    expect(outcomes).toEqual([{ kind: "code", code: `code-for-${SESSION_TOKEN}-2` }])
  })

  test("a denial ends the lane with access-denied and never finalizes", async () => {
    client.auth.commons.poll = mock(async () => ({
      authorized: false,
      status: "cancelled",
      pushSentAt: null,
      openedAt: null,
    }))
    const { request, scheduler, outcomes } = await startLane(client)

    await scheduler.tick()

    expect(outcomes).toEqual([{ kind: "denied" }])
    expect(client.auth.commons.finalizeOAuth).not.toHaveBeenCalled()
    expect(request.getSnapshot().phase).toBe("denied")
    expect(scheduler.hasPending).toBe(false)
  })

  test("a server-reported expiry ends the lane without delivering anything", async () => {
    client.auth.commons.poll = mock(async () => ({
      authorized: false,
      status: "expired",
      pushSentAt: null,
      openedAt: null,
    }))
    const { request, scheduler, outcomes } = await startLane(client)

    await scheduler.tick()

    expect(request.getSnapshot().phase).toBe("failed")
    expect(request.getSnapshot().failure).toBe("request_expired")
    expect(outcomes).toEqual([])
    expect(scheduler.hasPending).toBe(false)
  })

  test("a request that outlives its own expiry stops before asking the server again", async () => {
    const scheduler = createScheduler()
    const outcomes: CommonsOAuthOutcome[] = []
    const request = new CommonsOAuthRequest({
      client,
      clientId: CLIENT_ID,
      oauth: OAUTH_CONTEXT,
      onOutcome: (outcome) => outcomes.push(outcome),
      schedule: scheduler.schedule,
      // Past the handle's `expiresAt` (10_000).
      now: () => 20_000,
    })
    request.start()
    await flush()

    await scheduler.tick()

    expect(client.auth.commons.poll).not.toHaveBeenCalled()
    expect(request.getSnapshot().failure).toBe("request_expired")
    expect(outcomes).toEqual([])
  })

  test("cancelling withdraws with the PUBLIC code and reports the denial once", async () => {
    const { request, scheduler, outcomes } = await startLane(client)

    request.cancel()
    request.cancel()
    await flush()

    expect(client.auth.commons.deny).toHaveBeenCalledTimes(1)
    expect(client.auth.commons.deny).toHaveBeenCalledWith(AUTHORIZE_CODE)
    expect(outcomes).toEqual([{ kind: "denied" }])
    expect(scheduler.hasPending).toBe(false)
  })

  test("a failed withdrawal still reports the denial", async () => {
    client.auth.commons.deny = mock(async () => {
      throw new Error("network down")
    })
    const { outcomes, request } = await startLane(client)

    request.cancel()
    await flush()

    expect(outcomes).toEqual([{ kind: "denied" }])
  })

  test("disposing stops the lane without delivering anything", async () => {
    const { request, scheduler, outcomes } = await startLane(client)

    request.dispose()
    expect(scheduler.hasPending).toBe(false)

    // A late restart attempt after teardown is a no-op too.
    request.start()
    await flush()
    expect(client.auth.commons.start).toHaveBeenCalledTimes(1)
    expect(outcomes).toEqual([])
  })

  test("bounded poll failures end in a visible failure, not a retry storm", async () => {
    client.auth.commons.poll = mock(async () => {
      throw new Error("offline")
    })
    const { request, scheduler, outcomes } = await startLane(client)

    let ticks = 0
    while (scheduler.hasPending && ticks < 20) {
      await scheduler.tick()
      ticks += 1
    }

    expect(request.getSnapshot().phase).toBe("failed")
    expect(request.getSnapshot().failure).toBe("unreachable")
    expect(client.auth.commons.poll).toHaveBeenCalledTimes(4)
    expect(outcomes).toEqual([])
  })

  test("a transient poll failure does not end the lane", async () => {
    let calls = 0
    client.auth.commons.poll = mock(async () => {
      calls += 1
      if (calls === 1) throw new Error("blip")
      return {
        authorized: true,
        sessionId: "sess-1",
        status: "authorized",
        pushSentAt: null,
        openedAt: null,
      }
    })
    const { scheduler, outcomes } = await startLane(client)

    await scheduler.tick()
    await scheduler.tick()

    expect(outcomes).toEqual([{ kind: "code", code: "minted-authorization-code" }])
  })

  test("a cancel pressed while the code is being minted still delivers exactly one outcome", async () => {
    client.auth.commons.poll = mock(async () => ({
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }))
    let releaseFinalize: (result: {
      code: string
      redirectUri: string
      expiresIn: number
    }) => void = () => undefined
    client.auth.commons.finalizeOAuth = mock(
      () =>
        new Promise((resolve) => {
          releaseFinalize = resolve
        }),
    )
    const { request, scheduler, outcomes } = await startLane(client)

    await scheduler.tick()
    expect(request.getSnapshot().phase).toBe("finalizing")

    request.cancel()
    releaseFinalize({ code: "minted-authorization-code", redirectUri: REDIRECT_URI, expiresIn: 600 })
    await flush()

    // The denial won the race, so the late code is dropped rather than
    // delivered on top of it — one request, one result, never both.
    expect(outcomes).toEqual([{ kind: "denied" }])
  })

  test("a mismatched redirect binding fails closed instead of delivering the code", async () => {
    client.auth.commons.poll = mock(async () => ({
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }))
    client.auth.commons.finalizeOAuth = mock(async () => ({
      code: "minted-authorization-code",
      redirectUri: "https://attacker.example/callback",
      expiresIn: 600,
    }))
    const { request, scheduler, outcomes } = await startLane(client)

    await scheduler.tick()

    expect(request.getSnapshot().failure).toBe("redirect_mismatch")
    expect(outcomes).toEqual([])
  })

  test("a request that cannot be created reports a failure and delivers nothing", async () => {
    client.auth.commons.start = mock(async () => {
      throw new Error("Application is not available")
    })
    const { request, scheduler, outcomes } = await startLane(client)

    expect(request.getSnapshot().phase).toBe("failed")
    expect(request.getSnapshot().failure).toBe("start_failed")
    expect(scheduler.hasPending).toBe(false)
    expect(outcomes).toEqual([])
  })

  test("start is idempotent while a request is already live", async () => {
    const { request } = await startLane(client)

    request.start()
    request.start()
    await flush()

    expect(client.auth.commons.start).toHaveBeenCalledTimes(1)
  })
})
