/**
 * HubPasskeyPage — the cross-origin passkey hub (b2), security-review
 * follow-up (PR #640, HIGH-1).
 *
 * `OxyAuthChooser` completing (a bearer planted on THIS origin — via a
 * passkey ceremony, Commons QR, OR silently tapping an already-active
 * account row) must NEVER by itself authorize the opener's pending session:
 * that would let an attacker who crafted their OWN `authorizeCode` get a
 * signed-in victim to authorize it just by tapping their own name (a
 * one-click login-CSRF). The authorize-code POST only fires from an
 * EXPLICIT "Authorize sign-in to <App>?" press, and when the app's origin
 * couldn't be verified, an additional un-defaulted checkbox must be checked
 * before that button even enables.
 *
 * `OxyAuthChooser` itself is stubbed (its own completion paths are tested in
 * @oxyhq/services) — this file isolates HubPasskeyPage's OWN gating logic.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { createServicesMock, defaultDeviceSwitcher } from "@/lib/__tests__/setup-services-mock"

const getCommonsApprovalInfo = mock(async () => ({
    application: { id: "app1", name: "Acme Widgets" },
    scopes: [],
    boundOrigin: "https://mention.earth",
    originVerified: true,
    expiresAt: Date.now() + 300_000,
    status: "pending",
}))
const denyCommonsSignIn = mock(async () => ({ success: true }))
const getAccessToken = mock(() => "access-token-for-nate")
const setView = mock(() => undefined)
let chooserOnComplete: (() => void) | undefined

// STABLE references across renders — mirrors the real SDK, where
// `oxyServices`/`accountDialogController` are held in a ref and never
// recreated. A fresh object literal per `useOxy()` call would make
// HubPasskeyPage's `useEffect([code, oxyServices])` see a "new" oxyServices
// on every render and loop forever re-fetching approval info.
const stableOxyServices = { getCommonsApprovalInfo, denyCommonsSignIn, getAccessToken }
const cancelSignIn = mock(() => undefined)
const stableController = { setView, cancelSignIn }
const stableUser = { id: "u1", username: "nate", name: { displayName: "Nate" } }

// `mock.module` is process-global in bun (last writer wins across files) —
// expose the full surface this page consumes, mirroring the leak-safe
// convention `login-form-passkey.test.tsx` established.
mock.module(
    "@oxyhq/services",
    () =>
        createServicesMock({
            useOxy: () => ({
                oxyServices: stableOxyServices,
                accountDialogController: stableController,
                user: stableUser,
            }),
            useDeviceSwitcher: defaultDeviceSwitcher,
            // Minimal stub: a single button that fires the SAME onComplete prop
            // OxyAuthChooser fires on every completion path (ceremony, QR,
            // active-account tap) — the real component's own paths are tested in
            // @oxyhq/services.
            OxyAuthChooser: ({ onComplete }: { onComplete?: () => void }) => {
                chooserOnComplete = onComplete
                return React.createElement(
                    "button",
                    { onClick: () => onComplete?.(), "data-testid": "complete-chooser" },
                    "complete (stub)",
                )
            },
        }),
)

const { HubPasskeyPage } = await import("@/src/pages/hub-passkey")

function renderPage(query = "code=CODE123"): { container: HTMLDivElement; unmount: () => void } {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
        root.render(
            <MemoryRouter initialEntries={[`/hub-passkey?${query}`]}>
                <HubPasskeyPage />
            </MemoryRouter>,
        )
    })
    return {
        container,
        unmount: () => {
            act(() => root.unmount())
            container.remove()
        },
    }
}

function findButton(container: HTMLElement, label: RegExp): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll("button")).find((b) => label.test(b.textContent ?? ""))
}

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

describe("HubPasskeyPage", () => {
    beforeEach(() => {
        getCommonsApprovalInfo.mockClear()
        getCommonsApprovalInfo.mockImplementation(async () => ({
            application: { id: "app1", name: "Acme Widgets" },
            scopes: [],
            boundOrigin: "https://mention.earth",
            originVerified: true,
            expiresAt: Date.now() + 300_000,
            status: "pending",
        }))
        denyCommonsSignIn.mockClear()
        getAccessToken.mockClear()
        setView.mockClear()
        cancelSignIn.mockClear()
        chooserOnComplete = undefined
        Object.defineProperty(window, "opener", { value: {}, configurable: true, writable: true })
        globalThis.fetch = mock(async () => new Response(JSON.stringify({ success: true }), { status: 200 })) as unknown as typeof fetch
    })

    test("(a) completing OxyAuthChooser does NOT authorize by itself — no network call fires", async () => {
        const { container, unmount } = renderPage()
        await flush()

        const completeButton = findButton(container, /complete \(stub\)/i)
        expect(completeButton).toBeDefined()
        act(() => {
            completeButton?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()

        expect(globalThis.fetch).not.toHaveBeenCalled()
        // Instead, the mandatory confirmation screen appears.
        expect(container.textContent).toMatch(/authorize sign-in to acme widgets/i)
        unmount()
    })

    test("(a) the authorize POST only fires on the explicit 'Authorize' press, AFTER the mandatory acknowledgement — even for a verified origin", async () => {
        // `originVerified` is derived from a client-suppliable Origin header on
        // an unauthenticated endpoint — a non-browser caller can forge it to a
        // trusted app's own origin, so the hub must never skip the
        // acknowledgement gate just because the server reports it verified.
        const { container, unmount } = renderPage()
        await flush()
        act(() => {
            chooserOnComplete?.()
        })
        await flush()

        const authorizeButton = findButton(container, /^authorize$/i)
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
        expect(authorizeButton).toBeDefined()
        expect(checkbox).toBeDefined()
        expect(authorizeButton?.disabled).toBe(true) // un-defaulted — required even when originVerified
        // Softer wording for the verified case — no "couldn't verify" alarm copy.
        expect(container.textContent).not.toMatch(/couldn't verify where this request came from/i)
        expect(container.textContent).toMatch(/i started this sign-in myself/i)

        act(() => {
            authorizeButton?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()
        expect(globalThis.fetch).not.toHaveBeenCalled() // disabled button, click is a no-op

        act(() => {
            checkbox?.click()
        })
        await flush()
        const enabledButton = findButton(container, /^authorize$/i)
        expect(enabledButton?.disabled).toBe(false)
        act(() => {
            enabledButton?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()

        expect(globalThis.fetch).toHaveBeenCalledTimes(1)
        const [url, init] = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
            string,
            RequestInit,
        ]
        expect(url).toContain("/session/authorize-code/CODE123")
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token-for-nate")
        unmount()
    })

    test("(b) an unverified origin disables Authorize until the acknowledgement checkbox is checked", async () => {
        getCommonsApprovalInfo.mockImplementation(async () => ({
            application: { id: "app2", name: "Sketchy Co" },
            scopes: [],
            boundOrigin: undefined,
            originVerified: false,
            expiresAt: Date.now() + 300_000,
            status: "pending",
        }))
        const { container, unmount } = renderPage()
        await flush()
        act(() => {
            chooserOnComplete?.()
        })
        await flush()

        const authorizeButton = findButton(container, /^authorize$/i)
        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
        expect(checkbox).toBeDefined()
        expect(authorizeButton?.disabled).toBe(true) // un-defaulted — must NOT be pre-checked
        // Stronger alarm copy for the unverified case (vs. the softer
        // "I started this myself" wording used when originVerified is true).
        expect(container.textContent).toMatch(/couldn't verify where this request came from/i)

        act(() => {
            authorizeButton?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()
        expect(globalThis.fetch).not.toHaveBeenCalled() // disabled button, click is a no-op

        act(() => {
            checkbox?.click()
        })
        await flush()
        expect(findButton(container, /^authorize$/i)?.disabled).toBe(false)

        act(() => {
            findButton(container, /^authorize$/i)?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()
        expect(globalThis.fetch).toHaveBeenCalledTimes(1)
        unmount()
    })

    test("'Not you?' returns to the chooser without denying the opener's pending flow", async () => {
        const { container, unmount } = renderPage()
        await flush()
        act(() => {
            chooserOnComplete?.()
        })
        await flush()
        expect(container.textContent).toMatch(/authorize sign-in to/i)

        const backButton = findButton(container, /not you\?/i)
        act(() => {
            backButton?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()

        expect(denyCommonsSignIn).not.toHaveBeenCalled()
        expect(cancelSignIn).toHaveBeenCalled()
        expect(setView).toHaveBeenCalledWith("accounts")
        expect(container.textContent).toMatch(/continue to acme widgets/i)
        unmount()
    })
})
