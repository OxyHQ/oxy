/**
 * Module mocks for `bun test`. Imported BEFORE any component that pulls a
 * native-only Bloom subpath (e.g. `@oxyhq/bloom/avatar` or `@oxyhq/bloom/button`,
 * which transitively require `react-native` — a module bun cannot parse in a
 * node test environment). Keep this file dep-free — its job is solely to stub
 * native-only modules with web-safe surrogates.
 */
import { mock } from "bun:test"
import React from "react"

// The barrel re-exports toast from the RN graph (`react-native` condition), which
// bun cannot parse in a node test env. login-form / sign-up-form import toast
// from the subpath after the maintenance pass (avoid rolldown-vite barrel co-import).
const bloomToastStub = () => {
    const noop = () => undefined
    const toast = Object.assign(noop, {
        success: noop,
        error: noop,
        info: noop,
        warning: noop,
        loading: noop,
        promise: noop,
        dismiss: noop,
    })
    return { toast }
}

mock.module("@oxyhq/bloom", bloomToastStub)
mock.module("@oxyhq/bloom/toast", bloomToastStub)

mock.module("@oxyhq/bloom/avatar", () => ({
    Avatar: ({ source }: { source?: string }) =>
        React.createElement("span", { "data-avatar-source": source ?? "" }),
}))

// Web-safe surrogate for Bloom's Button. The published web build (0.10.0+) is a
// real HTML <button>, but its module still transitively imports `react-native`
// (theme + spinner), which bun cannot parse in a node test env — so we mirror
// the web Button's surface here: a real <button> honouring `type` / `onClick`
// (+ `onPress` alias), `disabled` / `loading`, `aria-label`, and children.
mock.module("@oxyhq/bloom/button", () => {
    const Button = ({
        children,
        icon,
        onPress,
        onClick,
        type = "button",
        disabled,
        loading,
        accessibilityLabel,
        testID,
    }: {
        children?: React.ReactNode
        icon?: React.ReactNode
        onPress?: () => void
        onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
        type?: "button" | "submit" | "reset"
        disabled?: boolean
        loading?: boolean
        accessibilityLabel?: string
        testID?: string
    }) => {
        const blocked = disabled || loading
        return React.createElement(
            "button",
            {
                type,
                onClick: blocked
                    ? undefined
                    : (event: React.MouseEvent<HTMLButtonElement>) => {
                          onClick?.(event)
                          onPress?.()
                      },
                disabled: blocked,
                "aria-label": accessibilityLabel,
                "aria-busy": loading || undefined,
                "data-testid": testID,
            },
            icon,
            children
        )
    }
    return {
        Button,
        PrimaryButton: Button,
        SecondaryButton: Button,
        GhostButton: Button,
        TextButton: Button,
        IconButton: Button,
        InverseButton: Button,
        OutlineButton: Button,
        LinkButton: Button,
        DestructiveButton: Button,
    }
})
