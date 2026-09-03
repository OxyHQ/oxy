/**
 * The authorize page's no-session lane (issue #691) end to end.
 *
 * What is asserted here, and why it belongs at the page level rather than in
 * `lib/__tests__/commons-oauth-request.test.ts`:
 *
 *  - a visitor with NO session on this origin gets a request created with the
 *    OAuth context already bound, instead of being bounced to sign in here;
 *  - a visitor WITH a session still takes the original bearer-authenticated
 *    path, untouched;
 *  - the minted code travels through the SAME `deliverOAuthResult` funnel the
 *    session-bearing path uses, so the popup relay and the redirect fallback
 *    remain one decision;
 *  - the secret `sessionToken` never reaches a URL, the DOM, the QR, or a
 *    relayed message.
 *
 * The delivery funnel is NOT stubbed out: the real `deliverOAuthResult` runs,
 * and only the `window` it acts on is swapped for a harness — jsdom cannot
 * perform a real navigation, and a fake funnel would prove nothing about the
 * relay-vs-redirect decision.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { LocaleProvider } from "@/lib/i18n/locale-context"
import { COMMONS_OAUTH_POLL_INTERVAL_MS } from "@/lib/commons-oauth-request"

const CLIENT_ID = "oxy_dk_test_client"
const REDIRECT_URI = "https://app.example.com/callback"
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
const STATE = "rp-owned-state"
const SESSION_TOKEN = "secret-session-token-never-leaves-this-page"
const AUTHORIZE_CODE = "public-authorize-code"
/**
 * The `app` / `origin` values are deliberately distinctive: the anti-phishing
 * assertions below require that NOTHING the visitor reads is derived from the
 * payload — the application identity on screen is the server-resolved one.
 */
const PAYLOAD_APP = "payload-derived-app-name"
const PAYLOAD_ORIGIN = "https://payload-derived-origin.example"
const QR_PAYLOAD = `oxycommons://approve?v=1&code=${AUTHORIZE_CODE}&app=${PAYLOAD_APP}&origin=${encodeURIComponent(PAYLOAD_ORIGIN)}&nonce=n&exp=1`
const MINTED_CODE = "minted-authorization-code"

// ---------------------------------------------------------------------------
// Delivery funnel — real implementation, harness window
// ---------------------------------------------------------------------------

const webMessageModule = await import("@/lib/oauth-web-message")
/** Captured BEFORE the module is mocked, so the forwarder can never recurse. */
const realExports = { ...webMessageModule }
const realDeliverOAuthResult = webMessageModule.deliverOAuthResult

type DeliverInput = Parameters<typeof realDeliverOAuthResult>[0]

interface RelayTarget {
  postMessage: ReturnType<typeof mock>
}

const harness: {
  opener: RelayTarget | null
  location: { href: string }
  closed: boolean
  close(): void
} = {
  opener: null,
  location: { href: "" },
  closed: false,
  close() {
    this.closed = true
  },
}

const deliverOAuthResult = mock((input: DeliverInput) =>
  realDeliverOAuthResult(
    // Only the PAGE's calls (which pass the real global window jsdom refuses to
    // navigate) are redirected onto the harness. A caller that supplies its own
    // window — every test in `lib/__tests__/oauth-web-message.test.ts` — is left
    // untouched, so this process-global mock cannot leak into sibling suites.
    input.window === globalThis.window ? { ...input, window: harness } : input,
  ),
)

// ---------------------------------------------------------------------------
// The shared request surface
// ---------------------------------------------------------------------------

/**
 * The in-flight request is drawn by `@oxyhq/services`' `OxySignInRequestSurface`
 * — one implementation shared with the in-app account dialog, and a React Native
 * component this environment cannot load (the whole specifier is mocked; see
 * `lib/__tests__/setup-services-mock.ts`).
 *
 * What the IdP lane owns is therefore not the pixels but the FACTS it hands that
 * surface, so this double records every prop AND renders the DOM equivalent of
 * the real component's documented contract: the QR plate for a `qr` route, the
 * retry primary a failed request gets only when `onRetry` was supplied, the
 * always-visible `subordinate` links, and `alternatives` — which stay off the
 * surface (behind "Having trouble?" upstream) until the route could not deliver.
 */
interface SurfaceAction {
  key: string
  label: string
  onPress: () => void
  disabled?: boolean
}

interface SurfaceProps {
  route: string | null
  progress: string
  qrPayload?: string | null
  routeFailed?: boolean
  failed?: boolean
  onRetry?: () => void
  onAcquireCommons?: () => void
  subordinate?: readonly SurfaceAction[]
  alternatives?: readonly SurfaceAction[]
}

let surfaceProps: SurfaceProps | null = null

function renderAction(action: SurfaceAction) {
  return React.createElement(
    "button",
    {
      key: action.key,
      type: "button",
      "data-testid": action.key,
      disabled: action.disabled,
      onClick: action.onPress,
    },
    action.label,
  )
}

function SignInRequestSurfaceDouble(props: SurfaceProps) {
  surfaceProps = props
  const failed = props.failed === true
  const revealed = failed || props.routeFailed === true
  return React.createElement(
    "div",
    { "data-testid": "signin-request-surface" },
    !failed && props.route === "qr" && props.qrPayload
      ? React.createElement("div", {
          key: "qr",
          "data-testid": "qr-code",
          "data-qr-value": props.qrPayload,
        })
      : null,
    failed && props.onRetry
      ? React.createElement(
          "button",
          {
            key: "retry",
            type: "button",
            "data-testid": "signin-retry",
            onClick: props.onRetry,
          },
          "Try again",
        )
      : null,
    (props.subordinate ?? []).map(renderAction),
    revealed ? (props.alternatives ?? []).map(renderAction) : null,
  )
}

/** The action keys the lane put in a given band, in order. */
function keysOf(actions: readonly SurfaceAction[] | undefined): string[] {
  return (actions ?? []).map((action) => action.key)
}

// ---------------------------------------------------------------------------
// SDK surface
// ---------------------------------------------------------------------------

interface PollResult {
  authorized: boolean
  sessionId?: string
  status: string
  pushSentAt: string | null
  openedAt: string | null
}

const oxyServices = {
  startCommonsSignIn: mock(async () => ({
    sessionToken: SESSION_TOKEN,
    authorizeCode: AUTHORIZE_CODE,
    qrPayload: QR_PAYLOAD,
    expiresAt: Date.now() + 5 * 60 * 1000,
    status: "pending",
  })),
  pollCommonsSignIn: mock(async (): Promise<PollResult> => pollResult),
  finalizeCommonsOAuth: mock(async () => ({
    code: MINTED_CODE,
    redirectUri: REDIRECT_URI,
    expiresIn: 600,
  })),
  denyCommonsSignIn: mock(async () => ({ success: true })),
  getAccessToken: () => sessionState.accessToken,
}

let pollResult: PollResult = {
  authorized: false,
  status: "pending",
  pushSentAt: null,
  openedAt: null,
}

/**
 * One `principal acting as account` row, in the shape `useDeviceSwitcher`
 * publishes. Built by hand rather than through the real projection: the point
 * of these suites is what the PAGE does with the rows, and a hand-built row is
 * exactly what a hand-built directory would have produced.
 */
function contextRow(over: { contextId: string; displayName: string; handle: string; isActive: boolean }) {
  return {
    contextId: over.contextId,
    accountId: over.contextId,
    subject: { accountId: over.contextId },
    displayName: over.displayName,
    handle: over.handle,
    avatarUrl: undefined,
    color: null,
    isActive: over.isActive,
    isDelegated: false,
    canActivate: true,
  }
}

/** One person holding one account. */
function personWith(row: ReturnType<typeof contextRow>) {
  return {
    principalId: `p-${row.contextId}`,
    displayName: row.displayName,
    handle: row.handle,
    avatarUrl: undefined,
    color: null,
    isActive: row.isActive,
    contexts: [row],
  }
}

let sessionState: {
  isAuthenticated: boolean
  activeContext: ReturnType<typeof contextRow> | null
  principals: ReturnType<typeof personWith>[]
  accessToken: string | null
} = {
  isAuthenticated: false,
  activeContext: null,
  principals: [],
  accessToken: null,
}

/**
 * `mock.module` is process-global and last-writer-wins, so every mock this file
 * relies on is (re-)asserted before each test rather than only at load time.
 */
function installMocks(): void {
  mock.module("@/lib/oauth-web-message", () => ({
    ...realExports,
    deliverOAuthResult,
  }))
  mock.module("@oxyhq/services", () => ({
    useOxy: () => ({
      user: null,
      oxyServices,
      isAuthResolved: true,
      isAuthenticated: sessionState.isAuthenticated,
      openAccountDialog: () => undefined,
      handleWebSession: async () => undefined,
      registerWithPasskey: async () => undefined,
      signInWithPassword: async () => ({ status: "ok" as const }),
      signInWithPasskey: async () => undefined,
      completeTwoFactorSignIn: async () => ({}),
      revokeSuspiciousSignIn: async () => undefined,
    }),
    useDeviceSwitcher: () => ({
      isLoading: false,
      activeContext: sessionState.activeContext,
      principals: sessionState.principals,
      activatingContextId: null,
      removingContextId: null,
      removingPrincipalId: null,
      activateContext: async () => true,
      signOutContext: async () => false,
      signOutPrincipal: async () => false,
    }),
    OxyConsentScreen: () =>
      React.createElement("div", { "data-testid": "consent-screen" }),
    OxyAuthChooser: () => null,
    OxySignInRequestSurface: SignInRequestSurfaceDouble,
  }))
}

installMocks()

const { AuthorizePage } = await import("@/src/pages/authorize")

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Application lookup + consent probe. Overridden per test where it matters. */
let applicationResponse: { status: number; body: unknown } = {
  status: 200,
  body: {
    data: {
      application: {
        id: "app-1",
        name: "Example App",
        type: "third_party",
        isOfficial: false,
        isInternal: false,
        scopes: [],
      },
    },
  },
}

const fetchMock = mock(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes("/auth/oauth/client/")) {
    return new Response(JSON.stringify(applicationResponse.body), {
      status: applicationResponse.status,
      headers: { "content-type": "application/json" },
    })
  }
  if (url.includes("/auth/oauth/consent")) {
    return new Response(JSON.stringify({ data: { consentRequired: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  return new Response("{}", { status: 404 })
})

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve()
}

function buildSearch(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value)
  }
  return `?${search.toString()}`
}

async function renderAuthorize(params: Record<string, string | undefined>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(
      <LocaleProvider>
        <MemoryRouter initialEntries={[`/authorize${buildSearch(params)}`]}>
          <Routes>
            <Route path="/authorize" element={<AuthorizePage />} />
            <Route
              path="/login"
              element={<div data-testid="login-page" />}
            />
          </Routes>
        </MemoryRouter>
      </LocaleProvider>,
    )
  })
  await act(async () => {
    await flush()
  })
  return {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

/** Fire the lane's next poll and let the resulting work settle. */
async function advancePoll(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(COMMONS_OAUTH_POLL_INTERVAL_MS + 1)
    await flush()
  })
}

function click(element: Element | null | undefined): void {
  act(() => {
    element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  })
}

const OAUTH_PARAMS = {
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  state: STATE,
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: "S256",
  scope: "openid profile",
}

describe("AuthorizePage — Commons lane for a visitor with no session here", () => {
  beforeEach(() => {
    installMocks()
    jest.useFakeTimers()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    fetchMock.mockClear()
    applicationResponse = {
      status: 200,
      body: {
        data: {
          application: {
            id: "app-1",
            name: "Example App",
            type: "third_party",
            isOfficial: false,
            isInternal: false,
            scopes: [],
          },
        },
      },
    }
    pollResult = { authorized: false, status: "pending", pushSentAt: null, openedAt: null }
    sessionState = {
      isAuthenticated: false,
      activeContext: null,
      principals: [],
      accessToken: null,
    }
    surfaceProps = null
    harness.opener = null
    harness.location = { href: "" }
    harness.closed = false
    deliverOAuthResult.mockClear()
    oxyServices.startCommonsSignIn.mockClear()
    oxyServices.pollCommonsSignIn.mockClear()
    oxyServices.finalizeCommonsOAuth.mockClear()
    oxyServices.denyCommonsSignIn.mockClear()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("creates the request with the OAuth context already bound", async () => {
    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    expect(oxyServices.startCommonsSignIn).toHaveBeenCalledTimes(1)
    expect(oxyServices.startCommonsSignIn).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      oauth: {
        redirectUri: REDIRECT_URI,
        codeChallenge: CODE_CHALLENGE,
        codeChallengeMethod: "S256",
        scope: "openid profile",
      },
    })

    // The lane drives the shared surface down its QR route, carrying the PUBLIC
    // approval payload and nothing else.
    expect(surfaceProps?.route).toBe("qr")
    expect(surfaceProps?.qrPayload).toBe(QR_PAYLOAD)
    expect(surfaceProps?.failed).toBe(false)
    // Progress is DERIVED from what the lane observed — the request exists and
    // nobody has approved it yet.
    expect(surfaceProps?.progress).toBe("awaiting-approval")
    const qr = container.querySelector("[data-testid='qr-code']")
    expect(qr?.getAttribute("data-qr-value")).toBe(QR_PAYLOAD)
    expect(container.querySelector("[data-testid='login-page']")).toBeNull()
    expect(container.innerHTML).not.toContain(SESSION_TOKEN)

    unmount()
  })

  test("renders the server-resolved application, never anything read out of the payload", async () => {
    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    // The identity on screen is the one `GET /auth/oauth/client/:clientId`
    // resolved. The payload's own `app` / `origin` are encoded into the QR and
    // are never read back out of it.
    const text = container.textContent ?? ""
    expect(text).toContain("Example App")
    expect(text).not.toContain(PAYLOAD_APP)
    expect(text).not.toContain(PAYLOAD_ORIGIN)
    expect(text).not.toContain(AUTHORIZE_CODE)
    expect(text).not.toContain(SESSION_TOKEN)

    unmount()
  })

  test("keeps the alternatives out of the always-visible band", async () => {
    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    // Cancelling is the one subordinate way out and is always on screen; every
    // alternative WAY TO AUTHENTICATE is handed to the surface's "Having
    // trouble?" disclosure, so none of them competes with the QR.
    expect(keysOf(surfaceProps?.subordinate)).toEqual(["commons-cancel"])
    expect(keysOf(surfaceProps?.alternatives)).toEqual([
      "commons-open-on-this-device",
      "commons-sign-in-here",
    ])
    expect(container.querySelector("[data-testid='commons-cancel']")).not.toBeNull()
    expect(container.querySelector("[data-testid='commons-sign-in-here']")).toBeNull()

    unmount()
  })

  test("delivers the minted code through the shared funnel — redirect with no opener", async () => {
    pollResult = {
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }
    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    await advancePoll()

    // Finalized ONCE, authenticated by the secret token the page never exposes.
    expect(oxyServices.finalizeCommonsOAuth).toHaveBeenCalledTimes(1)
    expect(oxyServices.finalizeCommonsOAuth).toHaveBeenCalledWith(SESSION_TOKEN)

    expect(deliverOAuthResult).toHaveBeenCalledTimes(1)
    const delivered = deliverOAuthResult.mock.calls[0]?.[0] as DeliverInput
    expect(delivered.result).toEqual({ kind: "code", code: MINTED_CODE, state: STATE })
    expect(delivered.safeRedirectUri).toBe(REDIRECT_URI)

    // No opener -> the funnel's redirect branch, exactly as the session-bearing
    // path behaves.
    const url = new URL(harness.location.href)
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI)
    expect(url.searchParams.get("code")).toBe(MINTED_CODE)
    expect(url.searchParams.get("state")).toBe(STATE)
    expect(harness.location.href).not.toContain(SESSION_TOKEN)
    expect(container.innerHTML).not.toContain(SESSION_TOKEN)

    unmount()
  })

  test("relays the minted code to the opener when the request asked for popup mode", async () => {
    pollResult = {
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }
    const postMessage = mock(() => undefined)
    harness.opener = { postMessage }

    const { unmount } = await renderAuthorize({
      ...OAUTH_PARAMS,
      response_mode: "web_message",
    })

    await advancePoll()

    expect(postMessage).toHaveBeenCalledTimes(1)
    const [message, targetOrigin] = postMessage.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ]
    expect(message).toEqual({
      type: "oxy:oauth:code",
      code: MINTED_CODE,
      state: STATE,
    })
    expect(targetOrigin).toBe("https://app.example.com")
    expect(JSON.stringify(message)).not.toContain(SESSION_TOKEN)
    // Popup delivery never navigates this window.
    expect(harness.location.href).toBe("")
    expect(harness.closed).toBe(true)

    unmount()
  })

  test("a finalize failure fails closed: nothing delivered, nothing retried", async () => {
    pollResult = {
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }
    oxyServices.finalizeCommonsOAuth.mockImplementationOnce(async () => {
      throw new Error("finalize refused")
    })

    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)
    await advancePoll()

    expect(oxyServices.finalizeCommonsOAuth).toHaveBeenCalledTimes(1)
    expect(deliverOAuthResult).not.toHaveBeenCalled()
    expect(harness.location.href).toBe("")
    // The reason is the page's own banner (the shared surface reports only THAT
    // the request failed); the way forward is the surface's retry primary.
    expect(container.querySelector("[data-testid='commons-failure']")).not.toBeNull()
    expect(surfaceProps?.failed).toBe(true)
    expect(surfaceProps?.onRetry).toBeDefined()
    // A dead request has nothing honest left to report on, so no status line.
    expect(surfaceProps?.progress).toBe("idle")

    // Letting time pass does not resurrect the spent request.
    await act(async () => {
      jest.advanceTimersByTime(COMMONS_OAUTH_POLL_INTERVAL_MS * 10)
      await flush()
    })
    expect(oxyServices.finalizeCommonsOAuth).toHaveBeenCalledTimes(1)
    expect(deliverOAuthResult).not.toHaveBeenCalled()

    // "Try again" is a BRAND-NEW request, never a second finalize of the spent
    // one — the credential for that one is gone and the server already spent it.
    expect(oxyServices.startCommonsSignIn).toHaveBeenCalledTimes(1)
    await act(async () => {
      click(container.querySelector("[data-testid='signin-retry']"))
      await flush()
    })
    expect(oxyServices.startCommonsSignIn).toHaveBeenCalledTimes(2)
    expect(oxyServices.finalizeCommonsOAuth).toHaveBeenCalledTimes(1)
    expect(deliverOAuthResult).not.toHaveBeenCalled()

    unmount()
  })

  test("a redirect mismatch offers no retry — a fresh request would fail identically", async () => {
    pollResult = {
      authorized: true,
      sessionId: "sess-1",
      status: "authorized",
      pushSentAt: null,
      openedAt: null,
    }
    oxyServices.finalizeCommonsOAuth.mockImplementationOnce(async () => ({
      code: MINTED_CODE,
      redirectUri: "https://not-the-bound-target.example/callback",
      expiresIn: 600,
    }))

    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)
    await advancePoll()

    // Fails closed: the code is bound to a target this request never asked for,
    // so it is dropped rather than delivered anywhere.
    expect(deliverOAuthResult).not.toHaveBeenCalled()
    expect(harness.location.href).toBe("")
    expect(container.querySelector("[data-testid='commons-failure']")).not.toBeNull()
    expect(surfaceProps?.failed).toBe(true)
    expect(surfaceProps?.onRetry).toBeUndefined()
    expect(container.querySelector("[data-testid='signin-retry']")).toBeNull()

    // Only the alternatives are left, and they are on screen without asking —
    // minus the same-device deep link, whose approval handle is now spent.
    expect(keysOf(surfaceProps?.alternatives)).toEqual(["commons-sign-in-here"])
    expect(container.querySelector("[data-testid='commons-sign-in-here']")).not.toBeNull()
    expect(container.querySelector("[data-testid='commons-open-on-this-device']")).toBeNull()

    unmount()
  })

  test("cancelling withdraws the request and reports access_denied through the same funnel", async () => {
    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    await act(async () => {
      click(container.querySelector("[data-testid='commons-cancel']"))
      await flush()
    })

    // Withdrawn with the PUBLIC handle — never the finalize credential.
    expect(oxyServices.denyCommonsSignIn).toHaveBeenCalledWith(AUTHORIZE_CODE)
    expect(oxyServices.finalizeCommonsOAuth).not.toHaveBeenCalled()
    expect(deliverOAuthResult).toHaveBeenCalledTimes(1)
    const url = new URL(harness.location.href)
    expect(url.searchParams.get("error")).toBe("access_denied")
    expect(url.searchParams.get("state")).toBe(STATE)
    expect(harness.location.href).not.toContain(SESSION_TOKEN)

    unmount()
  })

  test("an expired request ends the lane without delivering anything", async () => {
    pollResult = {
      authorized: false,
      status: "expired",
      pushSentAt: null,
      openedAt: null,
    }
    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    await advancePoll()

    expect(container.querySelector("[data-testid='commons-failure']")).not.toBeNull()
    expect(deliverOAuthResult).not.toHaveBeenCalled()
    expect(oxyServices.finalizeCommonsOAuth).not.toHaveBeenCalled()

    unmount()
  })

  test("a request without PKCE keeps the unchanged redirect to sign in on this origin", async () => {
    const { container, unmount } = await renderAuthorize({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: STATE,
    })

    expect(oxyServices.startCommonsSignIn).not.toHaveBeenCalled()
    expect(container.querySelector("[data-testid='login-page']")).not.toBeNull()

    unmount()
  })

  test("an unresolved application never starts a Commons request", async () => {
    applicationResponse = { status: 404, body: {} }

    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    expect(oxyServices.startCommonsSignIn).not.toHaveBeenCalled()
    expect(container.querySelector("[data-testid='login-page']")).not.toBeNull()

    unmount()
  })

  test("stale device accounts without a bearer still open the Commons lane", async () => {
    sessionState = {
      isAuthenticated: false,
      // Rows, but nothing ACTIVE — what a failed mint leaves behind.
      activeContext: null,
      principals: [
        personWith(contextRow({ contextId: "ctx-1", displayName: "Stale", handle: "stale", isActive: false })),
      ],
      accessToken: null,
    }

    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    expect(oxyServices.startCommonsSignIn).toHaveBeenCalledTimes(1)
    expect(container.querySelector("[data-testid='login-page']")).toBeNull()

    unmount()
  })
})

describe("AuthorizePage — a visitor who already has a session here", () => {
  beforeEach(() => {
    installMocks()
    jest.useFakeTimers()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    fetchMock.mockClear()
    applicationResponse = {
      status: 200,
      body: {
        data: {
          application: {
            id: "app-1",
            name: "Example App",
            type: "third_party",
            isOfficial: false,
            isInternal: false,
            scopes: [],
          },
        },
      },
    }
    const nate = contextRow({
      contextId: "ctx-1",
      displayName: "Nate",
      handle: "nate",
      isActive: true,
    })
    sessionState = {
      isAuthenticated: true,
      activeContext: nate,
      principals: [personWith(nate)],
      accessToken: "bearer-token",
    }
    harness.opener = null
    harness.location = { href: "" }
    deliverOAuthResult.mockClear()
    oxyServices.startCommonsSignIn.mockClear()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test("still takes the original bearer-authenticated path", async () => {
    const { container, unmount } = await renderAuthorize(OAUTH_PARAMS)

    // No Commons request is created, and no redirect to sign in here.
    expect(oxyServices.startCommonsSignIn).not.toHaveBeenCalled()
    expect(container.querySelector("[data-testid='qr-code']")).toBeNull()
    expect(container.querySelector("[data-testid='login-page']")).toBeNull()

    // The unchanged consent probe ran with the SDK's active-account bearer, and
    // the shared consent surface is what the visitor sees.
    const consentCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/auth/oauth/consent"),
    )
    expect(consentCall).toBeDefined()
    expect(container.querySelector("[data-testid='consent-screen']")).not.toBeNull()

    unmount()
  })
})
