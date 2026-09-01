/**
 * Sign-up is passkey-only — password and social sign-up were removed
 * ecosystem-wide. The form collects ONLY a username (the backend register/verify
 * path reads `envelope.username` and nothing else) and calls
 * `useOxy().registerWithPasskey({ username })`; on success the SDK has committed
 * the device-first session and the form redirects to the OAuth authorize step.
 */
import { beforeEach, afterEach, describe, expect, mock, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"

const registerWithPasskey = mock(async (_params: { username: string }) => undefined)

// `mock.module` is process-global in bun (last writer wins across files), so
// expose the full services surface both auth forms consume — not just the two
// signup needs — to stay leak-safe if another test file's mock is registered
// later in the same run.
mock.module("@oxyhq/services", () => ({
    useOxy: () => ({
        handleWebSession: async () => undefined,
        registerWithPasskey,
        openAccountDialog: () => undefined,
        oxyServices: { lookupUsername: async () => ({ username: "", name: {}, avatar: null, color: null }) },
        signInWithPassword: async () => ({ status: "ok" as const }),
        signInWithPasskey: async () => undefined,
        completeTwoFactorSignIn: async () => ({}),
        revokeSuspiciousSignIn: async () => undefined,
        switchToAccount: async () => undefined,
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

const { SignUpForm } = await import("@/components/sign-up-form")

// The username availability check debounces a `fetch` to /auth/check-username.
// Stub it so typing a username never touches the network.
const originalFetch = globalThis.fetch
beforeEach(() => {
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ data: { available: true } }), {
            headers: { "content-type": "application/json" },
        })) as typeof fetch
})
afterEach(() => {
    globalThis.fetch = originalFetch
})

function renderForm(): { container: HTMLDivElement; unmount: () => void } {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
        root.render(
            <MemoryRouter>
                <SignUpForm redirectUri="https://app.example.com/cb" clientId="oxy_dk_test" />
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

function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
    )?.set
    setter?.call(input, value)
    input.dispatchEvent(new (window.Event)("input", { bubbles: true }))
}

async function flush(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

describe("SignUpForm — passkey signup", () => {
    beforeEach(() => {
        registerWithPasskey.mockClear()
        registerWithPasskey.mockImplementation(async () => undefined)
    })

    test("renders a username-only form (no password field)", () => {
        const { container, unmount } = renderForm()
        expect(container.querySelector("#passkey-username")).not.toBeNull()
        expect(container.querySelector('input[type="password"]')).toBeNull()
        unmount()
    })

    test("submitting the username-only form calls registerWithPasskey", async () => {
        const { container, unmount } = renderForm()

        const input = container.querySelector<HTMLInputElement>("#passkey-username")
        expect(input).not.toBeNull()
        act(() => {
            if (input) setInputValue(input, "newhuman")
        })

        const form = container.querySelector("form")
        act(() => {
            form?.dispatchEvent(new (window.Event)("submit", { bubbles: true, cancelable: true }))
        })
        await flush()

        expect(registerWithPasskey).toHaveBeenCalledTimes(1)
        expect(registerWithPasskey).toHaveBeenCalledWith({ username: "newhuman" })
        unmount()
    })

    test("a cancelled ceremony surfaces an inline message and stays on the passkey form", async () => {
        const cancel = Object.assign(new Error("timed out or was not allowed"), { name: "NotAllowedError" })
        registerWithPasskey.mockImplementation(async () => { throw cancel })

        const { container, unmount } = renderForm()
        const input = container.querySelector<HTMLInputElement>("#passkey-username")
        act(() => {
            if (input) setInputValue(input, "newhuman")
        })
        const form = container.querySelector("form")
        act(() => {
            form?.dispatchEvent(new (window.Event)("submit", { bubbles: true, cancelable: true }))
        })
        await flush()

        expect(registerWithPasskey).toHaveBeenCalledTimes(1)
        expect(container.querySelector("#passkey-username")).not.toBeNull()
        expect(container.textContent).toMatch(/dismissed/i)
        unmount()
    })
})
