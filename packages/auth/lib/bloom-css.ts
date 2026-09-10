/**
 * Bloom color preset utilities for the auth app.
 *
 * Each preset is rendered as a `<style id="bloom-color-preset-${scope}">` block
 * in `<head>` containing `:root { ... }` + `.dark { ... }` CSS custom property
 * declarations. Scopes layer via document-order cascade:
 *   - `"base"` — the persistent app theme, set once on boot via `setBasePreset`
 *     and updated whenever the active user/account changes (lookup, sign-in).
 *   - any other scope (e.g. `"chooser-hover"`) — transient overlays whose rules
 *     win over `"base"` because they're appended later. Removing the scope
 *     element via `restoreBasePreset(scope)` lets the base preset bleed through.
 */
import { APP_COLOR_NAMES, type AppColorName } from "@oxy.so/bloom/color-presets"
import { getPresetVars } from "@oxy.so/bloom/preset-vars"

const BASE_SCOPE = "base"
const STYLE_ID_PREFIX = "bloom-color-preset-"

let _bloomBasePreset: AppColorName | null = null

function styleIdFor(scope: string): string {
    return `${STYLE_ID_PREFIX}${scope}`
}

function presetToCSS(vars: Record<string, string>): string {
    // `getPresetVars` already yields full `rgb(...)` colours (the engine
    // resolves every role), so each value is a complete CSS colour — no
    // `hsl(...)` wrapping.
    return Object.entries(vars)
        .map(([key, value]) => `  ${key}: ${value};`)
        .join("\n")
}

function presetToScopedCSS(preset: AppColorName): string {
    return `:root {\n${presetToCSS(getPresetVars(preset, "light"))}\n}\n.dark {\n${presetToCSS(getPresetVars(preset, "dark"))}\n}`
}

/**
 * Returns a `<style>`-ready CSS string with `:root` + `.dark` custom properties
 * for the given preset. Used for synchronous early injection from the document
 * head (FOUC prevention) before React mounts.
 */
export function getBloomThemeCSS(preset: AppColorName = "oxy"): string {
    return presetToScopedCSS(preset)
}

function isAppColorName(value: unknown): value is AppColorName {
    return (
        typeof value === "string" &&
        (APP_COLOR_NAMES as readonly string[]).includes(value)
    )
}

/**
 * Inject (or update) a scoped color preset style block. Unknown presets are a
 * no-op: callers may pass user-controlled / null / undefined values without
 * risk. Re-appending on every apply keeps the scope's rules positioned AFTER
 * earlier scopes in document order, so later applies win the cascade.
 */
export function applyColorPreset(
    preset: AppColorName | string | null | undefined,
    scope: string = BASE_SCOPE
): void {
    if (typeof document === "undefined") return
    if (!isAppColorName(preset)) return

    const id = styleIdFor(scope)
    const css = presetToScopedCSS(preset)

    const existing = document.getElementById(id)
    if (existing instanceof HTMLStyleElement) {
        if (existing.textContent !== css) existing.textContent = css
        // Re-append so the scope wins over any earlier styles in the cascade
        // (matters when a transient scope is layered on top of the base).
        document.head.appendChild(existing)
        return
    }

    const el = document.createElement("style")
    el.id = id
    el.textContent = css
    document.head.appendChild(el)
}

/**
 * Capture the base preset at app boot (or whenever the active account's theme
 * changes) AND apply it to the `"base"` scope. Subsequent `restoreBasePreset`
 * calls will reapply this preset defensively if the base style block has been
 * removed.
 */
export function setBasePreset(preset: AppColorName | string | null | undefined): void {
    if (!isAppColorName(preset)) return
    _bloomBasePreset = preset
    applyColorPreset(preset, BASE_SCOPE)
}

/**
 * Tear down a transient scope (e.g. a hover overlay) so the base preset's rules
 * apply unobstructed. Pass the `scope` you applied with `applyColorPreset`.
 *
 * - The base scope itself is never removed by this function; callers must use
 *   `setBasePreset` to change it.
 * - As a defensive measure, the base preset is re-applied if it was previously
 *   captured via `setBasePreset` — this guarantees the base style block is
 *   present after the transient scope is removed.
 */
export function restoreBasePreset(scope: string): void {
    if (typeof document === "undefined") return
    if (scope !== BASE_SCOPE) {
        const el = document.getElementById(styleIdFor(scope))
        if (el) el.remove()
    }
    if (_bloomBasePreset) {
        applyColorPreset(_bloomBasePreset, BASE_SCOPE)
    }
}

/**
 * Test-only reset. Clears the captured base preset AND removes every preset
 * style block from the document. Not part of the production surface.
 */
export function __resetBloomCSSForTests(): void {
    _bloomBasePreset = null
    if (typeof document === "undefined") return
    const nodes = document.head.querySelectorAll(`style[id^="${STYLE_ID_PREFIX}"]`)
    nodes.forEach((node) => node.remove())
}
