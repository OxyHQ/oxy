/**
 * Sign-up on the IdP (ADR 0024 D4): an account is created WITH its self-custody
 * root, in the canonical account flow, never on this page. The form therefore
 * collects nothing and calls no keyless registration; it opens the account flow
 * from the click (a popup needs the gesture) and, when that flow signs this
 * origin in, continues to `/authorize`.
 */
import { afterEach, describe, expect, mock, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { defaultDeviceSwitcher } from "@/lib/__tests__/setup-services-mock"

const registerWithPasskey = mock(async (_params: { username: string }) => undefined)
const openAccountDialog = mock((_view?: string) => undefined)
const startPasskeyHubSignIn = mock(async () => undefined)
let authenticated = false

// `mock.module` is process-global in bun (last writer wins across files), so
// expose the full services surface both auth forms consume.
mock.module("@oxy.so/services", () => ({
    useOxy: () => ({
        isAuthenticated: authenticated,
        accountDialogController: { startPasskeyHubSignIn },
        handleWebSession: async () => undefined,
        registerWithPasskey,
        openAccountDialog,
        oxyServices: { lookupUsername: async () => ({ username: "", name: {}, avatar: null, color: null }) },
        signInWithPassword: async () => ({ status: "ok" as const }),
        signInWithPasskey: async () => undefined,
        completeTwoFactorSignIn: async () => ({}),
        revokeSuspiciousSignIn: async () => undefined,
    }),
    useDeviceSwitcher: defaultDeviceSwitcher,
    OxyAuthChooser: () => null,
    OxyConsentScreen: () => null,
    OxySignInRequestSurface: () => null,
}))

const { SignUpForm } = await import("@/components/sign-up-form")

let location = ""
function LocationProbe() {
    location = `${useLocation().pathname}${useLocation().search}`
    return null
}

function renderForm(): { container: HTMLDivElement; rerender: () => void; unmount: () => void } {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    const tree = () => (
        <MemoryRouter initialEntries={["/signup"]}>
            <Routes>
                <Route path="/signup" element={<SignUpForm redirectUri="https://app.example.com/cb" clientId="oxy_dk_test" />} />
                <Route path="*" element={<LocationProbe />} />
            </Routes>
        </MemoryRouter>
    )
    act(() => root.render(tree()))
    return {
        container,
        rerender: () => act(() => root.render(tree())),
        unmount: () => {
            act(() => root.unmount())
            container.remove()
        },
    }
}

afterEach(() => {
    authenticated = false
    location = ""
    registerWithPasskey.mockClear()
    openAccountDialog.mockClear()
    startPasskeyHubSignIn.mockClear()
})

describe("SignUpForm — the canonical account flow", () => {
    test("collects no username or password here", () => {
        const { container, unmount } = renderForm()
        expect(container.querySelector("input")).toBeNull()
        unmount()
    })

    test("opens the account flow from the click and never registers a keyless account", () => {
        const { container, unmount } = renderForm()
        const button = [...container.querySelectorAll("button")].find((b) => /create account/i.test(b.textContent ?? ""))
        act(() => button?.dispatchEvent(new (window.MouseEvent)("click", { bubbles: true })))
        expect(openAccountDialog).toHaveBeenCalledWith("signin")
        expect(startPasskeyHubSignIn).toHaveBeenCalledTimes(1)
        expect(registerWithPasskey).not.toHaveBeenCalled()
        unmount()
    })

    test("continues to /authorize once the flow signs this origin in", () => {
        const { rerender, unmount } = renderForm()
        authenticated = true
        rerender()
        expect(location).toMatch(/^\/authorize\?/)
        unmount()
    })

    test("does not carry an already-signed-in visitor on as that account", () => {
        authenticated = true
        const { container, unmount } = renderForm()
        expect(container.textContent).toMatch(/create your account/i)
        expect(location).toBe("")
        unmount()
    })
})
