# Consumer migration and smoke gates

This is a source-derived operation map, not a completed migration or live smoke
receipt. Inputs are the accepted 17-repository `execution/lots.json`; its 21
image recipes yield 20 affected ECS services here. The sibling `source-inputs.json`
records the exact inspected repository commits and file bytes. Root must bind
merged source, selected container, image digest and live network/DB identity in
each final operation. Do not execute repository deploy workflows: they can
change secrets, sidecars, seed or auto-rollback outside this helper's bounds.

## Migration map

Every command below is an **override in the verified new image**, with that
DB's existing canonical migration credential/network. It is not a command to
run against a local developer URL. Root records actual target DB, schema journal,
pending file IDs/hashes and exit/readback before issuing the migration receipt.
A shared API/worker DB is migrated once, serially, and the same DB receipt may be
referenced from both service-specific image-bound records.

| Service | Mode and exact migration command |
| --- | --- |
| alia | required: `node packages/api/dist/db/migrate.js --target-database=alia --phase=pre`, then `--phase=post` under the maintenance decision below |
| alia-integrations | required: `node packages/integrations/dist/db/migrate.js --target-database=alia_integrations --phase=pre`; `--phase=post` only if the pinned journal contains post files |
| mention | required: `bun packages/backend/dist/src/db/migrate.js --target-database=mention`; the deploy script also runs the explicit Postgres population floor and blocked-domain reconciliation one-offs |
| mention-mcp | not-required: separate MCP transport image, no owned DB migrator; Mention DB receipt belongs to the backend. Catalog registration remains a separate authority operation |
| mercaria | required: `node packages/backend/dist/db/migrate.js --target-database=mercaria --phase=pre`, then `--phase=post` under maintenance decision |
| clarity-api / clarity-worker | required/shared: `node packages/backend/dist/db/migrate.js --target-database=clarity --phase=pre`, then `--phase=post` under maintenance decision |
| allo | required: `bun run --cwd packages/backend db:migrate --target-database=allo --phase=pre`, then `--phase=post` under maintenance decision |
| noted | required: `node packages/backend/dist/migrate.js --target-database=noted --phase=pre`; canonical workflow has no post phase |
| homiio / homiio-worker | required/shared: `node packages/backend/dist/db/migrate.js --target-database=homiio --phase=pre`, then `--phase=post` under maintenance decision; do not migrate again from worker |
| website-api | bootstrap-managed: `server/index.ts` calls `migrateUnderLock`, the two named startup data fixes, and only then marks bootstrap complete |
| peable | required: `bun packages/backend/src/db/migrate.ts --target-database=peable --phase=pre`, then `--phase=post` under maintenance decision; no nonexistent compiled Node migrator |
| tnp-api | bootstrap-managed: `apps/api/src/index.ts` awaits `runMigrations`, connects Postgres and awaits `runSeed` before listen; `bun apps/api/src/db/migrate.ts` is the canonical standalone migrator if root elects a separately reviewed one-off |
| willo | required: `sh -c 'cd packages/backend && bun src/db/migrate.ts'`; this migrator has no pre/post interface |
| goway | required: `bun packages/backend/dist/src/db/migrate.js --target-database=goway`; no phase guessed |
| moovo | required: `node packages/backend/dist/db/migrate.js --target-database=moovo --phase=pre`, then `--phase=post` under maintenance decision |
| nilo | required: `node apps/api/dist/db/migrate.js --target-database=nilo --phase=pre`, then `--phase=post` under maintenance decision |
| crowdsource | required: `bun packages/backend/dist/scripts/migrate.js --target-database=crowdsource --phase=pre`, then `--phase=post` under maintenance decision, **only** from dedicated `oxy-crowdsource-migrate` with `MIGRATOR_DATABASE_URL`; never the serving role |
| syra | required: `node packages/backend/dist/src/db/migrate.js --target-database=syra --phase=pre`, then `--phase=post` under maintenance decision |

### Maintenance decision for post files

Normal workflows bracket rollout with pre/post. This window has **all prior
API, worker and consumer tasks positively STOPPED**; it is not a genesis run.
Do not select `--phase=all`. Before moving post ahead of startup, compare the
actual pending journal against the current live journal and inspect those
specific SQL files. Source inventory includes the historical post files, which
must not be confused with currently pending migrations. Their SQL transformations
and constraints run in the DB; the annotations alone do not prove that no
runtime backfill or remote action is needed. A dependency on new runtime
activity/backfill keeps canonical pre → reviewed new roles → post ordering and
requires a separate root operation before successful smoke/scaler restoration.
No helper automatically bypasses that prerequisite.

Alia's post command also invokes `node packages/api/dist/scripts/seed.js
--target-database=alia`; that is an explicit **separate** reviewed seed, not an
implicit migration side effect. Mention MCP's `bun
packages/mcp/dist/register-capability-catalog.js` is likewise separate registration,
not SQL. Mercaria taxonomy/catalog provisioning is not inferred from a migration
exit. GoWay's canonical first-party app/seed readback remains mandatory before
its auth lane is admitted. TNP's canonical startup seed is inherent in the
reviewed bootstrap-managed mode, rather than a new product/catalog proposal.

## Smoke map by lot

`ORIGIN` means the exact existing service origin verified by root against its
current TD/config and repository, not a hostname guessed from the ECS alias.
Execute scripts from a clean, SHA-pinned merged checkout, or copy their exact
bytes and dependencies to a private reviewed wrapper. The helper's smoke child
gets no arbitrary inherited env. A wrapper may set public origins internally;
it must not import a developer `.env` or accept a token in argv. Its hash and
public arguments are bound in the plan.

Existing smoke scripts retain their protocol/status/body assertions; do not
replace their exit with an HTTP liveness 200. For direct readiness commands,
`curl --fail --silent --show-error --max-time 15 "$ORIGIN<path>"` is the exact
request primitive, followed by the source's body assertion listed below.
Uncredentialed denial checks and existing workload/session canaries are distinct
from positive customer authorization: no synthetic customer/grant is created.

| Lot | Service | Command / exact gate |
| --- | --- | --- |
| 1 | mention | `bash .github/scripts/smoke-mention.sh`: hermetic `/health/ready`, federation/apex protocol checks; then the separately authorized mounted I05 foreground/catalog pilot with canonical ticket/read/revoke |
| 1 | mention-mcp | `bash .github/scripts/smoke-mcp.sh`: `/health`, protected-resource metadata, exact scopes/issuer endpoints and unauthenticated MCP challenge; catalog registration/readback separately required |
| 1 | allo | GET `/health/ready`; `jq -e ' .status == "ready" and .phase == "ready" and .dependencies.postgres == "ready" and .dependencies.migrations == "ready"'`; existing session/socket receiver checks remain separate from liveness |
| 1 | noted | GET `/health/ready`, then `bash scripts/smoke-mcp.sh` for actual resource/authorization protocol |
| 1 | homiio | GET `/health`; assert Postgres connectivity in the `HealthService` result, plus canonical RequesterAssertion/foreground caller canary; no X-Oxy-User-Id delegation |
| 1 | homiio-worker | own `worker` target/config/digest and actual RUNNING task; bounded read of its exact CloudWatch stream after that task start must show `Listing worker connected to database` and `Listing worker started on BullMQ` with no terminal boot failure. This proves DB/queue consumer startup, **not** an external listing effect or delegated authority. Do not run a fabricated discover job |
| 1 | crowdsource | `bash .github/scripts/smoke-crowdsource.sh`: `/health/ready`, `/health/live` and its canonical public protocol assertions |
| 1 | syra | GET `/health`; `jq -e '.services.database.engine == "postgres" and .services.database.connected == true'`; public stream/library/auth protocol stays source-bound, not a guessed `/health/ready` |
| 1 | willo | GET `/health` body `status=ok`, and uncredentialed GET `/homes` must be denied by canonical Oxy middleware; `/tunnel` is separately authenticated Home Assistant protocol and not an Oxy authority bypass |
| 1 | moovo | GET `/health/ready`; read exact body and run canonical `/auth/me` unauthenticated denial, with Peable configuration gates retained |
| 1 | nilo | GET `/health/ready`; source body readiness including DB; verify uncredentialed GET `/workspaces` denial from its mounted Oxy middleware |
| 1 | tnp-api | GET `/health/ready` **after** its startup migration/seed completed, `jq -e ' .ok == true'`; DNS image publication is unrelated and never promoted here |
| 1 | website-api | GET `/api/health` `ok=true,ready=true`, and `/api/ready` `ready=true,db=connected`; this combination proves completed migration/data-fix bootstrap and fresh DB access. `/api/mcp/status` is a separate sanitized catalog/protocol observation, not authorization |
| 2 | alia | GET `/health/ready` and exact Oxy/Kaana routing report/control already used in Alia deploy readiness; then mounted I05 caller/receiver pilot and I03 canary; no user/provider request invented for a health probe |
| 2 | alia-integrations | GET `/health` `status=ok,service` matches pinned APP_NAME; exact API→integrations wiring/readback. This is integrations process readiness, not consent or successful external adapter action |
| 2 | mercaria | GET `/health/ready`; `bash .github/scripts/smoke-mcp.sh` keeps protected-resource/issuer/challenge/cross-host checks; I08 CAS/Peable registration is its separate reviewed business acceptance |
| 2 | peable | GET `/ready` body `status=ready`; `/health` alone is insufficient. Actual Stripe account/mode/Portal/cohort and published-SDK readbacks are separate I08 operations, not fabricated payments |
| 2 | clarity-api | `CLARITY_API_URL="$ORIGIN" bash .github/scripts/smoke-clarity.sh`; assert `/health/live` and `/health/ready`; frontend requester ticket canary separately. Service + X-Oxy-User-Id with no grant must DENY; legitimate foreground requester authority remains separate |
| 2 | clarity-worker | **Temporarily HELD pending its own process/denial gate**, not pending an invented consent grant. No HTTP worker endpoint or existing worker smoke command exists. API curl is not a worker smoke. Check actual worker command/target/config/digest and fresh task state/container health; if platform activity is enabled, require its exact `clarity-worker` heartbeat. Separately use the existing canonical Clarity workload authority against final Oxy to observe DENY for service + X-Oxy-User-Id without a grant, preserving foreground requester semantics (accepted abc19/fleet-scope-gates). Inspect worker errors/job state for terminal failure or lost work caused by that denial; a real failure is a repairable blocker. Root binds those process/denial receipts before scaler restoration; no external job or grant is fabricated |
| 3 | goway | GET `/ready`; `GOWAY_API_URL="$ORIGIN" bun --no-env-file scripts/check-routing.mjs` retains the Barcelona→Madrid actual-road assertion, not a straight line. Canonical app/seed and auth receiver checks precede admission |

For either worker, select the exact fresh task ARN/digest from the helper's
`observed-tasks.json`; obtain its log group/prefix/container from its verified TD,
then use read-only `aws logs get-log-events --log-group-name <exact> --log-stream-name
<prefix>/<container>/<task-id> --start-time <task-start-ms> --start-from-head`.
Do not accept an old task's startup line or a liveness sample from the API.
Worker/scaler restore receipts retain this limited meaning and never claim a
job effect, global revocation p99, or missing human consent.

No live smoke or migration has been executed by this delivery. An incomplete
root prerequisite prevents the corresponding plan/admission; it is not converted
to `not-required` to advance the lot.
