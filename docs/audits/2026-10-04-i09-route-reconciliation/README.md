# Exact post-operation route reconciliation

The original caller completed once. The second post task failed because its
external guard required `final_authorized_*` even for the explicit-model path.
The read-only diagnostic established the failure stage; it was not a successful
post reconciliation and did not invoke the duplicate-event writer.

Production source explains the NULLs: `claimMeteredAdmission` stores the admitted
tuple, while `inferenceEdge.service.ts` calls `finalizeMeteredAuthorization` only
when a preclaimed Auto admission exists. The schema explicitly permits an all-NULL
final authorization or a complete tuple. The local SQL fixture invokes the
canonical compiled functions extracted from the actual image693, on a fully
migrated isolated Postgres: direct claim and settlement retain NULL, a partial
final tuple violates the SQL constraint, and explicit finalization writes the
complete tuple without changing admission.

The external guard now uses admitted routing only when all three final fields
are exactly NULL. Partial or omitted values fail. Both branches require the
pilot's exact requested/admitted/resolved model, approved deployment/provider
pairs, the observed caller/serving provider, and a matching served SQL attempt.
Authenticated feed digest equality remains mandatory before the existing-event
replay. Unknown provider cost remains NULL. No API/SDK/runtime image changes.

Frozen six-test input: baseline 3 PASS / 3 FAIL; unchanged input plus seven
existing controls: 13 PASS. Four canonical SQL controls pass and the owned
Postgres is stopped. The initial socket-path and missing synthetic SQL-ID setup
failures are retained and do not count as product regressions. Thirteen existing
transport controls pass. Generated post invocation passes Node syntax checking.

The new post definition changes only the embedded reconciler. Original baseline,
caller, unknown first dispatch and failed second post evidence remain intact.
The caller is never rerun. This proof prepares another exact existing-event
reconciliation; production execution and acceptance remain root-only.
