# Native active-context resume correction

A suspended trusted sibling missed the other app’s active-context switch. Returning to Mention left UI and an explicit profile read on the previous person; manual SDK refresh converged to the organization. Signing out the organization fell back to the remaining person, while the final principal logout did propagate and deny a fresh profile read. These are distinct observations.

The provider now reconciles on native inactive/background→active through the existing shared HTTP refresh, `SessionClient.bootstrap`, and runtime projection. Initial unknown→active performs no work. Foreground requests coalesce while pending; cleanup removes the listener. Isolated OAuth grants stay outside this lane and identity pinning stays in the canonical client/projection.

Frozen local RED: two failures and three passing negatives. The first five cases pass after correction; the review added an initialization negative. Final provider group: 40 tests; complete Services: 1,036 tests. Build, types and scoped lint pass. [proof.json](proof.json) binds inputs, actual outputs and root’s sanitized pre-fix Android observations. Android execution of the fixed candidate and later registry repetition remain separate acceptance steps.
