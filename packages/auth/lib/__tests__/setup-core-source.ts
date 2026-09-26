/**
 * Resolve the auth app's `@oxy.so/core` imports for `bun test` without a prior
 * workspace build.
 *
 * Auth component tests import `@oxy.so/core` at runtime (`authorize.tsx` →
 * `getNormalizedUserHandle`, the i18n translator, etc.). The package `exports` point at `dist/`, so an unbuilt workspace fails
 * with `Cannot find module '@oxy.so/core'`.
 *
 * Importing the full `@oxy.so/core` entry from source is not viable here — it
 * transitively pulls optional RN modules. Instead, re-export only the small
 * pure helpers auth actually uses, via relative paths into `packages/core/src`.
 *
 * THIS IS AN ALLOWLIST, and an allowlist silently rots: adding a `@oxy.so/core`
 * value import to app source without adding it here makes `bun test` abort the
 * WHOLE importing test file with `SyntaxError: Export named '…' not found`, so
 * its cases vanish from the run rather than failing loudly — that is how
 * `getNormalizedUserHandle` once took four page cases out of CI. Keep it in
 * step with app source; `core-mock-surface.test.ts` fails the build if it drifts.
 *
 * TEST-ONLY: never affects the Vite app build.
 */
import { mock } from "bun:test"
import { getCommonsApprovalBlockingReason } from "../../../core/src/utils/commonsApproval"
import { getNormalizedUserHandle } from "../../../core/src/utils/userHandle"
import { getLocalesVersion, subscribeLocales, translate } from "../../../core/src/i18n"
import { selectCommonsDelivery } from "../../../core/src/utils/commonsDelivery"
import { createWebAuthStateStore } from "../../../core/src/session/authStateStore"

mock.module("@oxy.so/core", () => ({
    getNormalizedUserHandle,
    getCommonsApprovalBlockingReason,
    translate,
    // The translation hook re-renders when a lazily loaded dictionary lands.
    subscribeLocales,
    getLocalesVersion,
    // The shared "one primary delivery route" decision the OAuth-bound Commons
    // lane (`lib/commons-oauth-request.ts`) reuses rather than re-deciding.
    selectCommonsDelivery,
}))

mock.module("@oxy.so/core/session", () => ({
    // The bridge page's credential store — the SAME one this origin's provider
    // uses (`src/bridge.ts`, ADR 0029 D2).
    createWebAuthStateStore,
}))
