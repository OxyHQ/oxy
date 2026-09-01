/**
 * The handshake between `authorize-surface-probe.tsx` and the test that builds
 * it. Kept in its own module because the probe itself cannot be imported by the
 * test: it pulls the real `@oxyhq/bloom` and `@oxyhq/services`, whose React
 * Native dependencies carry Flow syntax that `bun test` refuses to parse. The
 * probe is only ever reached through Vite, which strips Flow; the test only ever
 * needs what is declared here.
 */

/** Label on the subordinate action the probe hands the surface, in every case. */
export const SUBORDINATE_LABEL = "probe-subordinate-label"

/** Label on the alternative action the probe hands the surface, in every case. */
export const ALTERNATIVE_LABEL = "probe-alternative-label"

/** The property the built probe reports its outcome on. */
export const PROBE_GLOBAL = "__authorizeSurfaceProbe"

/**
 * The branches of `RequestPrimarySurface` the probe renders. Each one reaches a
 * DIFFERENT leading visual, so between them they cover every component the
 * surface can put on screen — which is the point, since any one of them arriving
 * `undefined` from the bundle is the same blank page (issue #784).
 */
export const PROBE_CASES = {
    /** No route resolved yet: React Native's `ActivityIndicator`. */
    preparing: "preparing",
    /** The cross-device handoff: `react-native-qrcode-svg` plus Bloom's `Text`. */
    qr: "qr",
    /** A route whose surface is elsewhere: `@expo/vector-icons`' glyph. */
    routeGlyph: "route-glyph",
    /** Terminally failed: Bloom's `Button`, and the alternatives rendered plainly. */
    failed: "failed",
} as const

export type ProbeCase = (typeof PROBE_CASES)[keyof typeof PROBE_CASES]

export interface ProbeCaseResult {
    /** `true` when the branch rendered; `false` when React refused an element. */
    ok: boolean
    /** The static markup, present only when {@link ok}. */
    html?: string
    /** The React error message, present only when the render threw. */
    error?: string
}

export type AuthorizeSurfaceProbeResult = Record<ProbeCase, ProbeCaseResult>
