/**
 * The authorize page's Commons lane must still render after the bundler has had
 * its way with it (issue #784).
 *
 * WHY THIS TEST IS SHAPED LIKE THIS. `auth.oxy.so/authorize` served a blank page
 * and React error #130 ("element type is undefined") for every request whose
 * `client_id` resolved to a real application — the only requests that reach
 * `CommonsOAuthLane`, and through it `@oxyhq/services`' `OxySignInRequestSurface`.
 * Nothing was wrong with the source: the same commit rendered the same URL
 * correctly under `vite` dev, and `components/__tests__/authorize-commons-lane.test.tsx`
 * was green throughout, because it — like every test in this package — replaces
 * the whole `@oxyhq/services` specifier with a double. The defect lived in the
 * production bundle and nowhere else.
 *
 * So this test builds the real thing: the app's OWN `vite.config.ts`, in
 * production mode, over `fixtures/authorize-surface-probe.tsx`. It then
 * evaluates the emitted chunk and asserts the surface rendered. A regression
 * fails here, in CI, with the same React message the browser reported.
 *
 * WHAT IT COVERS. Every element the surface draws, not just the surface itself —
 * the probe renders it, so an `undefined` React Native, Bloom or vendored
 * component anywhere beneath it throws out of `renderToStaticMarkup` too — and
 * all four of its leading visuals, which between them reach the activity
 * indicator, the QR plate, the vector-icon glyph and Bloom's button.
 *
 * WHAT IT DOES NOT COVER. Only this one surface. It is not a general "the bundle
 * links" check; nothing here would notice the same defect on another screen. See
 * `packages/services/README.md` for the condition that caused it, and why that
 * package cannot declare `sideEffects: false`.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { build } from "vite"
import {
    ALTERNATIVE_LABEL,
    PROBE_CASES,
    PROBE_GLOBAL,
    SUBORDINATE_LABEL,
    type AuthorizeSurfaceProbeResult,
} from "./fixtures/authorize-surface-probe-contract"

const PACKAGE_ROOT = resolve(import.meta.dir, "../..")
const PROBE_ENTRY = resolve(import.meta.dir, "fixtures/authorize-surface-probe.tsx")
/** Inside `dist/`, which is already git-ignored, so no new ignore rule is needed. */
const OUT_DIR = resolve(PACKAGE_ROOT, "dist/__authorize-surface-probe")
const BUNDLE = resolve(OUT_DIR, "probe.js")

async function buildAndEvaluateProbe(): Promise<AuthorizeSurfaceProbeResult> {
    await build({
        root: PACKAGE_ROOT,
        // The app's real config — plugins, aliases and platform-extension
        // resolution included. A bespoke config here would test a bundle the IdP
        // never ships.
        configFile: resolve(PACKAGE_ROOT, "vite.config.ts"),
        mode: "production",
        logLevel: "error",
        build: {
            outDir: OUT_DIR,
            emptyOutDir: true,
            // Unminified so a failure names the component instead of a mangled
            // identifier. Minification does not change how modules are linked,
            // which is the whole subject of this test.
            minify: false,
            rollupOptions: {
                input: PROBE_ENTRY,
                output: { entryFileNames: "probe.js", format: "es" },
            },
        },
    })

    // `react-native-web` installs its style sheet at module scope and reads the
    // global `ShadowRoot` that every browser exposes; `setup-dom.ts` mirrors it
    // onto `globalThis` for exactly this reason.
    await import(BUNDLE)

    const probe = (
        globalThis as typeof globalThis & {
            [PROBE_GLOBAL]?: AuthorizeSurfaceProbeResult
        }
    )[PROBE_GLOBAL]

    if (!probe) {
        throw new Error(
            `The built probe did not report on globalThis.${PROBE_GLOBAL} — it threw before it could.`,
        )
    }
    return probe
}

/**
 * Built and evaluated ONCE, at module scope, because the bundle is the fixture:
 * every assertion below reads the same artifact, and doing it per test would pay
 * for a full Vite build each time. Deliberately not wrapped in a per-test
 * timeout — that would only measure the assertions, which are instant.
 */
const probe = await buildAndEvaluateProbe()

afterAll(async () => {
    await rm(OUT_DIR, { recursive: true, force: true })
})

describe("the production bundle renders OxySignInRequestSurface, not undefined", () => {
    for (const name of Object.values(PROBE_CASES)) {
        test(`${name}: every element in the tree is a real component`, () => {
            const result = probe[name]
            expect(result).toBeDefined()
            // Asserted before `ok`, so a failure carries React's own message
            // ("Minified React error #130 … args[]=undefined") rather than just
            // `false`.
            expect(result.error).toBeUndefined()
            expect(result.ok).toBe(true)

            // A surface that rendered NOTHING would also satisfy "did not throw",
            // so require content: the always-visible subordinate link is on
            // every branch.
            expect(result.html ?? "").toContain(SUBORDINATE_LABEL)
        })
    }

    test("the preparing branch draws its leading visual", () => {
        // React Native's `ActivityIndicator` — the element `963f6e57` swapped
        // Bloom's `Loading` for, and the one the lane shows on first paint.
        expect(probe[PROBE_CASES.preparing].html ?? "").toContain('role="progressbar"')
    })

    test("the failed branch reveals the alternatives plainly", () => {
        // Everywhere else they sit inside Bloom's collapsed disclosure and are
        // not rendered at all, so this is the one case that proves the revealed
        // path builds its links.
        expect(probe[PROBE_CASES.failed].html ?? "").toContain(ALTERNATIVE_LABEL)
    })
})
