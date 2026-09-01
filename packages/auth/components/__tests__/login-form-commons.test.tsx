/**
 * The login form surfaces a "Sign in with Oxy" option on the identifier step,
 * alongside the passkey + security-key affordances. Selecting it opens the
 * shared services `OxyAccountDialog` (QR / Commons device-flow handoff) via
 * `useOxy().openAccountDialog('signin')`, replacing the IdP's former bespoke
 * inline QR step.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { defaultDeviceSwitcher } from "@/lib/__tests__/setup-services-mock"

// The button opens the services account dialog. Stub the services surface so the
// test can assert the dialog is opened with the 'signin' view without mounting
// the full OxyProvider / RN overlay stack. `useDeviceSwitcher` returns no
// accounts → the form opens on the identifier step (not the chooser / loading
// spinner), where the third option lives.
const openAccountDialog = mock(() => undefined)
mock.module("@oxyhq/services", () => ({
    useOxy: () => ({
        openAccountDialog,
        oxyServices: { lookupUsername: async () => ({ username: "", name: {}, avatar: null, color: null }) },
        signInWithPassword: async () => ({ status: "ok" as const }),
        completeTwoFactorSignIn: async () => ({}),
    }),
    useDeviceSwitcher: defaultDeviceSwitcher,
    // No-op stubs — this suite never renders them, but `mock.module` is
    // process-global (last writer wins across files), so every export a
    // sibling suite's page imports statically must be defined here too:
    // `OxyAuthChooser` for hub-passkey.test.tsx, `OxyConsentScreen` and
    // `OxySignInRequestSurface` for authorize-commons-lane.test.tsx.
    OxyAuthChooser: () => null,
    OxyConsentScreen: () => null,
    OxySignInRequestSurface: () => null,
}))

const { LoginForm } = await import("@/components/login-form")

function renderForm(): { container: HTMLDivElement; unmount: () => void } {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
        root.render(
            <MemoryRouter>
                <LoginForm />
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
    return Array.from(container.querySelectorAll("button")).find((b) =>
        label.test(b.textContent ?? ""),
    )
}

describe("LoginForm — Sign in with Oxy option", () => {
    beforeEach(() => {
        openAccountDialog.mockClear()
    })

    test("shows the 'Sign in with Oxy' option on the identifier step", () => {
        const { container, unmount } = renderForm()
        expect(findButton(container, /sign in with oxy/i)).toBeDefined()
        unmount()
    })

    test("selecting it opens the account dialog on the sign-in view", () => {
        const { container, unmount } = renderForm()
        const option = findButton(container, /sign in with oxy/i)
        expect(option).toBeDefined()

        act(() => {
            option?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })

        expect(openAccountDialog).toHaveBeenCalledWith("signin")
        unmount()
    })
})
