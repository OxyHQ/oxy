# Accepted source checkpoints composed for I01, I03 and billing

Source `982c67510f2d3795e60d5a378fc7e3d6da072019` composes I01 (PR1558), I03 approved freshness, and the I06/I07 catalogue/credit checkpoint (PR1557). It preserves the authorization-key check before epoch/grant/code persistence. Duplicate type declarations introduced during composition were removed; the OAuth-code service again matches I01's accepted source exactly.

The final clean-source rehearsal passed **10 suites / 136 tests** against a fresh normal PostgreSQL17 migration139. It covers autonomous account/key/MCP routes, the bot revocation-before-consent-persist race, live authority snapshot/epoch/ABA, native and pilot inference lanes, and credit/catalogue locks. The two independent SDK processes denied after revoke commit in **13.177010 ms locally**. This measures local test transport, not production p99 or a financial effect. The core build log and 63 compiled module hashes identify the SDK those processes loaded.

Additional service JWT fixtures passed 10 suites / 202 tests. Their positive tokens now use a single issuance timestamp and the approved300-second lifetime. The service-account switch fixture registers the offline scope its positive cases need; explicit negative scope overrides remain intact. Core combined focal39 and service-auth50 pass. API and scripts TypeScript, scoped ESLint, OpenAPI freshness and schema census pass. OpenAPI contains364 paths/419 operations; census223 tables/2630 columns. The earlier API type error from stale built contracts disappeared after rebuilding the composed contracts. No unrelated source workaround was added.

## Reproduction

Bun1.4.2, Node24.21.0, PostgreSQL17. Install/build follow the repository commands; package tests use each package's own script. From the source root:

```sh
python3 scripts/rehearsal/test-approved-api-1519.py src/routes/__tests__/nativeRequesterAssertion.routes.test.ts src/routes/__tests__/inferenceEdgeInternalMetered.test.ts src/routes/__tests__/serviceTokenCredentials.test.ts src/services/__tests__/approvedActingAsEpochs.test.ts src/services/__tests__/agentKeyAuth.test.ts src/services/__tests__/agentKeyGovernance.test.ts src/routes/__tests__/agentAutonomousFlow.test.ts src/routes/__tests__/mcpOAuth.routes.test.ts src/services/__tests__/subscriptionCreditLockOrder.test.ts src/services/__tests__/productBillingCatalogue.test.ts
bun scripts/check-openapi-fresh.mjs
bun scripts/test-check-openapi-fresh.mjs
bun scripts/check-no-payload-persistence.mjs
```

From `packages/core`, `bun run build`, then `bun run test --runInBand --runTestsByPath src/server/__tests__/agentAccount.test.ts src/api/__tests__/authAgent.test.ts src/api/__tests__/billing.test.ts src/server/__tests__/approvedActingAsFreshness.test.ts src/server/__tests__/approvedServiceTokenLifetime.test.ts`. From `packages/api`, `bunx tsc --noEmit` and `bun run typecheck:scripts`.

The owned runner accepts only API test paths, scrubs inherited PostgreSQL/DB URLs, checks PID/UID/executable/data/socket ownership, creates a disposable database and stops its server in finally. Its current scratch location is an owned temporary directory outside the checkout. The stdout files here are copied from its printed exact paths; this proof does not rely on launcher exit codes alone.

## Evidence and limits

`proof.json` pins128 source inputs,21 records and63 built core modules. `upstream-source-comparison.json` compares every input from the three independently accepted checkpoints: I01 59/63 identical; I03 23/27; billing28/31. Differences are the reviewed shared composition surfaces and intent-explicit test fixtures; the comparison lists each path. Source139 is I01's regenerated migration; billing introduced no new DDL at this composition step.

The first final rehearsal mistakenly supplied six nonexistent test paths. That invocation error and cleanup are retained; the corrected final full136 run passed. Diagnostic earlier fixture RED32 (old JWT fixtures) and RED12 (missing offline scope in positive fixture) are retained separately; their original uncommitted harness snapshots were not archived, so they are not presented as frozen harness replay proofs. The enforcement was preserved.

No monolithic API success, publication, deployment, provider transaction, production revocation deadline or receiver adoption is claimed. CI is checked separately at the pushed head. Forge is deliberately INACTIVE until the final source freeze and ARM/provenance review, with the existing09 Oct22:00UTC expiry retained. Two new I07 P2 reports remain assigned to integration: full catalogue-to-DB concordance and provider-accepted cancellation followed by local failure/app transfer. This checkpoint does not close those criteria.

Production token rollout must first stabilize the new API revision and retire old issuers; then refresh/remint affected callers. Rolling old3600-second issuers and new300-second validators can cause failures. Refreshing an old caller is separate from upgrading receivers to the new SDK that enforces live effects without an internal bypass.
