/**
 * Baseline `@oxy.so/services` mock for auth `bun test`.
 *
 * The real package pulls `react-native` at module load time, which bun cannot
 * parse in a node test env. `mock.module` is process-global and last-writer-wins
 * per test file — any per-file mock MUST include every export sibling suites
 * import (build it with `createServicesMock`), or later files fall through to
 * the real module and crash.
 *
 * The SDK's sign-in screens are its own to test (`packages/services`); here
 * they are DOM stand-ins that keep what the IdP's pages depend on: a header's
 * title and description, and a picker row per account that hands its pair back.
 */
import { mock } from "bun:test"
import React from "react"

/**
 * A device with nobody on it — the chooser's "no rows" state.
 *
 * `principals` is grouped by PERSON (ADR 0002), so an empty array means no
 * signed-in humans, and `activeContext: null` means nothing is active. A suite
 * that needs rows overrides the whole hook.
 */
export const defaultDeviceSwitcher = () => ({
    isLoading: false,
    activeContext: null,
    principals: [] as unknown[],
    activatingContextId: null,
    removingContextId: null,
    removingPrincipalId: null,
    activateContext: async () => false,
    signOutContext: async () => false,
    signOutPrincipal: async () => false,
})

export const defaultUseOxyValue = {
    openAccountDialog: () => undefined,
    currentLanguage: "en-US",
    setLanguage: async () => undefined,
}

type PickerContext = { contextId: string; displayName: string; canActivate?: boolean }
type PickerProps = {
    principals: { contexts: PickerContext[] }[]
    onSelectContext: (context: PickerContext) => void
    onUseAnother: () => void
    isLoading?: boolean
}

const Null = () => null as React.ReactElement | null
const div = ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children)

export const stubAuthScreens = {
    OxyAuthScreen: div,
    OxyAuthScreenHeader: ({ title, description }: { title: string; description?: React.ReactNode }) =>
        React.createElement("div", null, React.createElement("h1", null, title), description ? React.createElement("p", null, description) : null),
    OxyAuthLoading: () => React.createElement("div", { "data-testid": "auth-loading" }),
    OxyAuthTerms: Null,
    OxyAccountPicker: ({ principals, onSelectContext, onUseAnother, isLoading }: PickerProps) =>
        React.createElement(
            "div",
            null,
            ...principals.flatMap((principal) =>
                principal.contexts.map((context) =>
                    React.createElement(
                        "button",
                        {
                            key: context.contextId,
                            type: "button",
                            "aria-label": `Continue as ${context.displayName}`,
                            disabled: isLoading || context.canActivate === false,
                            onClick: () => onSelectContext(context),
                        },
                        context.displayName,
                    ),
                ),
            ),
            React.createElement("button", { type: "button", onClick: onUseAnother, disabled: isLoading }, "Use another account"),
        ),
    OxySignInPanel: Null,
    OxySignUpPanel: Null,
    OxyCreateAccountPanel: Null,
    OxyRecoverAccountPanel: Null,
    OxyDeleteAccountPanel: Null,
}

export function createServicesMock(
    overrides: Partial<{
        useOxy: () => Record<string, unknown>
        useDeviceSwitcher: typeof defaultDeviceSwitcher
        OxyConsentScreen: React.ComponentType<Record<string, unknown>>
        OxySignInRequestSurface: React.ComponentType<Record<string, unknown>>
    }> = {},
) {
    return {
        ...stubAuthScreens,
        useOxy: overrides.useOxy ?? (() => defaultUseOxyValue),
        useDeviceSwitcher: overrides.useDeviceSwitcher ?? defaultDeviceSwitcher,
        OxyConsentScreen: overrides.OxyConsentScreen ?? Null,
        OxySignInRequestSurface: overrides.OxySignInRequestSurface ?? Null,
    }
}

mock.module("@oxy.so/services", () => createServicesMock())
