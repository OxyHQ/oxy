# Existing official application scopes-only seed

Source-only follow-up for Oxy #1571/#1572, based on main `8a9976a67594d15c4d1738954396ed45fdbd4fe0`. No production command was executed here.

The official seed now has a separate scopes-only path for explicit existing `ONLY_APP_IDS`. It unions the reviewed specification into existing application scopes, preserves every other application field (including `updatedAt`), and neither creates nor reconciles accounts, credentials, clients, bindings, grants or metadata. Mention's specification adds only `inference:invoke` and `inference:usage:read`; `isInternal=false` remains required. This does not provision funding, approve a deployment, activate a classifier, or grant user consent.

This retains the official seed's existing database-operator authority. It does not manufacture an HTTP session, staff identity, membership or delegated grant. The source Bun seed delegates to the same implementation; the production API build emits `packages/api/dist/scripts/seedOxyApplicationScopes.js`, and Dockerfile line 149 copies the complete API dist directory into the Node image. A new built image containing this source is required; existing production images are not claimed to include it.

## Operator sequence (root only, after source/image review)

With the existing injected database connection, first execute the compiled canonical CLI:

```sh
SCOPES_ONLY=true ONLY_APP_IDS=6a2f851751b784a86fd0e916 DRY_RUN=true \
  node packages/api/dist/scripts/seedOxyApplicationScopes.js
```

Review the returned application identity, canonical owner, current/desired scopes, every binding and credential projection, and `applyEligible`. Then run once using the exact returned hash:

```sh
SCOPES_ONLY=true ONLY_APP_IDS=6a2f851751b784a86fd0e916 DRY_RUN=false \
  EXPECTED_PLAN_SHA256=<reviewed-dry-run-planSha256> \
  node packages/api/dist/scripts/seedOxyApplicationScopes.js
```

No mutation retry is built in. A failure requires reconciliation and a fresh reviewed dry-run, not reuse of a stale hash. The command does not accept arguments, broad name filters, unknown IDs, duplicate IDs, an alternate platform username, or a hashless apply.

Dry-run uses repeatable-read/read-only. Apply uses serializable isolation, owner/application/binding/credential row locks, a re-read plan hash, and a prior-scopes compare-and-set. It rejects inactive/nonlocal owners, closure fences, dedicated-owner ancestry mismatch and exact application name/creator/owner/type/internal/official/status drift. It never repairs identity to make a scope change pass. All selected applications are validated before any write; an error rolls back the transaction. Statement/lock/idle timeouts are bounded; no automatic transaction retry is performed.

The hash includes all enumerated binding and credential scope/expiry/identity fields. Canonical effective-scope projection rejects an expansion on any non-target binding or non-workload credential, including empty-list inheritance. Only Mention's exact API binding/role is a permitted target. Workload attribution rows do not independently confer scopes. Expired/inactive rows are conservatively included, so future reactivation cannot silently inherit an unreviewed expansion. Human OAuth/session grant semantics are explicitly not inferred from this machine census.

The accepted live census supplied by root (22:39:15 UTC, Oxy704) observed two explicit Mention bindings and five credentials, with no non-target expansion; that observation is a locator, not a substitute for the CLI's fresh transactional checks. Production name/creator equality still must pass. After application scope apply, the API binding remains unchanged: the separate canonical `bindWorkloadIdentity` operation must add the two scopes to that exact existing API binding. MCP's previous scopes, owner and every other field remain untouched. No direct SQL mutation is prescribed.

## Validation

- Four package-owned Jest suites: 124 passed, including new real-SQL preservation, unknown/missing/identity/fence refusal, binding-expiry drift, empty MCP and service-credential expansion, multi-ID all-or-nothing validation and a row-lock race. The race observes the blocked database process before changing scopes; apply refuses and preserves the concurrent amendment.
- Actual compiled Node CLI on a separately owned migrated PostgreSQL instance: dry-run zero writes, apply only scopes, subsequent fresh-plan apply no-op. Node v24.21.0; no production runtime claim.
- API canonical dependency build passed. Four changed `src` files pass Biome with `--error-on-warnings`. The source Bun wrapper retains nine pre-existing Biome diagnostics, independently reproduced from its baseline Git blob; none is introduced by the delegation branch.
- Fresh/repeat normal migrations passed on both owned test databases; their processes stopped in `finally` and absence is recorded.
- Retained initial failures are fixture/type setup history: one TypeScript optional-env narrowing error, then an old literal specification assertion that required the explicitly authorized two-scope update. They are not claimed as product RED evidence. The final one-line template-literal formatting change in the test is semantically identical to the tested concatenation.

No AWS, production database, provider request, package publication, branch push or application activation occurred. No dependency manifest, lockfile or schema migration changed.
