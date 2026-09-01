/**
 * The login form offers a "Sign in with a passkey" affordance on the identifier
 * step (first-party Oxy web origins only — the jsdom test host is `localhost`, a
 * loopback RP origin, so it renders). Selecting it runs the discoverable WebAuthn
 * ceremony via `useOxy().signInWithPasskey()`; on success the SDK has already
 * committed the device-first session, so the form just redirects. A dismissed /
 * aborted browser prompt surfaces a calm inline message instead of crashing.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"

const signInWithPasskey = mock(async () => undefined)

// `mock.module` is process-global in bun (last writer wins across files), so
// expose the full services surface both auth forms consume — including the
// signup-only `handleWebSession`/`registerWithPasskey` — to stay leak-safe.
mock.module("@oxyhq/services", () => ({
    useOxy: () => ({
        openAccountDialog: () => undefined,
        oxyServices: { lookupUsername: async () => ({ username: "", name: {}, avatar: null, color: null }) },
        signInWithPassword: async () => ({ status: "ok" as const }),
        signInWithPasskey,
        completeTwoFactorSignIn: async () => ({}),
        revokeSuspiciousSignIn: async () => undefined,
        switchToAccount: async () => undefined,
        handleWebSession: async () => undefined,
        registerWithPasskey: async () => undefined,
    }),
    useSwitchableAccounts: () => ({ isLoading: false, currentSessionId: null, accounts: [] }),
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

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

describe("LoginForm — passkey sign-in", () => {
    beforeEach(() => {
        signInWithPasskey.mockClear()
        signInWithPasskey.mockImplementation(async () => undefined)
    })

    test("shows the passkey button on the identifier step (loopback RP origin)", () => {
        const { container, unmount } = renderForm()
        expect(findButton(container, /sign in with a passkey/i)).toBeDefined()
        unmount()
    })

    test("clicking it invokes signInWithPasskey", async () => {
        const { container, unmount } = renderForm()
        const button = findButton(container, /sign in with a passkey/i)
        expect(button).toBeDefined()

        act(() => {
            button?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()

        expect(signInWithPasskey).toHaveBeenCalledTimes(1)
        unmount()
    })

    test("a cancelled ceremony surfaces an inline message and does not crash", async () => {
        const cancel = Object.assign(new Error("The operation was aborted."), { name: "NotAllowedError" })
        signInWithPasskey.mockImplementation(async () => { throw cancel })

        const { container, unmount } = renderForm()
        const button = findButton(container, /sign in with a passkey/i)

        act(() => {
            button?.dispatchEvent(new (window.MouseEvent || Event)("click", { bubbles: true }))
        })
        await flush()

        expect(signInWithPasskey).toHaveBeenCalledTimes(1)
        // The form is still mounted on the identifier step and shows the friendly
        // "dismissed" copy rather than the raw DOMException text.
        expect(container.textContent).toMatch(/dismissed/i)
        unmount()
    })
})
