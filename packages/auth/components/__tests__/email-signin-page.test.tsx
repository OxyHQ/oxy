/**
 * `/email-signin` — where the sign-in email's link lands, and `/login`'s
 * account creation.
 *
 * The link page approves the request with THIS browser's Oxy device and never
 * signs the page in (the app's own screen collects the session). What these
 * cases pin: the token leaves the address bar at once; with no device here it
 * never calls the API and says to open the link where the sign-in started; the
 * API's "other device" and "spent" answers each say what to do.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { createServicesMock } from "@/lib/__tests__/setup-services-mock"

const DEVICE = { deviceId: "dev-1", deviceSecret: "s".repeat(43) }
let device: typeof DEVICE | null = DEVICE
const readDeviceProof = mock(async () => device)
const approveEmailSignInLink = mock(async (_token: string, _device?: unknown): Promise<unknown> => ({ approved: true }))
let isAuthResolved = true
const stableOxyServices = { readDeviceProof, approveEmailSignInLink }

mock.module("@oxy.so/services", () =>
    createServicesMock({
        useOxy: () => ({ oxyServices: stableOxyServices, isAuthResolved, currentLanguage: "en-US", setLanguage: async () => undefined }),
    }),
)

const { EmailSignInPage, readLinkToken } = await import("@/src/pages/email-signin")
const { LoginPage } = await import("@/src/pages/login")

function render(element: React.ReactElement, path: string): { container: HTMLDivElement; unmount: () => void } {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
        root.render(
            <MemoryRouter initialEntries={[path]}>
                <Routes>
                    <Route path={path.split("?")[0]} element={element} />
                </Routes>
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

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

const has = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="${id}"]`) !== null

function openLink(hash: string) {
    window.history.replaceState(null, "", `/email-signin${hash}`)
    return render(<EmailSignInPage />, "/email-signin")
}

describe("readLinkToken", () => {
    test("reads `#t=` and nothing else", () => {
        expect(readLinkToken("#t=abc_DEF-123")).toBe("abc_DEF-123")
        expect(readLinkToken("#t=")).toBeNull()
        expect(readLinkToken("")).toBeNull()
        expect(readLinkToken("#x=1")).toBeNull()
    })
})

describe("EmailSignInPage", () => {
    beforeEach(() => {
        device = DEVICE
        isAuthResolved = true
        readDeviceProof.mockClear()
        approveEmailSignInLink.mockClear()
        approveEmailSignInLink.mockImplementation(async () => ({ approved: true }))
    })

    test("approves with this browser's device, strips the token, and sends the person back to the app", async () => {
        const page = openLink("#t=TOKEN123")
        expect(window.location.hash).toBe("")
        await flush()

        expect(approveEmailSignInLink).toHaveBeenCalledWith("TOKEN123", DEVICE)
        expect(has(page.container, "email-signin-approved")).toBe(true)
        expect(page.container.textContent).toContain("You're signed in")
        page.unmount()
    })

    test("waits for the provider's boot before it reads the device", async () => {
        isAuthResolved = false
        const page = openLink("#t=TOKEN123")
        await flush()
        expect(readDeviceProof).not.toHaveBeenCalled()
        expect(has(page.container, "auth-loading")).toBe(true)
        page.unmount()
    })

    test("with no Oxy device in this browser: never calls the API, says to open it where the sign-in started", async () => {
        device = null
        const page = openLink("#t=TOKEN123")
        await flush()

        expect(approveEmailSignInLink).not.toHaveBeenCalled()
        expect(has(page.container, "email-signin-other-device")).toBe(true)
        expect(page.container.textContent).toContain("Open the link in the same browser")
        page.unmount()
    })

    test("in another browser's device: the same answer", async () => {
        approveEmailSignInLink.mockImplementation(async () => {
            throw Object.assign(new Error("other"), { code: "SIGNIN_LINK_OTHER_DEVICE", status: 403 })
        })
        const page = openLink("#t=TOKEN123")
        await flush()
        expect(has(page.container, "email-signin-other-device")).toBe(true)
        page.unmount()
    })

    test("a spent or expired link says to ask for a new email or type the code", async () => {
        approveEmailSignInLink.mockImplementation(async () => {
            throw Object.assign(new Error("spent"), { code: "SIGNIN_LINK_INVALID", status: 401 })
        })
        const page = openLink("#t=TOKEN123")
        await flush()
        expect(has(page.container, "email-signin-invalid")).toBe(true)
        expect(page.container.textContent).toContain("This link can't be used")
        page.unmount()
    })

    test("no token at all: nothing is sent", async () => {
        const page = openLink("")
        await flush()
        expect(readDeviceProof).not.toHaveBeenCalled()
        expect(has(page.container, "email-signin-invalid")).toBe(true)
        page.unmount()
    })
})

describe("LoginPage", () => {
    test("renders the SDK's sign-in, and creates an account in place", () => {
        const page = render(<LoginPage />, "/login")
        expect(has(page.container, "stub-signin-panel")).toBe(true)

        act(() => {
            page.container.querySelector<HTMLButtonElement>('[data-testid="stub-signin-panel"]')?.click()
        })
        expect(has(page.container, "stub-signup-panel")).toBe(true)

        act(() => {
            page.container.querySelector<HTMLButtonElement>('[data-testid="stub-signup-panel"]')?.click()
        })
        expect(has(page.container, "stub-signin-panel")).toBe(true)
        page.unmount()
    })

    test("`?screen=signup` starts at account creation", () => {
        const page = render(<LoginPage />, "/login?screen=signup")
        expect(has(page.container, "stub-signup-panel")).toBe(true)
        page.unmount()
    })
})
