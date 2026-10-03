# Final adoption and operational batches

Prepared only. Root owns live operations, merges, workflow state and image promotion. No service had been paused when this plan was prepared. `lots.json` fixes 17 worktrees/heads, exact manifest patches (all `git apply --check` passed), package scripts, workflow hashes and 21 image/service recipes. `fleet-handoff.json` preserves the 33-service classification snapshot; it is not a fresh desired-count receipt. `internal-consumers.json` identifies Console, accounts, Commons and the Expo example in the Oxy workspace. Native Metros17967/17968 remain frozen.

## Registry → source → image, prepared before maintenance

1. Root deploys the final compatible issuer/migrations under the reviewed maintenance plan. The forthcoming fixture-only refreeze must preserve the seven package shipping trees/contents checked at200134; do not rebuild historical packs merely to change the API test SHA.
2. Root publishes fresh packages in dependency order and verifies registry integrity/contents against final-source comparison packs. No consumer installation assumes that a successful publish ACK is registry availability. Bloom6.2.1 and7.1.2, PeableSDK0.2.2 and shared-types0.3.0 are already published. Oxy registry adoption remains pending.
3. For each selected row, compare `preparedHead` with the owned branch and fresh main ancestry; preserve any new main product commits before applying. Back up owned local manifests/lock. Recheck the recorded manifest SHA256 values, run the row's `git apply --check` then `git apply`, then `bun install --minimum-release-age=0` and frozen install. Patches only change reviewed dependency locations; unrelated dependencies and runtime source are preserved. Candidate paths are never final dependencies.
4. Compare installed package files with the registry tarball and record the exact registry integrity/lock. Execute each package's own type/build/test commands from `packageScripts`, using its existing owned local fixture harness or the canonical CI Postgres service; never point tests at a production DB. Critical accepted MCP/requester/raw-response/socket regressions must remain in the selected check set. Existing baseline test limitations stay visible (Allo frontend283 assertions passed but required termination after open handles); do not turn them into fabricated clean exits.
5. Commit only explicit manifests/lock plus any reviewed source delta and proof. Root captures then pauses affected deploy/package-publish workflows, merges only the reviewed PR head and verifies exact main CI. Existing consumer SDK publishers are inventoried, **not** a request to republish Mercaria/GoWay packages. Restore each workflow to its captured state deliberately, avoiding an accidental parallel deployment.
6. Build all independent final images in parallel, bound to reviewed merged source and CI, using clean release checkouts and the Dockerfile/context/target recorded in `imageRecipes`. Prefer an existing image-only publisher. Otherwise root may use the listed equivalent ARM image-only command. It pushes only the immutable SHA tag, never `latest`, and does not touch ECS or SSM. Authenticate source→build job/receipt→ECR manifest/runtime descriptor/config architecture; a source label alone is not attestation. Homiio api and worker are separate Docker targets; Clarity worker uses the backend image with its captured command and unchanged SearXNG sidecar.

## Paused-service promotion: no old receiver can start

Keep captured scalers suspended. Do not blindly dispatch a combined deploy workflow at desiredCount0: some reject zero, others update configuration or secrets, and a green zero-task branch does not verify a receiver. Each row classifies its workflow rather than treating all scripts as equivalent. TNP's existing `deploy-aws.yml` is already an immutable **API and DNS image publisher** with separate matrix Dockerfiles; it performs no ECS activation. Reuse it for the API image, then promote that API digest explicitly. TNP Relay remains0.

Root's image/config-only promotion for each service is:

- Re-read the current service/TD/scalers against the quiescence receipt: count0, old tasks STOPPED/targets drained and no external configuration drift. The restoration count comes from that fresh receipt, not from this planning snapshot.
- Copy the current task-definition registration payload, preserving all settings, roles, secret references, env, commands, sidecars and tags. Change only the selected container's image to the verified runtime digest. Omit empty tags (the already-reviewed Peable AWS constraint). Register and read back normalized configuration equality apart from that image. Existing reviewed config operations are separate steps, never hidden in image promotion.
- Run the repository's normal required migration phases with its exact final image/target DB and the existing reviewed migration helper. No backfill or metadata edits are inferred from a package bump. Record STOPPED/exit/readback and cleanup. Do not run an old `latest` task-definition migrator assuming it picked the new image.
- In **one** `aws ecs update-service` for `oxy-cluster`, set the new TD, the captured desired count and `deploymentCircuitBreaker={enable:true,rollback:false}` within the captured deployment configuration. Preserve all other deployment configuration fields. Never first raise the count on an old TD. This plan intentionally has no automatic old-image rollback after strict authority cutover.
- Verify every running task's exact new digest, expected count, task/target health and the row's authority/protocol smoke. A failure means hold0, reconcile all owned/new tasks to STOPPED, preserve queues/data and leave scalers suspended. It does not restore an old receiver. Restore only that service's captured scaling state after its own smoke passes.

Root supplies exact live ARNs/counts/new TD IDs at execution, from authenticated receipts. Prepared commands do not invent future values or bypass compare-before-write. Backend/application images may be built concurrently, but these service mutations remain serially coordinated by root.

## Batches and remaining lanes

| Batch | Members and order | Ready boundary / remaining gate |
| --- | --- | --- |
| 0 | Oxy issuer + asset worker under existing maintenance/watch plan; registry publication | Final CI/image/root receipts; no old-bootstrap automatic rollback. Console/accounts can ship from the same workspace source after issuer readiness. Commons/Expo require registry/native acceptance separately; do not equate web export with Android runtime. |
| 1 | Mention backend + MCP, Allo, Noted, Homiio API/worker, CrowdSource, Syra, Willo, Moovo, Nilo, TNP API, website API | Prepared source compatibility; final registry locks/CI/images and precise receiver/protocol smoke. Mention catalog authority/pilot remains independently gated. Nilo public client variable already verified. Syra notification denial predates strict and does not hold the rest of Syra. |
| 2 | Alia after Mention's required receiver; Mercaria and Peable; Clarity frontend/foreground separately from worker | Alia recognized-result/retirement P2 fixed locally in#663, registry CI pending. Mercaria1043+1044 source composed; Peable SDK0.2.2 already installed/verified. Billing cohort remains absent. Clarity service+user-header calls lack offline grant; no implicit consent. |
| 3 | GoWay after exact canonical seed/public-client readback | Source seed/rollback already reviewed, but app absent in last fresh authority inventory. Final image seed dry-run, canonical owner/absence/CAS checks, selected app-only apply, unique public credential metadata and GitHub public variable remain operations. No new user grants. |
| Frontends | Per-repository frontend workflows listed in `lots.json`, after matching backend/protocol is ready | Public client IDs must resolve to their registered app/redirects. Do not deploy a broken client while its backend is held. Publish only the reviewed source; preserve existing demos and product surfaces. |
| Held/dependent fleet | Move delegated jobs, Clarity delegated worker/proxies, legacy relay/publishers, Matrix and integration protocol lanes, routing sidecar | Exact per-lane gates remain in fleet snapshot. No broad scopes/grants. Matrix/GWJ are separate authority graphs; do not apply an Oxy acting-as claim to them. Preserve existing zero-count services. |

Atlas is the 17th prepared consumer: Cloudflare frontend only, existing public client independently verified, candidate type/edge/export checks accepted. It adds no ECS service or receiver count. Move remains deliberately held by the existing consent constraint. Kaana/relay/worker/Matrix operational receipts remain root/coverage ownership.

## I05: exact existing administrative/pilot path

Use final-source `scripts/agency/foreground-pilot-ecs.py`, its checked registrar preflight reader/launcher and `docs/architecture/i05-foreground-pilot/cas-plan.md`. Generate a fresh private plan from final-image readbacks: exact Mention app/backend workload, complete credential rowset, untouched MCP workload/inert credentials, canonical registrar holder and catalog digest. Apply only the reviewed CAS additions. The expiring registrar credential is scoped to catalog registration and retired with readback; uncertain ACK is reconciled by exact identity/digest, never retried as a new effect.

Only after the CAS/catalogue readback, final packages and Mention receiver are ready enable Alia's **Mention-only** internal pilot. Preserve original requester bearer, persisted approved catalog and per-operation ticket/intent. Alia cleanup-only retry is scoped to the same run/operation; acknowledged result survives retirement failure, unknown transport outcome is not success, and no legacy mutating fallback is allowed. Live pilot proof must use the existing actual-domain/revocation canary and compare HTTP/MCP domain/SQL/audit effects; source fixtures do not replace that operation. No new consent or broad offline grant is part of this pilot.

## I07: data/configuration follow-through, no invented offers

Use final migrator142, `docs/adr/0033-subscription-credit-and-product-billing.md`, `docs/billing/sandbox-isolation.md` and `scripts/billing/commercial-inventory-ecs.py`. Repeat the reviewed read-only inventory against the new pinned deployed image to see the now-present ledger/product tables and namespace; compare with the earlier complete zero legacy-row inventory. Zero historical rows require no grants/backfill. `BILLING_PRODUCT_CATALOGUE_FILE` stays empty/explicit until actual versioned products/offers/quota composition/provider account-mode-environment bindings exist. No Oxy One launch, prices, entitlement grants or API-credit inclusion is inferred. Console/SDK readbacks and product access probes use actual existing authority and fixtures, not fabricated customer purchases.

## I08 / Mercaria: technical namespace and cohort, separate from software rollout

Published PeableSDK0.2.2/shared-types0.3.0 and backendTD7 are existing evidence; Mercaria final Oxy dependencies and coordinated adoption still need release. Historical SQL inventory showed zero commercial rows, two stores/two owners, and no matching Peable merchant/development credential; it does not prove Stripe empty or select a commercial offer.

1. Reconcile only the reviewed existing Mercaria application/production credential scopes via `mercariaBillingAuthority.service` CAS (app6a37d0cc5d4b5f15482a9340, credential01a061cd-39a9-7bd6-ba31-70ef7590c953, owner69b2d3df5d12f58c9800d651; four existing scopes plus payments:read/write). The external DB-only ECS transport is now reviewed in [PR1568](https://github.com/OxyHQ/oxy/pull/1568), source0120223c9 + logs eee6afbd6. It uses compiled existing exports and STS only on the root launcher; 12 offline/4 real-SQL controls passed. Final-image plan/live apply and readbacks remain pending.
2. Use `scripts/auth/mercaria-ephemeral-ecs.py` for one <=1h development service credential after that CAS: prepare→local0600 material→issue→exact inspect→revoke/readback. Root attribution is real STS, no fictional user. Lost ACK keeps the same ID/nonce/material. Already-minted JWT TTL drains separately; cleanup does not assert instant receiver invalidation.
3. Use normal published SDK `merchants.register({})` to initialize only the technical development namespace for that existing app. Read back merchant/app/environment. This is not new merchant terms, MoR, price or user consent. No persistent SSM test credential.
4. Before cohort configuration, read actual Stripe account/mode from the exact deployed secret references on both sides. Peable previously had no Stripe/cohort config; referencing the existing authorized platform secret must be a separate reviewed infrastructure/config change, preserving the same account/MoR and leaving one-off/global rails disabled. Local TEST proof does not attest production mode/account.
5. Fill the strict Mercaria cohort only from verified merchant/app/environment/platform account/mode and exact owned store IDs; verify Portal features and import customer/price/subscription references only from explicit source evidence. No metadata adoption. The zero catalogue cannot authorize inventing an offer. Keep cohort absent until these fields are real. Peable mutations and Mercaria's existing signed Stripe webhook/projection remain separate transitional responsibilities.
6. Pause actions with the action flag on failure **while retaining durable cohort routing**. Never remove the cohort and fall through to a legacy mutator for an existing cohort object. Store receipt subject is not an invented Oxy payer. Retire the ephemeral credential and reconcile tasks/material independently.

This separates software readiness from the remaining exact config/namespace operations. It adds no new acceptance criterion beyond the original migration, authority, billing and runtime requirements.

## Registry adoption runner (no deployment)

`scripts/adoption/final-registry-consumers.py` prepares or applies only the
reviewed package patches. `--repository OxyHQ/name` can repeat to select a lot.
Without `--execute`, it validates local HEAD/branch, exact before-manifest and
patch hashes, and `git apply --check`; it makes no registry request or consumer
change. All 17 prepared worktrees passed this preflight.

At the root's registry-ready signal, `--execute` additionally reads authenticated
Git main ancestry through each configured origin, fetches its exact object
without updating FETCH_HEAD, and refuses an unpreserved main change. It checks
all five published Oxy versions via the canonical npm registry, SHA512 and
**every shipping file** against the reviewed comparison packs before editing
any consumer. A missing version, incompatible archive, changed source or new
main stops the lot. Public registry requests carry no auth credential.

Example shape after the registry-ready signal:

```sh
python3 scripts/adoption/final-registry-consumers.py \
  --repository OxyHQ/Atlas --repository OxyHQ/Mention \
  --candidate-manifest /home/nate/Oxy/.agent-evidence/i04-consumer-final-200134-packs/manifest.json \
  --execute --output <new-private-parent>/adoption-lot
```

Each consumer is rechecked immediately before patching. Install regenerates its
lock with `--minimum-release-age=0`, then verifies a frozen install. Actual Node
resolution from each direct importer must match every file of the downloaded
registry packages. The runner records package checks still pending; install is
not acceptance. The package's reviewed install lifecycle scripts run normally;
no release/publish/build/deploy command is guessed or invoked by this runner.

There is no commit/push/merge or production operation here. Failure preserves
partial state and private logs and never silently rolls back or retries. Resume
requires reviewing that state and refreshing the exact prepared manifest input
if it already changed. Root separately captures/pauses active deploy and package
publisher workflows before merges and applies the digest/count protocol above.

Offline controls: 11 PASS, including actual temporary-Git main advancement,
registry missing/integrity/member differences, malicious archive paths, no
receipt overwrite, and actual Node importer resolution/member mismatch. No
registry-dependent execution has occurred. `registry-runner-proof.json` records
source/log hashes and the all-17 preflight receipt. Atlas remains candidate-only
until the same registry procedure is completed.
