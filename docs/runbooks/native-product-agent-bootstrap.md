# Bootstrap or retire the native product agents

Use the manual **Bootstrap native product agents** workflow on `main`. It runs
the repository bootstrap from the task definition currently serving
`oxy-cluster/oxy-api` in `us-west-2`; it never deploys an image, never renders a
task definition and never accepts an application, credential, account or agent
selector from the operator.

**No key pair is involved, in any mode.** Homiio and Clarity's backends prove
what they are by attesting their ECS task roles (ADR 0026). The workflow reads,
creates and injects no secret, and the bootstrap never creates a service
credential or reads one's secret hash. The two service credentials it used to
mint are RETIRED: the bootstrap revokes them, and only once the workload that
replaces each is bound live with every scope it carried.

The immutable bindings are:

| Product identity            | Exact value                            |
| --------------------------- | -------------------------------------- |
| Oxy organization            | `69b2d3df5d12f58c9800d651`             |
| Homiio project account      | `6a50444ce8026582b949089d`              |
| Homiio application          | `6a2f851751b784a86fd0e922`             |
| Sindi bot account           | `01a0646a-078f-7974-9645-a5e8be237f47` |
| Homiio backend workload     | `aws-iam` `arn:aws:iam::237343248947:role/oxy-homiio-task` |
| Sindi service credential    | `01a0648e-ad3f-7608-aa8b-c07bfef6cf73` (retired) |
| Sindi Alia agent            | `01a0646a-078f-7514-9800-9f43ceed7df8` |
| Clarity project account     | `01a0646a-078f-7f53-848d-a0f82d9f7fa6` |
| Clarity bot account         | `01a0646a-078f-7120-a993-a03c180c81b0` |
| Clarity public application  | `01a0646a-2382-74a3-a795-788924d55722` |
| Clarity public credential   | `01a0646e-2508-7048-8c08-b1f7b3af634f` |
| Clarity backend application | `01a0648b-8d73-70ad-8e67-1c07ddc5eb6e` |
| Clarity backend workload    | `aws-iam` `arn:aws:iam::237343248947:role/oxy-clarity-task` |
| Clarity backend credential  | `01a0648b-8d74-7240-adba-80707fdfdf9c` (retired) |
| Clarity Alia agent          | `01a0646a-078f-7642-95ef-439952f4f3f9` |

Names are collision diagnostics only. PostgreSQL writes and the Alia hand-off
use those exact primary keys.

The hand-off also carries each Alia agent's `capabilityGrants` — Sindi exactly
`web`, `artifacts`, `memory`; Clarity empty, which denies. Oxy writes no
`agents` row: Alia's own `Bootstrap native product agents` workflow applies
them, and the manifest SHA-256 both repositories pin changes whenever a grant
does.

## Prerequisite: the workload bindings

Each backend's role must be bound to its application, naming every scope its
retired credential carried, before the run that revokes that credential:

| Application | Role | Scopes the binding must reach (at least) |
| --- | --- | --- |
| `6a2f851751b784a86fd0e922` (Homiio) | `arn:aws:iam::237343248947:role/oxy-homiio-task` | `inference:invoke`, `acting-as:offline` |
| `01a0648b-8d73-70ad-8e67-1c07ddc5eb6e` (Clarity Backend) | `arn:aws:iam::237343248947:role/oxy-clarity-task` | `user:read`, `inference:invoke` |

`--scopes` replaces a binding's scope list, so a re-bind names everything the
service already relies on, not only these.

`bind-workload-identity.ts --app-id <id> --list` shows what is bound. The
bootstrap reads the binding through `resolveLiveAgencyWorkload` — the same live
ceiling a Sindi requester-assertion mint re-reads — and refuses with
`live_state_drift` on `homiio_workload_binding` / `clarity_workload_binding`
(field `subject`: no live binding; field `scopes`: a carried scope is missing)
rather than revoke a credential the product could still need. A credential
that is already revoked, or was never created, needs no binding to stay so: a
fresh environment bootstraps before its Clarity backend application exists to
be bound.

## Bootstrap

1. Confirm the live Oxy image contains
   `packages/api/scripts/bootstrap-native-product-agents.ts` and
   `run-native-product-agent-bootstrap.sh` from the same reviewed release.
2. Run `dry-run-bootstrap`. It uses OIDC and a one-shot Fargate task on the live
   task definition and rolls the PostgreSQL transaction back. Any
   `live_state_drift`, owner mismatch or structural mismatch is a hard stop:
   diagnose the exact immutable fields from an operator-safe projection, never
   select or repair an account by name, list position or first match.
3. Review the complete CloudWatch plan and copy the printed lowercase
   `planSha256`. A credential still live appears as `revoke credential <id>
   superseded-by workload aws-iam:<role>`; one already retired as `assert revoked
   credential <id>`; one never created as `assert absent credential <id>`.
4. Run `apply` from the same `main` revision with that exact hash and a
   non-empty change/ticket reason. The authenticated GitHub actor is the audit
   actor; it is not an operator-editable input. Apply is one task on the same
   live task definition; the in-transaction plan hash is the only approval it
   needs.
5. Verify the task's `apply/bootstrap` result and hash, the high-severity
   `security_activities` event, the exact PostgreSQL rows (both retired
   credentials `revoked`), and both products still authenticating — attested
   tokens carry `wl_f28159178c5e993eb03b8cc1` (Homiio) and
   `wl_1553bb11eb957512b3cdc956` (Clarity) — before bootstrapping the matching
   private Alia agent rows in Alia.

The wrapper refuses to start the bootstrap if the task still injects
`HOMIIO_SINDI_SERVICE_SECRET_VALUE` or `CLARITY_BACKEND_SERVICE_SECRET_VALUE`:
nothing renders those any more, so their presence means something stale did.

The workflow serializes itself and the command also holds a PostgreSQL advisory
transaction lock. A changed database plan between dry run and apply fails the
approved hash check.

## Retiring the old SSM SecureStrings

`/oxy/homiio/SINDI_OXY_SERVICE_API_KEY`, `/oxy/homiio/SINDI_OXY_SERVICE_API_SECRET`,
`/oxy/clarity/OXY_SERVICE_API_KEY` and `/oxy/clarity/OXY_SERVICE_API_SECRET`
held the two retired credentials' material. Nothing in this repository reads
them. Once an `apply` has revoked both credentials they authenticate nothing,
and they are deleted by the infrastructure owner, after the oxy-infra
declarations and deploy-role grants naming them are removed.

## Rollback

Run `dry-run-rollback`, review its exact plan hash, then run `rollback` with that
hash and an incident/change reason. Rollback archives the two bot accounts,
revokes the Sindi and Clarity credentials, suspends only the created Clarity
applications and emits the security audit event. It preserves projects, the
existing Homiio application, database history and SSM SecureStrings. It does
not delete Alia data: retire the two exact Alia agent IDs through Alia's own
reviewed bootstrap/rollback after the Oxy result is verified.

Rollback no longer severs a product at a credential, because there is none to
sever: the backends are their workloads. Archiving the bot accounts and
retiring the Alia agent rows is what ends the agents; cutting a backend off Oxy
entirely is removing its workload binding, which is a platform action outside
this workflow. A retired credential is never restored — a product that needs a
credential again is given a new one through the reviewed credential workflow.
Provider API keys are outside this workflow.
