/**
 * Baseline `@oxyhq/services` mock for auth `bun test`.
 *
 * The real package pulls `react-native` at module load time, which bun cannot
 * parse in a node test env. `mock.module` is process-global and last-writer-wins
 * per test file — any per-file mock MUST include every export sibling suites
 * import (notably `useDeviceSwitcher`), or later files that import
 * `login-form.tsx` fall through to the real module and crash.
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
    handleWebSession: async () => undefined,
    registerWithPasskey: async () => undefined,
    openAccountDialog: () => undefined,
    oxyServices: {
        lookupUsername: async () => ({ username: "", name: {}, avatar: null, color: null }),
    },
    signInWithPassword: async () => ({ status: "ok" as const }),
    signInWithPasskey: async () => undefined,
    completeTwoFactorSignIn: async () => ({}),
    revokeSuspiciousSignIn: async () => undefined,
}

export function createServicesMock(
    overrides: Partial<{
        useOxy: () => Record<string, unknown>
        useDeviceSwitcher: typeof defaultDeviceSwitcher
        OxyAuthChooser: React.ComponentType<{ onComplete?: () => void }>
        OxyConsentScreen: React.ComponentType<Record<string, unknown>>
        OxySignInRequestSurface: React.ComponentType<Record<string, unknown>>
    }> = {},
) {
    return {
        useOxy: overrides.useOxy ?? (() => defaultUseOxyValue),
        useDeviceSwitcher: overrides.useDeviceSwitcher ?? defaultDeviceSwitcher,
        OxyAuthChooser:
            overrides.OxyAuthChooser ??
            (() => null as React.ReactElement | null),
        // `authorize.tsx` imports this statically, so once ANY suite has loaded
        // that page the export must exist in every later mock of this specifier
        // — otherwise bun cannot re-link the page and falls back to the real
        // (react-native-importing) module.
        OxyConsentScreen:
            overrides.OxyConsentScreen ??
            (() => null as React.ReactElement | null),
        // Same constraint: the authorize page's Commons lane renders the shared
        // sign-in request surface, imported statically from this specifier.
        OxySignInRequestSurface:
            overrides.OxySignInRequestSurface ??
            (() => null as React.ReactElement | null),
    }
}

mock.module("@oxyhq/services", () => createServicesMock())
