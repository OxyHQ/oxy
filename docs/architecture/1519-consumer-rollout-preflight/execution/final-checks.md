# Final installed-consumer checks

`final-checks.json` is a prepared command list, not execution evidence. It binds
17 worktrees/heads to 99 existing package-script invocations (or Willo's locally
installed Expo export, because it has no export script). Each script and every
explicit test path was checked against the worktree. Execute only after root's
registry-ready signal and the registry runner's installed-byte verification.

Run independent repositories within memory limits, with bounded logs and exit
codes. Per repository, honor shared-package build dependencies first, then
focal runtime tests/types and final UI/backend builds. Postinstall and root build
scripts already encode most shared-package ordering. Alia's API full run remains
required for the composed I05/I10 changes. Required PR/main CI remains required;
these local focals do not replace it.

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
require current-main CI. ECS restoration uses rollback=false and exact new TD
plus captured count; a failure returns to hold0, not an old strict-incompatible
receiver. Worker process readiness does not establish delegated authorization.
