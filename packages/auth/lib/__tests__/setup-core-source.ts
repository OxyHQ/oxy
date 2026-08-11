/**
 * Resolve the auth app's `@oxyhq/core` imports for `bun test` without a prior
 * workspace build.
 *
 * Auth component tests import `@oxyhq/core` at runtime (`login-form.tsx` →
 * `isOxyRpOrigin`, `hub-passkey.tsx` → `getNormalizedUserHandle`, i18n helpers,
 * etc.). The package `exports` point at `dist/`, so an unbuilt workspace fails
 * with `Cannot find module '@oxyhq/core'`.
 *
 * Importing the full `@oxyhq/core` entry from source is not viable here — it
 * transitively pulls optional RN modules. Instead, re-export only the small
 * pure helpers auth actually uses, via relative paths into `packages/core/src`.
 *
 * THIS IS AN ALLOWLIST, and an allowlist silently rots: adding a `@oxyhq/core`
 * value import to app source without adding it here makes `bun test` abort the
 * WHOLE importing test file with `SyntaxError: Export named '…' not found`, so
 * its cases vanish from the run rather than failing loudly — that is how
 * `getNormalizedUserHandle` took four `hub-passkey` cases out of CI. Keep it in
 * step with app source; `core-mock-surface.test.ts` fails the build if it drifts.
 *
 * TEST-ONLY: never affects the Vite app build.
 */
import { mock } from "bun:test"
import { getCommonsApprovalBlockingReason } from "../../../core/src/utils/commonsApproval"
import { isOxyRpOrigin } from "../../../core/src/utils/webauthnOrigin"
import { getNormalizedUserHandle } from "../../../core/src/utils/userHandle"
import { translate } from "../../../core/src/i18n"
import { getBaseLanguage, normalizeLocale } from "../../../core/src/utils/languageUtils"
import { selectCommonsDelivery } from "../../../core/src/utils/commonsDelivery"
import { buildSwitcherRows, showsPrincipalHeaders } from "../../../core/src/session/deviceSwitcherRows"
import { projectDevicePrincipals } from "../../../core/src/session/deviceDirectory"

mock.module("@oxyhq/core", () => ({
    isOxyRpOrigin,
    getNormalizedUserHandle,
    getCommonsApprovalBlockingReason,
    translate,
    getBaseLanguage,
    normalizeLocale,
    // The shared "one primary delivery route" decision the OAuth-bound Commons
    // lane (`lib/commons-oauth-request.ts`) reuses rather than re-deciding.
    selectCommonsDelivery,
    // When the account chooser names the person above a row (ADR 0002). The IdP
    // asks the SAME question the SDK's own switcher asks, rather than deciding
    // for itself when an operator is worth stating.
    showsPrincipalHeaders,
    // The hub authorize page renders the chooser from the hub's directory
    // through the SAME projection the SDK's own switcher uses — one ordering and
    // grouping rule, not a second one for the IdP.
    buildSwitcherRows,
    projectDevicePrincipals,
}))
