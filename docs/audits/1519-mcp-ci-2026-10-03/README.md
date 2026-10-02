# MCP package suite in CI

The composed source `a93c1016e73f6d13963d1d936bf5aca5f3fa9149` passes its own MCP `bun run test`: **9 suites / 49 tests**. This is local evidence; CI 37067834397 built MCP but did not run that suite.

Commit `01b02d9d1d1035f9726305a9dade4758a0ab0105` adds `MCP Tests: test` to `Package Tests (platform)` after contracts build. MCP imports contracts; the test step depends on that build outcome and keeps the grouped-job failure behavior. Tests execute directly through the package script and are never served from the Turbo build cache.

Scope derives package roots from workflow steps. A dedicated fixture proves MCP changes select both platform and the API that depends on MCP, while leaving unrelated apps out. The root census also requires MCP. Merge-group/push retain the complete suite and existing completion guard. Scope 39 cases, cache 28 fixtures and completion 43 fixtures pass on the tracked workflow commit.

`proof.json` pins each source to its actual commit and hashes the complete logs. A new Actions run must show the named MCP step before reporting MCP coverage there. No runtime, package release, permission or deployment change is included; Security Audit stays blocked.
