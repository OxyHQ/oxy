/**
 * Resolve the auth app's `@oxy.so/core` imports for `bun test` without a prior
 * workspace build.
 *
 * Auth component tests import `@oxy.so/core` at runtime (`authorize.tsx` →
 * `getNormalizedUserHandle`, the i18n translator, the hub's directory
 * projection, etc.). The package `exports` point at `dist/`, so an unbuilt workspace fails
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
import { translate } from "../../../core/src/i18n"
import { selectCommonsDelivery } from "../../../core/src/utils/commonsDelivery"
import { buildSwitcherRows } from "../../../core/src/session/deviceSwitcherRows"
import { projectDevicePrincipals } from "../../../core/src/session/deviceDirectory"

mock.module("@oxy.so/core", () => ({
    getNormalizedUserHandle,
    getCommonsApprovalBlockingReason,
    translate,
    // The shared "one primary delivery route" decision the OAuth-bound Commons
    // lane (`lib/commons-oauth-request.ts`) reuses rather than re-deciding.
    selectCommonsDelivery,
    // The hub authorize page renders the chooser from the hub's directory
    // through the SAME projection the SDK's own switcher uses — one ordering and
    // grouping rule, not a second one for the IdP.
    buildSwitcherRows,
    projectDevicePrincipals,
}))
