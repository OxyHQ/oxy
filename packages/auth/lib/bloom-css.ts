/**
 * The Bloom theme as CSS custom properties, for the IdP's first paint.
 *
 * `src/main.tsx` injects this as a `<style>` in `<head>` before React mounts,
 * so the very first frame is already themed (no flash of unthemed page);
 * `BloomThemeProvider` owns the theme from then on.
 */
import type { AppColorName } from "@oxy.so/bloom/color-presets"
import { getPresetVars } from "@oxy.so/bloom/preset-vars"

function presetToCSS(vars: Record<string, string>): string {
    // `getPresetVars` already yields full `rgb(...)` colours (the engine
    // resolves every role), so each value is a complete CSS colour — no
    // `hsl(...)` wrapping.
    return Object.entries(vars)
        .map(([key, value]) => `  ${key}: ${value};`)
        .join("\n")
}

/** `:root` + `.dark` custom properties for `preset`. */
export function getBloomThemeCSS(preset: AppColorName = "oxy"): string {
    return `:root {\n${presetToCSS(getPresetVars(preset, "light"))}\n}\n.dark {\n${presetToCSS(getPresetVars(preset, "dark"))}\n}`
}
