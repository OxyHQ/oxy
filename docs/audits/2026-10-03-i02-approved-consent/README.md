# I02 — approved OAuth consent fallback

Candidate implementing [ADR 0031](../../adr/0031-explicit-oauth-consent-fallback.md)
and issue #1521. Third-party empty OAuth requests fail with `invalid_scope`;
trusted fallback excludes all mandatory-consent scopes. The request, consent
screen, approval information and both finalizers share one resolver. Existing
explicit intersection behavior remains, including an empty result for an
unknown requested scope. No migration or existing-grant rewrite.

## Executed evidence

- RED: original runtime, updated approved-policy matrix: 5 expected failures,
  29 passes, real SQL. Both former empty-scope behaviors are demonstrated.
- Final: **5 suites / 152 tests pass**, no skipped cases. The command from
  `packages/api` is `TEST_DATABASE_URL=postgres://oxy_i01@127.0.0.1:5574/postgres bun run test --runInBand src/routes/__tests__/oauthConsentFinalizers.test.ts src/routes/__tests__/sessionApproveInfo.test.ts src/routes/__tests__/authSessionOAuthRequest.test.ts src/routes/__tests__/oauthConsentGrants.test.ts src/utils/__tests__/applicationScopes.test.ts`.
- API `bunx --no-install tsc --noEmit` passes. The baseline build compiled the
  eight dependencies and API before the runtime edits; the final typecheck is
  the changed-source check.
- Package-installed ESLint, six changed TypeScript files with
  `--max-warnings=0`: passes. Root `bunx biome` resolved an unrelated 0.3.3
  binary and its silent result is excluded from evidence. Explicitly installed
  `@biomejs/biome` **1.9.4** reports the same 30 diagnostics on the exact baseline
  and final six files: 22 `useTemplate`, 7 `useNodejsImportProtocol`, 1
  `useImportType`. Zero introduced; this is not a claim of a green full Biome run.

An intermediate new create-request fixture omitted its required sessionToken
and reached an earlier 400. It was corrected to supply the real required field;
the final test asserts the exact `invalid_scope` error and no AuthSession row.
A previous absent-scope normalization fixture now explicitly uses a trusted
application, consistent with the approved policy.

## Isolation and limits

PostgreSQL 17 on loopback port 5574, local role `oxy_i01`, data directory
`/tmp/inference-1519/i04-handoff-i01-i03/pgdata`, belongs to this agent. Existing
Jest global setup applies all migrations to its own `oxy_test_<16hex>` database;
teardown drops that database. Post-run catalog census contains only `postgres`
(excluding templates). The server remains running for I01/I03 tests; no other
agent's instance or database is used or stopped.

HTTP routes and domain persistence run against real PostgreSQL. Authentication,
rate-limiting and socket boundaries in these existing fixtures are synthetic;
this does not prove browser interaction, a deployed application or production
revocation latency. Issue #1521 remains open pending review/integration and its own
I02 acceptance criteria. I01 and I03 are separate work.

`proof.json` pins eight source/doc files and seven logs. The initial foundation
was 24653406; the source commit is rebased onto the approved inactive-Forge
foundation e4051d0 without changing implementation or proof source bytes.
