/**
 * Bundle entry for `authorize-surface-bundle.test.ts`. NOT part of the app.
 *
 * This file exists to be built by the IdP's OWN production Vite config and then
 * evaluated, because the failure it guards against (issue #784) exists only in
 * the bundle: `@oxyhq/services` and the app agree perfectly in source and under
 * the dev server, and the binding still arrived `undefined` at render time in
 * the production build. A source-level test cannot see it — the auth suite
 * replaces the whole `@oxyhq/services` specifier with a double — so the only
 * honest check is to render the real surface out of a real production bundle.
 *
 * It therefore imports EXACTLY the way `components/commons-oauth-request.tsx`
 * does: a named import of `OxySignInRequestSurface` from the package root. A
 * deep or namespace import links differently and would stop reproducing the
 * defect while still passing, which is the failure mode this test exists to
 * remove.
 *
 * `renderToStaticMarkup` is deliberate: it is synchronous and it throws on an
 * invalid element type, so an `undefined` component anywhere in the tree — the
 * surface itself, or any of the React Native, Bloom and vendored children it
 * draws — comes back as the same React error the browser reported instead of an
 * empty page.
 *
 * Every branch of the surface is rendered, not just the one that broke: the four
 * leading visuals reach four different sets of components, and the next one to
 * vanish from a bundle will not be the same one as last time.
 *
 * The results are handed over on `globalThis` rather than exported: the test
 * evaluates this bundle for its side effect, and a rejected top-level promise
 * would surface as an unhandled rejection instead of a readable assertion.
 */

import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { BloomThemeProvider } from "@oxyhq/bloom/theme"
import { OxySignInRequestSurface } from "@oxyhq/services"
import {
    ALTERNATIVE_LABEL,
    PROBE_CASES,
    PROBE_GLOBAL,
    SUBORDINATE_LABEL,
    type AuthorizeSurfaceProbeResult,
    type ProbeCase,
    type ProbeCaseResult,
} from "./authorize-surface-probe-contract"

/** Carries no real credential — the surface renders nothing derived from it. */
const QR_PAYLOAD = "oxycommons://approve?v=1&code=probe-code&nonce=probe&exp=1"

/** Handed to every case, so a surface that renders nothing cannot pass. */
const SUBORDINATE = [
    { key: "probe-cancel", label: SUBORDINATE_LABEL, onPress: () => undefined },
] as const

const ALTERNATIVES = [
    { key: "probe-elsewhere", label: ALTERNATIVE_LABEL, onPress: () => undefined },
] as const

type SurfaceProps = Parameters<typeof OxySignInRequestSurface>[0]

const CASE_PROPS: Record<ProbeCase, SurfaceProps> = {
    // The state the Commons lane is in on first paint, and the branch
    // auth.oxy.so/authorize was actually rendering when it went blank.
    [PROBE_CASES.preparing]: {
        route: null,
        progress: "idle",
        qrPayload: null,
        subordinate: SUBORDINATE,
        alternatives: ALTERNATIVES,
    },
    [PROBE_CASES.qr]: {
        route: "qr",
        progress: "awaiting-approval",
        qrPayload: QR_PAYLOAD,
        subordinate: SUBORDINATE,
        alternatives: ALTERNATIVES,
    },
    [PROBE_CASES.routeGlyph]: {
        route: "await-push",
        progress: "awaiting-approval",
        qrPayload: null,
        subordinate: SUBORDINATE,
        alternatives: ALTERNATIVES,
    },
    // `failed` also reveals the alternatives, so this is the one case whose
    // markup carries ALTERNATIVE_LABEL — everywhere else they stay inside
    // Bloom's collapsed disclosure and are not rendered at all.
    [PROBE_CASES.failed]: {
        route: null,
        progress: "idle",
        qrPayload: null,
        failed: true,
        onRetry: () => undefined,
        subordinate: SUBORDINATE,
        alternatives: ALTERNATIVES,
    },
}

/** The same theme the IdP mounts in `src/main.tsx`. */
function themed(child: ReactElement): ReactElement {
    return createElement(
        BloomThemeProvider,
        { mode: "system", colorPreset: "oxy" },
        child,
    )
}

function renderCase(props: SurfaceProps): ProbeCaseResult {
    try {
        return {
            ok: true,
            html: renderToStaticMarkup(themed(createElement(OxySignInRequestSurface, props))),
        }
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
}

const results = {} as AuthorizeSurfaceProbeResult
for (const name of Object.values(PROBE_CASES)) {
    results[name] = renderCase(CASE_PROPS[name])
}

const globalWithProbe = globalThis as typeof globalThis & {
    [PROBE_GLOBAL]?: AuthorizeSurfaceProbeResult
}
globalWithProbe[PROBE_GLOBAL] = results
