/**
 * DevicePage — approving a device sign-in (`codea login`) in a normal tab.
 *
 * The page adopts a request a device already created, keyed on its PUBLIC
 * code. What these cases pin is the part a regression would make dangerous:
 * a code is a handle anyone can mint for their OWN request, so a signed-in
 * victim opening an attacker's link must never approve it by reflex. The
 * authorize-code POST fires only from an explicit Allow press, after an
 * un-defaulted acknowledgement, at most once — and nothing at all happens for
 * a code that is malformed, expired, or opened with no session.
 *
 * `OxyConsentScreen` is stubbed to the two buttons and the error line this page
 * drives (its own rendering is tested in @oxy.so/services); the stub honours
 * `busy` and `allowDisabled` the way the real component does, so the gating
 * asserted here is the page's.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { createServicesMock, defaultDeviceSwitcher } from "@/lib/__tests__/setup-services-mock"
import { LocaleProvider } from "@/lib/i18n/locale-context"

const CODE = "0123456789abcdef0123456789abcdef"

function pendingApproval(overrides: Record<string, unknown> = {}) {
    return {
        application: { id: "app-codea", name: "Alia Codea CLI" },
        scopes: ["openid", "profile"],
        originVerified: false,
        expiresAt: Date.now() + 300_000,
        status: "pending",
        ...overrides,
    }
}

const getCommonsApprovalInfo = mock(async (_code: string) => pendingApproval())
const denyCommonsSignIn = mock(async (_code: string) => ({ success: true }))
let accessToken: string | null = "access-token-for-nate"
const getAccessToken = mock(() => accessToken)
let isAuthenticated = true

// STABLE across renders, as in the real SDK: a fresh object per `useOxy()` call
// would re-run the page's `useEffect([code, oxyServices])` on every render.
const stableOxyServices = { getCommonsApprovalInfo, denyCommonsSignIn, getAccessToken }
const stableUser = { id: "u1", username: "nate", name: { displayName: "Nate" } }

mock.module("@oxy.so/services", () =>
    createServicesMock({
        useOxy: () => ({
            oxyServices: stableOxyServices,
            user: isAuthenticated ? stableUser : null,
            isAuthResolved: true,
            isAuthenticated,
        }),
        useDeviceSwitcher: defaultDeviceSwitcher,
        OxyConsentScreen: (props: Record<string, unknown>) => {
            const busy = props.busy === true
            return React.createElement(
                "div",
                null,
                React.createElement(
                    "button",
                    {
                        "data-testid": "consent-allow",
                        disabled: busy || props.allowDisabled === true,
                        onClick: () => void (props.onAllow as () => unknown)(),
                    },
                    "Allow",
                ),
                React.createElement(
                    "button",
                    {
                        "data-testid": "consent-deny",
                        disabled: busy,
                        onClick: () => (props.onDeny as () => void)(),
                    },
                    "Deny",
                ),
                typeof props.error === "string"
                    ? React.createElement("p", { "data-testid": "consent-error" }, props.error)
                    : null,
            )
        },
    }),
)

const { DevicePage } = await import("@/src/pages/device")

function LocationProbe() {
    const location = useLocation()
    return React.createElement("div", { "data-testid": "location" }, `${location.pathname}${location.search}`)
}

function renderPage(query = `user_code=${CODE}`): { container: HTMLDivElement; unmount: () => void } {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
        root.render(
            <LocaleProvider>
                <MemoryRouter initialEntries={[`/device?${query}`]}>
                    <Routes>
                        <Route path="/device" element={<DevicePage />} />
                        <Route path="/login" element={<LocationProbe />} />
                    </Routes>
                </MemoryRouter>
            </LocaleProvider>,
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

const byTestId = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

function click(element: Element | null | undefined): void {
    act(() => {
        element?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
    })
}

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

describe("DevicePage", () => {
    beforeEach(() => {
        getCommonsApprovalInfo.mockClear()
        getCommonsApprovalInfo.mockImplementation(async () => pendingApproval())
        denyCommonsSignIn.mockClear()
        getAccessToken.mockClear()
        accessToken = "access-token-for-nate"
        isAuthenticated = true
        globalThis.fetch = mock(
            async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
        ) as unknown as typeof fetch
    })

    test("a malformed code sends no request at all", async () => {
        // `?code=` is the old name, and deliberately NOT read: the SDK's cold boot
        // consumes any `?code=` as an OAuth return and strips it (see device.tsx).
        for (const query of ["", `code=${CODE}`, "user_code=CODE123", `user_code=${CODE.toUpperCase()}`, `user_code=${CODE}0`]) {
            const { container, unmount } = renderPage(query)
            await flush()
            expect(container.textContent).toMatch(/no sign-in request/i)
            unmount()
        }
        expect(getCommonsApprovalInfo).not.toHaveBeenCalled()
        expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    test("an expired or used request is reported and offers nothing to approve", async () => {
        getCommonsApprovalInfo.mockImplementation(async () => pendingApproval({ status: "expired" }))
        const { container, unmount } = renderPage()
        await flush()

        expect(container.textContent).toMatch(/can't be used/i)
        expect(byTestId(container, "consent-allow")).toBeNull()
        expect(globalThis.fetch).not.toHaveBeenCalled()
        unmount()
    })

    test("a lookup that fails shows readable copy, never a raw translation key", async () => {
        getCommonsApprovalInfo.mockImplementation(async () => {
            throw new Error("404")
        })
        const { container, unmount } = renderPage()
        await flush()

        expect(container.textContent).toMatch(/could not be found/i)
        expect(container.textContent).not.toMatch(/device\.[a-zA-Z]/)
        expect(byTestId(container, "consent-allow")).toBeNull()
        unmount()
    })

    test("with no session it sends the person to sign in, carrying the code back", async () => {
        isAuthenticated = false
        accessToken = null
        const { container, unmount } = renderPage()
        await flush()

        const location = byTestId(container, "location")?.textContent ?? ""
        expect(location.startsWith("/login?")).toBe(true)
        expect(new URLSearchParams(location.slice("/login".length)).get("user_code")).toBe(CODE)
        expect(globalThis.fetch).not.toHaveBeenCalled()
        unmount()
    })

    test("Allow is inert until the un-defaulted acknowledgement is checked, then posts exactly once with the bearer", async () => {
        const { container, unmount } = renderPage()
        await flush()

        // The code is shown so it can be checked against the device's own.
        expect(byTestId(container, "device-code")?.textContent).toBe(CODE)
        // A CLI sends no Origin, so the unverified alarm wording applies.
        expect(container.textContent).toMatch(/couldn't verify where this request came from/i)

        const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
        expect(checkbox?.checked).toBe(false)
        expect(byTestId(container, "consent-allow")?.disabled).toBe(true)
        click(byTestId(container, "consent-allow"))
        await flush()
        expect(globalThis.fetch).not.toHaveBeenCalled()

        act(() => {
            checkbox?.click()
        })
        await flush()
        expect(byTestId(container, "consent-allow")?.disabled).toBe(false)

        // Two presses in the same tick: the in-flight guard lets one through.
        act(() => {
            const allow = byTestId(container, "consent-allow")
            allow?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
            allow?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()

        expect(globalThis.fetch).toHaveBeenCalledTimes(1)
        const [url, init] = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
            string,
            RequestInit,
        ]
        expect(url).toContain(`/session/authorize-code/${CODE}`)
        expect(init.method).toBe("POST")
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer access-token-for-nate")
        expect(container.textContent).toMatch(/you're signed in/i)
        unmount()
    })

    test("a failed approval surfaces the error and can be retried", async () => {
        globalThis.fetch = mock(
            async () => new Response(JSON.stringify({ message: "Request already used" }), { status: 409 }),
        ) as unknown as typeof fetch
        const { container, unmount } = renderPage()
        await flush()
        act(() => {
            ;(container.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.click()
        })
        await flush()

        click(byTestId(container, "consent-allow"))
        await flush()
        expect(byTestId(container, "consent-error")?.textContent).toBe("Request already used")
        expect(container.textContent).not.toMatch(/you're signed in/i)

        click(byTestId(container, "consent-allow"))
        await flush()
        expect(globalThis.fetch).toHaveBeenCalledTimes(2)
        unmount()
    })

    test("Deny declines the request and never posts an approval", async () => {
        const { container, unmount } = renderPage()
        await flush()

        click(byTestId(container, "consent-deny"))
        await flush()

        expect(denyCommonsSignIn).toHaveBeenCalledTimes(1)
        expect(denyCommonsSignIn.mock.calls[0]?.[0]).toBe(CODE)
        expect(globalThis.fetch).not.toHaveBeenCalled()
        expect(container.textContent).toMatch(/sign-in declined/i)
        unmount()
    })
})
