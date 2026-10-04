# I03 canary activity-only CAS failure

Attempt 2 returned `alia_canary_precondition_failed` before either receiver and reported existing authority unchanged plus cleanup confirmed. Its two CloudWatch events contain no more detailed precondition. This does not retrospectively prove which app xmin was read.

A PostgreSQL regression reproduces that result by updating only `applications.lastUsedAt` between prepare and issue. The real service-token endpoint performs that update after mint. The old pre-issue hash included app xmin, whereas the post-operation authority comparison already excluded it. The same frozen fixture fails 1/13 before the fix and passes 13/13 afterwards.

Issuance now compares the existing authority digest under the existing locks. Only app xmin is excluded: app identity/owner/type/status/scopes/official/internal flags, accounts with their versions, grants with versions, epochs, revocations and other credentials remain bound. Concurrent plans still permit only one insertion. Changed authority returns the closed diagnostic `alia_canary_precondition_failed:authority_snapshot_changed`; no values or verifier material are included.

The fresh TypeScript output is pinned as a separate operational module. Six staging controls, sixteen mocked AWS protocol tests, eight actual generated Node entrypoint controls and an own-database run against the original image's extracted dist passed. The latter updates activity before issuance, checks canonical revoke/recovery, rejects a changed owner, and verifies the original module/cached exports remain unchanged. All owned PostgreSQL processes were stopped and the generated databases dropped.

These are local corrective checks, not a successful live revocation measurement. Attempt 2 remains failed. Root must review a fresh operation before any further production execution; no old credential, nonce or clientToken is reused.
