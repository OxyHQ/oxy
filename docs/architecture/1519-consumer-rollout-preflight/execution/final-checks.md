# Final installed-consumer checks

`final-checks.json` is a prepared command list, not execution evidence. It binds
18 worktrees/heads to 107 existing package-script invocations (or Willo's locally
installed Expo export, because it has no export script). Each script and every
explicit test path was checked against the worktree. Execute only after root's
registry-ready signal and the registry runner's installed-byte verification.

Run independent repositories within memory limits, with bounded logs and exit
codes. Per repository, honor shared-package build dependencies first, then
focal runtime tests/types and final UI/backend builds. Postinstall and root build
scripts already encode most shared-package ordering. Alia's API full run remains
required for the composed I05/I10 changes. Required PR/main CI remains required;
these local focals do not replace it.

Start at most two installs, one frontend export, two backend type/build tasks,
or two runtime suites, with at most three heavy jobs in total. Run only one full
API suite at a time and one command per repository. These are maximums, not a
requirement to fill capacity; stop starting work under memory or disk pressure.
Retain each command's exit status and log, including interrupted executions.

Mention's browser CI gate uses the live Mention API. Its 2026-10-03 run
37156268676 was inconclusive with HTTP 503 while the fleet was deliberately held
at count zero. Repeat that gate after the reviewed backend is restored. This
dependency is separate from source/build checks and must not be relabeled as a
candidate failure or bypassed to claim browser acceptance.

A command marked `requiresOwnedPostgres` requires that repository's accepted
harness and a disposable owned database, with retained teardown evidence. It is
not permission to point TEST_DATABASE_URL at another fixture or production.
Clarity specifically requires `clarity_ci`. Receiver probes spawn a separate
process with fixed loopback-only network and environment before SDK imports.
Use `-t` for Vitest and `--test-name-pattern` for Bun as recorded.

Candidate evidence remains usable for unchanged product behavior. Do not repeat
Stripe sandbox effects, cryptographic suites, or the full Oxy SDK suite just to
change consumer locks. Final published core has changed since historical 1b
packs, so installed transport/auth focals and importer types/builds are real
remaining checks. A failed checker is recorded and addressed; no shim, weakened
scope, or fabricated clean exit. Allo's previous frontend 283 assertions without
a clean exit remain explicitly incomplete, and Homiio's pre-registry CI errors
for missing new SDK exports remain historical failures.

Package installation/verification, publishing an image, and restoring a live
service are separate steps. Root alone dispatches/publishes/promotes runtime
artifacts and verifies exact digest/config/count. The frontend manual templates
require current-main CI. ECS restoration uses rollback=false and two separate guarded stages: exact new TD at count0, then only after sole COMPLETED-zero/old-STOPPED verification a count-only restore. Failure returns to hold0, never an old strict-incompatible receiver. Worker process readiness does not establish delegated authorization.

Move adds its owned-PG receiver/pipeline harness, frontend tests and typechecks, backend build, frontend export and workflow gates. Its frontend export is a remaining final-registry check; the candidate amendment only passed tests/types.
