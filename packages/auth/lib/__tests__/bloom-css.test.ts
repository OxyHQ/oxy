/**
 * The IdP's first-paint theme CSS.
 */
import { describe, expect, test } from "bun:test"
import { getBloomThemeCSS } from "@/lib/bloom-css"

describe("bloom-css", () => {
    test("getBloomThemeCSS returns a :root + .dark block for the preset", () => {
        const css = getBloomThemeCSS("oxy")
        expect(css).toContain(":root {")
        expect(css).toContain(".dark {")
        expect(css).toContain("--primary:")
        // Bloom 0.41 vivid accent trio — must not regress to the pre-0.41 HSL shape.
        expect(css).toContain("--tertiary:")
        expect(css).toContain("rgb(")
    })
})
