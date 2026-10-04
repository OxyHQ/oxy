# Private inference commissioning source proof

Source `bd44a0b1784cad0c164b14cb2482ee6ad7b29c63` adds an explicit private catalogue admission path and an audited legal-review CLI. Production source authority remains absent. Deployment state stays `platform_internal` / `pending_review` / `disabled`; ordinary public requests remain denied. This is local source validation, not an activated Jev offer or a provider inference receipt.

The actual baseline catalogue implementation produces two meaningful failures with the same positive SQL/HTTP fixtures (unknown model and HTTP 404). It is restored byte for byte at that checkpoint. The final frozen source passes four suites / 40 selected tests against owned PostgreSQL 17, with normal migrations fresh and repeated through 0142. Tests cover missing legal/source/evidence, altered namespace/expiry, public denial, source withdrawal after the final lookup, and unavailable non-price scores.

The real HTTP router and SQL ledger reserve once and send once to synthetic transport, then reject replay. Negative requests create no monetary reserve, metered claim or send. The commercial fixture is synthetic; existing Alia internal-metered policy is covered separately in admission qualification. Neither fixture demonstrates live funding or provider behavior.

The actual compiled Node CLI defaults to dry-run. Explicit canonical plan-hash apply records legal review and an audit atomically. Owned SQL tests cover current reviewer authority, stale/foreign plans, concurrent apply and audit failure rollback. An existing reviewer ID records operator attribution; it is not an HTTP bearer. Node execution uses `NODE_ENV=test`. A production operation still requires root review of actual legal evidence, source tuple, serving image and fresh plan.

API build, scripts typecheck and path-scoped Biome pass. Five compiled modules are retained with hashes. Every observed owned PostgreSQL PID and postmaster file is absent. Earlier fixture/setup and dependency-build-race failures are retained without attribution to product behavior; `baseline-*` records identify the deliberate baseline comparison.

See [proof.json](proof.json) for exact source, record and compiled hashes. The initial commissioning lane is Alia. Mention's separate relationship and its early commercial admission path require a later composed proof before any activation.
