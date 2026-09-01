/**
 * `prompt=none` (OIDC silent authentication) against the IdP's authorize page.
 *
 * Phase 7b removed every gesture-less lane, and `@oxyhq/core`'s
 * `buildOAuthAuthorizeUrl` narrowed its `prompt` union so no first-party caller
 * can construct such a request. `prompt` is still read off the query string,
 * though, so an arbitrary caller can still send it — and the page's answer must
 * be a deliberate refusal, not whatever falls out of ignoring the parameter.
 *
 * What is pinned here is the whole shape of that refusal:
 *
 *  - the visitor gets the terminal refusal surface — never the consent screen,
 *    the sign-in redirect, or the Commons lane;
 *  - the refused request does NO work: not one request leaves the page, so no
 *    code is minted and no client/consent state is touched;
 *  - nothing is handed to the relying party: no code, no OAuth error, no
 *    navigation to `redirect_uri`, no message to an opener. In particular the
 *    page never becomes a zero-interaction redirector to a target that has only
 *    passed `safeRedirectUrl`'s shape check;
 *  - the answer is CONSTANT across session states, so asking cannot be used as a
 *    cross-origin oracle for whether someone is signed in on this origin;
 *  - it is scoped to exactly `prompt=none` — every other request is untouched.
 *
 * The delivery funnel is spied on rather than stubbed out, so "nothing was
 * delivered" is asserted against the real `deliverOAuthResult` decision.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { LocaleProvider } from "@/lib/i18n/locale-context"
import { createServicesMock } from "@/lib/__tests__/setup-services-mock"
import enDict from "@/lib/i18n/locales/en"

const CLIENT_ID = "oxy_dk_test_client"
/** Deliberately NOT a registered redirect target — nothing may ever bounce here. */
const REDIRECT_URI = "https://attacker-chosen.example/callback"
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
const STATE = "rp-owned-state"

const SILENT_PARAMS = {
  prompt: "none",
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  state: STATE,
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: "S256",
  scope: "openid profile",
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * The English copy the page renders for a key, read out of the shipped
 * dictionary rather than duplicated here — the assertions are about WHICH
 * surface is shown, not about the wording.
 */
function enCopy(key: string): string {
  let node: unknown = enDict
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return key
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === "string" ? node : key
}

const REFUSAL_TITLE_KEY = "authorize.silentUnsupportedTitle"
const REFUSAL_DESC_KEY = "authorize.silentUnsupportedDesc"

// ---------------------------------------------------------------------------
// Delivery funnel — real implementation, harness window
// ---------------------------------------------------------------------------

/**
 * Captured BEFORE this file installs its own mock so the spy can never recurse,
 * and so the forward stays correct whichever order bun loads the authorize
 * suites in (`mock.module` is process-global): a caller that already supplied
 * its own window is passed straight through untouched.
 */
const webMessageModule = await import("@/lib/oauth-web-message")
const realExports = { ...webMessageModule }
const realDeliverOAuthResult = webMessageModule.deliverOAuthResult

type DeliverInput = Parameters<typeof realDeliverOAuthResult>[0]

const postMessage = mock(() => undefined)

const harness: {
  opener: { postMessage: typeof postMessage } | null
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
    input.window === globalThis.window ? { ...input, window: harness } : input,
  ),
)

// ---------------------------------------------------------------------------
// SDK surface
// ---------------------------------------------------------------------------

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

interface SessionState {
  isAuthenticated: boolean
  /** The device's active `principal acting as account` pair, or `null`. */
  activeContext: ReturnType<typeof contextRow> | null
  principals: ReturnType<typeof personWith>[]
  accessToken: string | null
}

/** No session at all: cold boot resolved and found nothing on this origin. */
const NO_SESSION: SessionState = {
  isAuthenticated: false,
  activeContext: null,
  principals: [],
  accessToken: null,
}

/** Directory rows survived a failed mint, but there is no usable bearer. */
const STALE_ACCOUNTS: SessionState = {
  isAuthenticated: false,
  // Rows, but nothing ACTIVE: the pair a bearer would have belonged to is not
  // established, which is exactly what "the mint failed" leaves behind.
  activeContext: null,
  principals: [
    personWith(contextRow({ contextId: "ctx-1", displayName: "Stale", handle: "stale", isActive: false })),
  ],
  accessToken: null,
}

/** Fully signed in here — the state a silent probe is fishing for. */
const NATE_CONTEXT = contextRow({
  contextId: "ctx-1",
  displayName: "Nate",
  handle: "nate",
  isActive: true,
})
const SIGNED_IN: SessionState = {
  isAuthenticated: true,
  activeContext: NATE_CONTEXT,
  principals: [personWith(NATE_CONTEXT)],
  accessToken: "bearer-token",
}

let sessionState: SessionState = NO_SESSION

const oxyServices = {
  getAccessToken: () => sessionState.accessToken,
  startCommonsSignIn: mock(async () => ({
    sessionToken: "unused",
    authorizeCode: "unused",
    qrPayload: "unused",
    expiresAt: Date.now() + 60_000,
    status: "pending",
  })),
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
  mock.module("@oxyhq/services", () =>
    createServicesMock({
      useOxy: () => ({
        user: null,
        oxyServices,
        isAuthResolved: true,
        isAuthenticated: sessionState.isAuthenticated,
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
      OxySignInRequestSurface: () =>
        React.createElement("div", { "data-testid": "signin-request-surface" }),
    }),
  )
}

installMocks()

const { AuthorizePage } = await import("@/src/pages/authorize")

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Answers as permissively as the server ever could — a resolved application and
 * "no consent needed" — so a refusal that leaked into the normal path would mint
 * a code and be impossible to mistake for a pass.
 */
const fetchMock = mock(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes("/auth/oauth/client/")) {
    return new Response(
      JSON.stringify({
        data: { application: { id: "app-1", name: "Example App", scopes: [] } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (url.includes("/auth/oauth/consent")) {
    return new Response(
      JSON.stringify({ data: { consentRequired: false, reason: "trusted" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }
  if (url.includes("/auth/oauth/authorize")) {
    return new Response(JSON.stringify({ data: { code: "minted-code" } }), {
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
            <Route path="/login" element={<div data-testid="login-page" />} />
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

/** Everything a refused request must NOT have done, asserted in one place. */
function expectNothingHappened(container: HTMLElement): void {
  // No work: the refusal is decided before any client lookup or consent probe.
  expect(fetchMock).not.toHaveBeenCalled()
  expect(oxyServices.startCommonsSignIn).not.toHaveBeenCalled()
  // Nothing delivered: no code, no OAuth error, no navigation, no relay.
  expect(deliverOAuthResult).not.toHaveBeenCalled()
  expect(harness.location.href).toBe("")
  expect(postMessage).not.toHaveBeenCalled()
  expect(harness.closed).toBe(false)
  // No other surface: not consent, not sign-in-here, not the Commons lane.
  expect(container.querySelector("[data-testid='consent-screen']")).toBeNull()
  expect(container.querySelector("[data-testid='login-page']")).toBeNull()
  expect(
    container.querySelector("[data-testid='signin-request-surface']"),
  ).toBeNull()
}

describe("AuthorizePage — a request that asks for prompt=none", () => {
  beforeEach(() => {
    installMocks()
    globalThis.fetch = fetchMock as unknown as typeof fetch
    fetchMock.mockClear()
    deliverOAuthResult.mockClear()
    postMessage.mockClear()
    oxyServices.startCommonsSignIn.mockClear()
    sessionState = NO_SESSION
    harness.opener = null
    harness.location = { href: "" }
    harness.closed = false
  })

  afterEach(() => {
    sessionState = NO_SESSION
  })

  test("the refusal copy is a real string, not a missing key", () => {
    expect(enCopy(REFUSAL_TITLE_KEY)).not.toBe(REFUSAL_TITLE_KEY)
    expect(enCopy(REFUSAL_DESC_KEY)).not.toBe(REFUSAL_DESC_KEY)
  })

  test("refuses on the page and does nothing else, with no session here", async () => {
    const { container, unmount } = await renderAuthorize(SILENT_PARAMS)

    const text = container.textContent ?? ""
    expect(text).toContain(enCopy(REFUSAL_TITLE_KEY))
    expect(text).toContain(enCopy(REFUSAL_DESC_KEY))
    expectNothingHappened(container)

    unmount()
  })

  test("refuses identically when stale device rows have no usable bearer", async () => {
    sessionState = STALE_ACCOUNTS
    const { container, unmount } = await renderAuthorize(SILENT_PARAMS)

    expect(container.textContent ?? "").toContain(enCopy(REFUSAL_TITLE_KEY))
    expectNothingHappened(container)

    unmount()
  })

  test("refuses a signed-in visitor too — never silently mints a code", async () => {
    sessionState = SIGNED_IN
    const { container, unmount } = await renderAuthorize(SILENT_PARAMS)

    // The server side of this test would happily hand over a code: the
    // application resolves and the consent probe answers `consentRequired:false`.
    // The page never asks, so no code exists to leak.
    expect(container.textContent ?? "").toContain(enCopy(REFUSAL_TITLE_KEY))
    expectNothingHappened(container)

    unmount()
  })

  test("answers the same whether or not someone is signed in here", async () => {
    sessionState = NO_SESSION
    const signedOut = await renderAuthorize(SILENT_PARAMS)
    const signedOutText = signedOut.container.textContent
    signedOut.unmount()

    sessionState = SIGNED_IN
    const signedIn = await renderAuthorize(SILENT_PARAMS)
    const signedInText = signedIn.container.textContent
    signedIn.unmount()

    // Byte-identical: asking cannot be used to probe this origin's session state.
    expect(signedInText).toBe(signedOutText)
  })

  test("never relays the refusal to an opener that asked for popup mode", async () => {
    sessionState = SIGNED_IN
    harness.opener = { postMessage }

    const { container, unmount } = await renderAuthorize({
      ...SILENT_PARAMS,
      response_mode: "web_message",
    })

    // A popup asking to be answered silently is answered on screen, not by a
    // message to its opener — the same refusal, whatever transport was requested.
    expect(container.textContent ?? "").toContain(enCopy(REFUSAL_TITLE_KEY))
    expectNothingHappened(container)

    unmount()
  })

  test("reflects nothing the caller supplied", async () => {
    const { container, unmount } = await renderAuthorize(SILENT_PARAMS)

    // Nothing was resolved and nothing is echoed, so the refusal cannot be
    // dressed up with an attacker-chosen target, state or challenge.
    const html = container.innerHTML
    expect(html).not.toContain(REDIRECT_URI)
    expect(html).not.toContain("attacker-chosen.example")
    expect(html).not.toContain(CLIENT_ID)
    expect(html).not.toContain(STATE)

    unmount()
  })

  test("leaves every other request alone — prompt=login still consents", async () => {
    sessionState = SIGNED_IN

    const { container, unmount } = await renderAuthorize({
      ...SILENT_PARAMS,
      prompt: "login",
      // A registered target, since this request takes the real path.
      redirect_uri: "https://app.example.com/callback",
    })
    // The normal path settles across several rounds (client lookup -> consent
    // probe -> authorize), each gated on a re-render.
    await act(async () => {
      await flush()
    })

    // The refusal is scoped to exactly `none`: this request resolved its
    // application, probed consent, and ran all the way through to a delivered
    // code — the behaviour the `prompt=none` tests above prove is unreachable.
    expect(container.textContent ?? "").not.toContain(enCopy(REFUSAL_TITLE_KEY))
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/auth/oauth/client/"),
      ),
    ).toBe(true)
    expect(deliverOAuthResult).toHaveBeenCalledTimes(1)
    const delivered = deliverOAuthResult.mock.calls[0]?.[0] as DeliverInput
    expect(delivered.result).toEqual({
      kind: "code",
      code: "minted-code",
      state: STATE,
    })

    unmount()
  })
})
