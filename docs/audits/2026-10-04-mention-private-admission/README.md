# Mention private classifier admission composition

A scoped Mention classifier approved for its own internal relationship was rejected while commercial charging was disabled, before its private catalogue route and quote could establish that relationship. The early guard returned `Scoped promotional funding integration is unavailable.`

The guard now defers only the exact Mention classifier candidate already identified from source approval and authenticated identity. The existing mandatory late decision still requires the exact canonical route, price and policy, USD quote at most 0.01, input budget 8192, current own-role authority and unexpired approval before a durable usage claim. Dispatch rechecks live authority. Other scoped commercial callers retain the original funding prerequisite. No economic decision is made from a caller flag, no trust field is changed, and no funds or grants are created.

## Composition

- Main runtime base: `f716a52734faa6e683f872802c67e9b7e419780f` (completion-only Alia budget fix retained).
- Mention relationship: `66c494787` + evidence `512f226cf` (PR1578).
- Private commissioning: PR1580 source `bd44a0b178`, reimport `c0c315612`, clean CI `2fb7391f7`, canonical CLI build `87777a08e`, and their evidence commits through `7740c7115`.
- This change adds only the narrow edge guard and one integration fixture. Production approval getters remain undefined.

## Verification

The frozen HTTP/SQL fixture runs in an owned, normally migrated PostgreSQL database. It uses a signed EdDSA service token, exact synthetic copies of Mention's own role/app/owner/binding/credential IDs, actual authentication/live authority, real catalogue/price/policy/metering and a loopback Express edge. Deployment-environment selection is set to production for this fixture; its database is local and isolated. Source approval getters and the Kaana response are explicitly synthetic. No AWS, external provider, production grant or billing operation is performed.

The reviewed route remains `platform_internal`, `pending_review`, `disabled` with real fixture legal metadata and a canonical stored routing policy requiring ZDR and prohibiting training. Ordinary catalogue reads remain closed. The scope and approval fixtures never change `isInternal=false`.

- Frozen final fixture on unmodified composition: **2 failed / 12 passed**, both positive HTTP paths refused 503 by the early commercial funding guard.
- Same exact fixture with fix: **14 passed**. The full six-suite selection: **110 passed**.
- Positives cover charging OFF and ON, one metered usage, zero reservations/receipts, daily limit 1 and concurrent limit 1.
- Negatives cover scope revocation, suspended app, foreign role, expired/missing approval, wrong price, expensive quote, withdrawn legal review, ZDR policy violation and revocation between attestation and claim. No negative dispatches a provider call or writes a usage claim.
- Existing Mention translation/commercial and Alia/internal suites remain green.
- Canonical API build, modified-source ESLint and canonical-config strict TypeScript including the new fixture: exit 0.
- Every owned PostgreSQL process is stopped, as recorded in the test logs.

Earlier setup failures are retained separately: a missing workspace telemetry build, a fixture environment mismatch, a wrong replay expectation (daily capacity is checked before duplicate identity), an unconstrained fixture policy that did not require ZDR, and an exploratory TypeScript parser invocation missing the canonical config path. These are not counted as product regressions. The final frozen red/green pair is authoritative.

This is activation-ready source composition only. No production source getter, catalogue permission, funding, role binding or deployed image was changed. Final approval and deployment remain separate operations.
