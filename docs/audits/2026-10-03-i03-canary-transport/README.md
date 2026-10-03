# External Alia credential revocation canary

Source: `4670c72c3` plus `c63976419`, based on the accepted API checkpoint
`fa5113ac9`. This operational series changes no API, SDK, schema or frozen image.

The helper uses one existing Alia application, owner and consent grant. It creates
only one new service credential with `acting-as:offline` and `inference:invoke`,
a nonce name, a maximum one-hour expiry and closed operational audit metadata.
It never rotates an existing key or grants consent. The shared canonical customer
DELETE transaction is also the revocation operation used here.

Two independent Node processes run core 4.2.0 `OxyServer` middleware. Each
prewarms its read-only authority cache and admits one loopback effect. Their
verifier is the existing Alia workload identity, with a distinct `wl_` credential
on the same application. T0 is captured before canonical revocation; T1 follows
its commit. The helper confirms the SQL row is revoked, then requires both fresh
middleware refusals, unchanged effect counters and elapsed samples below five
seconds from T0. An independent successful authenticated oracle response must
confirm refusal; network failures and timeouts never count as DENY. There is no
provider or inference business effect, or claim of global p99 latency.

The new credential secret is only in parent memory. Its bearer travels only to
the configured Oxy HTTPS URL and to its children through memory IPC. It never
enters task env, arguments, plans, disk or logs. Children receive only the ECS
workload credential endpoint supplied by the existing task role; no IAM is
created. An exact fsynced plan/intent is durable before task dispatch. The helper
uses a nonce clientToken and never retries RunTask or authority writes after an
unknown acknowledgement.

Validation is local: 15 mocked-AWS protocol fixtures; 12 controls using the real
parent fork and two real SDK processes with a synthetic signed loopback oracle,
including outage refusal; six checks of the generated Node entrypoint and actual
compiled API modules on a newly created local PostgreSQL cluster. Fresh migration
and repeat pass; the test database is dropped and PID absent. That Node test uses
production mode and minimal env; its cwd is the owned API package rather than the
image's `/app/packages/api`. It proves prepare/recover, not a live image or the
remote execution phase. The two-process fixture also passes against the final
candidate core CJS tree, pinned separately in `proof.json`; it does not imply
registry publication. The final recovery metadata followup is covered by the
15 protocol cases; it does not change generated invocation or receiver code.

## Operator sequence (not executed)

Prepare from a clean source checkout, with output outside it. Root supplies the
exact final Oxy API revision and the five compiled hashes extracted from that
verified image, its actual AWS caller ARN (queried by the launcher), the approved
session record digest and the existing grant's principal from fresh SQL.

```sh
python3 -B scripts/agency/alia-revocation-canary-ecs.py \
  --plan /private/prepare-dispatch.json --definition oxy-oxy-api:FINAL \
  --runtime-pins /private/final-runtime-sha256.json \
  --authorization-sha256 SESSION_RECORD_SHA256 --principal-id EXISTING_PRINCIPAL
```

This command reads AWS metadata and writes a private plan; it dispatches nothing.
Only after reviewing its exact bytes/hash, root uses `--execute --plan ...
--output /private/prepare-run`. The prepare task has no taskRole and only the
existing DATABASE_URL reference. It performs locking reads, with no persistent
writes. Persist the returned `result` as the private canary plan with mode 0600,
flush/fsync and exclusive creation before continuing.

Prepare the execute dispatch with `--operation execute --canary-plan ...` and
the exact current `--verifier-definition oxy-alia:REVISION`. Only this phase
gets the already registered `oxy-alia-task` role, verified against service `alia`.
It is not a new role or shared Oxy role binding. The task definition fixes the
image digest, working directory, runtime hashes, source helpers, env and sole DB
secret. Registration is compared both from its response and a fresh describe.
Named env/secrets are sorted, with duplicate names rejected; all values remain
exact. Results require nonce/operation/credential identity, and cleanup reads
STOPPED before deregistering the own definition with INACTIVE readback.

## Unknown acknowledgement or process death

Do not redispatch. Reconcile the stored plan, definition, startedBy and clientToken.
Missing list output does not prove no task. Recovery requires the original
fsynced plan and dispatch intent (`--prior-plan`, `--prior-intent`) and a unique
matching task conclusively STOPPED, with exact TD and image. Only then prepare
`--operation recover --canary-plan ...` and review/dispatch its new exact plan.
This phase has no taskRole and makes no API call. It may run with the same service
TD/network at count zero; failed/multiple deployments are allowed only if every
desired/running/pending count is zero. An active service still requires one
completed deployment. Changed TD/image/config/network fails closed.

Recovery derives the verifier inside the canonical API service from the exact
owned row and immutable creation audit. The operator retains no secret or verifier.
A missing row is confirmed only after the original task is STOPPED. Existing
rows must match the exact nonce, ID, app, owner, creation metadata, times, scopes
and operator digest. Revocation and audit commit together; repeat recovery does
not create another audit. Expiry alone is not cleanup. A successful credential
retirement is separate from an authority-drift result; preserve both in the
private receipt. Task STOPPED and definition INACTIVE alone never prove retirement.

Live plans and execution remain pending review on the deployed final image.
These fixtures are not the required live two-receiver sample.
