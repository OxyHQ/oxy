/**
 * The login form offers a "Sign in with a security key" affordance on the
 * identifier step (first-party Oxy web origins only — the jsdom host is
 * `localhost`, a loopback RP origin, so it renders). Unlike the discoverable
 * "Sign in with a passkey" button, this one reveals a handle step first: a
 * NON-discoverable hardware key (U2F, e.g. a Google Titan) can't be located by a
 * usernameless ceremony, so the typed username scopes the server's WebAuthn
 * `allowCredentials` to that user's registered keys. Selecting it and submitting
 * a handle calls `useOxy().signInWithPasskey({ username })`.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { defaultDeviceSwitcher } from "@/lib/__tests__/setup-services-mock"

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
        handleWebSession: async () => undefined,
        registerWithPasskey: async () => undefined,
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

describe("LoginForm — security-key sign-in", () => {
    beforeEach(() => {
        signInWithPasskey.mockClear()
        signInWithPasskey.mockImplementation(async () => undefined)
    })

    test("shows the security-key button on the identifier step (loopback RP origin)", () => {
        const { container, unmount } = renderForm()
        expect(findButton(container, /sign in with a security key/i)).toBeDefined()
        unmount()
    })

    test("selecting it reveals a handle input and does not fire the ceremony yet", () => {
        const { container, unmount } = renderForm()
        act(() => {
            findButton(container, /sign in with a security key/i)?.dispatchEvent(
                new (window.MouseEvent)("click", { bubbles: true }),
            )
        })
        // The handle step is now shown; the ceremony has NOT been invoked (it
        // only fires on submit, once the user supplies a username).
        expect(container.querySelector("#security-key-identifier")).not.toBeNull()
        expect(signInWithPasskey).not.toHaveBeenCalled()
        unmount()
    })

    test("submitting the handle calls signInWithPasskey with the typed username", async () => {
        const { container, unmount } = renderForm()
        act(() => {
            findButton(container, /sign in with a security key/i)?.dispatchEvent(
                new (window.MouseEvent)("click", { bubbles: true }),
            )
        })

        const input = container.querySelector<HTMLInputElement>("#security-key-identifier")
        expect(input).not.toBeNull()
        act(() => {
            if (input) setInputValue(input, "titanuser")
        })

        const form = container.querySelector("form")
        act(() => {
            form?.dispatchEvent(new (window.Event)("submit", { bubbles: true, cancelable: true }))
        })
        await flush()

        expect(signInWithPasskey).toHaveBeenCalledTimes(1)
        // Username-first: the handle is forwarded so the server scopes
        // allowCredentials to that user's keys (the U2F path).
        expect(signInWithPasskey).toHaveBeenCalledWith(
            expect.objectContaining({ username: "titanuser" }),
        )
        unmount()
    })

    test("an empty handle does not fire the ceremony", async () => {
        const { container, unmount } = renderForm()
        act(() => {
            findButton(container, /sign in with a security key/i)?.dispatchEvent(
                new (window.MouseEvent)("click", { bubbles: true }),
            )
        })

        const form = container.querySelector("form")
        act(() => {
            form?.dispatchEvent(new (window.Event)("submit", { bubbles: true, cancelable: true }))
        })
        await flush()

        expect(signInWithPasskey).not.toHaveBeenCalled()
        unmount()
    })

    test("a cancelled ceremony surfaces an inline message and stays on the handle step", async () => {
        const cancel = Object.assign(new Error("The operation was aborted."), { name: "NotAllowedError" })
        signInWithPasskey.mockImplementation(async () => { throw cancel })

        const { container, unmount } = renderForm()
        act(() => {
            findButton(container, /sign in with a security key/i)?.dispatchEvent(
                new (window.MouseEvent)("click", { bubbles: true }),
            )
        })
        const input = container.querySelector<HTMLInputElement>("#security-key-identifier")
        act(() => {
            if (input) setInputValue(input, "titanuser")
        })
        const form = container.querySelector("form")
        act(() => {
            form?.dispatchEvent(new (window.Event)("submit", { bubbles: true, cancelable: true }))
        })
        await flush()

        expect(signInWithPasskey).toHaveBeenCalledTimes(1)
        // Still on the handle step, showing the calm "dismissed" copy.
        expect(container.querySelector("#security-key-identifier")).not.toBeNull()
        expect(container.textContent).toMatch(/dismissed/i)
        unmount()
    })
})
