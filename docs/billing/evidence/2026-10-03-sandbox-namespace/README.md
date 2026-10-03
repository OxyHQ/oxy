# Billing sandbox namespace — 2026-10-03

Source `a4401e907` over `d938cfdaf` implements the explicit physical database boundary described in ../../sandbox-isolation.md. It keeps all successful provider evidence in test mode, requires explicit environment and test/development process, and rejects incompatible database declarations in either direction. It does not partition or reconstruct existing credit balances.

Final validation: 12 real API/SQL suites / 186 tests pass, including nine namespace cases and paid product/credit, rollback, replay, refund, cancellation and empty-bundle maintenance paths. The namespace cases cover unmarked→test and declared-test→live rejection, missing explicit environment, production process rejection, session GUC and connection startup options, rejection before provider/balance mutation/read, same-account balances in separate databases, and wrong evidence namespace. Provider calls are synthetic. No actual Stripe sandbox acceptance is claimed here.

The owned harness initialized and checked a new local PostgreSQL server PID 3489723/data/executable/socket before provisioning. Normal migrator applied 140 migrations; repeat was a no-op. The server was stopped. Migration0140 was generated over139; its only DDL changes are two CHECK constraints. Second generate emitted no change. Phases/journal140, payload223 tables/2630 columns, OpenAPI364/419, API/scripts TypeScript passed. The original empty lint log is invalid evidence: `bunx biome` selected the unrelated `biome` package. The actual Biome 1.9.4 correction below supersedes that claim.

The first rehearsal stopped before suites because the generated SQL had no deploy-phase marker; adding the required pre marker corrected this. An intermediate run passed184/185 but its old contradictory-delivery assertion depended on converting product fixtures to live. The final fixture keeps successful evidence test and explicitly contradicts only the negative delivery. These are setup/fixture corrections, not a frozen equivalent RED→GREEN security exploit proof. Original failed logs are preserved.

The source commit contains the full runtime/test/migration inputs; proof.json binds all22 source files and15 logs. Scope is source readiness and physical isolation. Production rollout, real sandbox verification and complete I06/I07 acceptance remain separate.


## Lint evidence correction

`lint-correction.json` binds all 17 TypeScript inputs at `671908eef`, the actual
`@biomejs/biome@1.9.4` invocation and both logs. The real initial check found one
existing `useTemplate` diagnostic in the test database refusal message. The
followup preserves exactly the same text in a single template literal. The real
final check examines 17 files with zero diagnostics. The empty original log is
retained as invalid historical evidence, not counted as validation. Source tests
and migration results above remain bound to `a4401e907`; no suites were repeated
for a message-only formatting correction.
