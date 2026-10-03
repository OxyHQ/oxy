# Native requester fixture isolation, 2026-10-03

Source `60fa82ac9f60c55c2a7092c6474206bb80f76914`, baseline `aba5587e1`, PR #1557. CI previously failed API shard 6 because two real-HTTP suites shared a worker database and both needed Alia's canonical application ID with different owners/scopes. The collision made all 13 native requester cases fail before setup completed; closing an absent server then produced a secondary error.

The native suite now creates its own database with the existing normal 137-migration test mechanism. Teardown closes a server only if setup created it, closes the pool, drops only the owned database, and restores the worker URL even if cleanup fails. IDs, owner/scopes, middleware and production pilot matching are unchanged. It does not ignore or overwrite the other suite's row.

The owned rehearsal runner now preserves the explicit source order instead of Jest's duration-based order. Frozen original source reproduces 13 failed native cases / 30 passed inference cases when inference runs first. Corrected source passes two suites / 43 cases in both directions; PostgreSQL servers were stopped. Scoped ESLint passes.

Run from this worktree:

```sh
python3 scripts/rehearsal/test-approved-api-1519.py src/routes/__tests__/inferenceEdgeInternalMetered.test.ts src/routes/__tests__/nativeRequesterAssertion.routes.test.ts
python3 scripts/rehearsal/test-approved-api-1519.py src/routes/__tests__/nativeRequesterAssertion.routes.test.ts src/routes/__tests__/inferenceEdgeInternalMetered.test.ts
```

For RED, copy `red-harness.ts` verbatim to `packages/api/src/routes/__tests__/nativeRequesterAssertion.collision-red.test.ts`, run the first command with that native path, then remove the copy. The runner accepts test source paths only, provisions PostgreSQL on loopback, checks PID/UID/executable/data directory/socket ownership, and scrubs inherited connection overrides. `proof.json` binds source and records. This is fixture isolation, not a new production guarantee or provider test.
