# I02 follow-up — response documentation and fixture intent

PR1556 review P3: finalizer description/OpenAPI now documents HTTP400
`invalid_scope` separately from other generic401 rejections; both finalizer
fixtures assert the exact error body. The generated artifact is included.

CI37083524699 shard4 exposed four fixtures that relied on the superseded empty
third-party request. Redirect/credential/app fixtures now explicitly request
registered `user:read`, including negatives so scope validation cannot hide
their intended assertion. The ordinary fallback fixture explicitly uses a
trusted application. Dedicated empty-third-party denial cases remain.

Own PostgreSQL17 loopback5574 and normal ephemeral Jest harness: three suites,
110 tests pass (`oauthAuthorizeRedirect`, `authSession.service`,
`oauthConsentFinalizers`). `bun scripts/check-openapi-fresh.mjs` passes:354paths,
409operations,12named inference paths,52credentialled operations,12payloads.
No production claim; I02 stays completed as a maintenance correction.

Five source hashes and two logs are pinned in proof.json. Runtime bot work
uncommitted in the same isolated worktree is excluded from these commits.
