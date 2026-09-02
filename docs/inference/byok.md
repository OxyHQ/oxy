# BYOK provider credentials

Kaana is the only custodian of upstream provider credentials. It stores KMS
ciphertext in Kaana PostgreSQL and may decrypt it only inside inference. Oxy
stores metadata plus an opaque `credentialHandle` and exact `credentialRevision`.
There is no Vault, SSM, Secrets Manager, environment-variable or Oxy-database
fallback for customer provider keys.

This cut is intentionally fail-closed. It is not deployable merely because the
code is merged; the launch gates at the end of this document must all pass.

## Control flow

Create, rotate and revoke use a separate signed authority at the canonical
origin `https://kaana.ai`:

```text
POST /internal/v1/customer-provider-credentials/mutations
X-Oxy-Kaana-Key-Id
X-Oxy-Kaana-Timestamp
X-Oxy-Kaana-Signature
```

The signature domain is `oxy-kaana-credential-control:v1`, distinct from the
inference-envelope domain and public-key set. The signed body contains the exact
`provider + ownerAccountId + connectionId + environment`; Kaana adds the opaque
handle and revision to that KMS encryption context. IDs are never recovered from
names or ordering.

`operationActor` is not accepted from a public request. The route authenticates
and authorizes the Oxy principal first, converts that principal to the closed
audit actor, and the signed client derives `operationActor` from it. The request
schemas are strict, so a client-supplied actor is a `400` before any Kaana call.

The customer plaintext exists in Oxy only while constructing that signed
mutation. Its wrapper rejects empty, multiline and UTF-8 values above 4096
bytes, and redacts string, JSON and inspection serialization. Neither plaintext
nor base64 appears in responses, rows, audit metadata or logs.

## Oxy metadata

`inference_provider_connections` contains:

- provider, exact owner/scope/environment and lifecycle metadata;
- `credential_handle`, a closed `kcred_` base32 identifier minted by Kaana;
- positive `credential_revision`;
- `custody_state`: `pending | ready | reconcile | revoked`;
- a display prefix capped at 12 characters and a SHA-256 fingerprint. These are
  recognition metadata, not custody and not inputs to Kaana resolution.

Only `custody_state = ready` can be returned by the effective-connection
resolver. `pending`, `reconcile` and `revoked` are excluded in SQL as well as by
the contract.

`inference_provider_credential_operations` is the durable cross-service ledger.
Before any network request, Oxy commits the operation ID, action, exact
`provider + ownerAccountId + connectionId + environment`, actor, requested
handle/revision when applicable, one-way credential fingerprint for
create/rotate, and `pending` state. It has no plaintext, base64, ciphertext or
provider-key column. Its terminal state is `applied`; uncertain operations stay
`reconciliation`, while an exact confirmed conflict becomes `manual`.

An authorized customer route may carry
`customerProviderCredential = {credentialHandle, credentialRevision,
ownerAccountId, connectionId, environment}`. The provider is already an exact
field on the same route. BYOK-only deployments remain ungrantable until Kaana's
inference contract consumes and validates that full binding.

## Cross-service transitions

- Create commits an Oxy `pending` row and its exact operation ledger row, asks
  Kaana to create using that persisted operation ID, then fences the exact row
  to `ready` with Kaana's returned handle/revision.
- Rotate first changes custody to `reconcile`, making the connection
  non-routable, and commits the exact operation before asking Kaana to advance
  the exact handle/revision. Only the matching fenced row can return to `ready`.
- Revoke first changes the Oxy lifecycle to `revoked` and custody to
  `reconcile`, and commits the exact operation before asking Kaana to revoke the
  exact generation. An exact applied outcome changes custody to `revoked`.

If a mutation response is lost, malformed or mismatched, the signed client sends
`POST /internal/v1/customer-provider-credentials/outcomes` with the same
persisted operation ID and exact non-secret identity. It never mints a replacement
ID, resends plaintext, retries a mutation by guess, derives identity from a name,
or trusts a merely plausible handle/revision. Create outcomes must be revision
1; rotate/revoke outcomes must preserve the requested handle and advance the
persisted expected revision by exactly one.

An exact `applied` response atomically updates both the connection and operation
ledger. Outcome `404`, network failure, malformed response, or any identity,
action, handle or revision mismatch remains `reconciliation` and non-routable.
An exact `409 conflict` has no credential reference and moves the operation to
`manual`; automated reconciliation stops. The authenticated
`POST /inference/provider-connections/:connectionId/reconcile` route performs
only that exact signed outcome lookup. Manual row editing is not reconciliation.

## Legacy inventory and rolling deploy

The previous Oxy build shipped an empty provider-secret backend registry, so the
expected production inventory is zero. Migration `0067` enforces that statement:
it aborts if any legacy provider-connection row exists. If the count is nonzero,
stop and perform an explicit read-once import with receipts, exact identities,
Kaana acknowledgements and revocation/deletion in the old backend. Never convert
a locator into a handle or infer an ID.

The production inventory was proven on 2026-09-02 by a one-shot Fargate task
using deployed task definition `oxy-oxy-api:289`. It began a read-only
transaction and emitted only this count receipt: `provider_connections = 0`,
`rows_with_legacy_locator = 0`, with `populated_database_control = 85055` as a
positive control that the production database was actually queried. The task
`43b54aa7736846c3b9043b7842214f70` exited `0`; its CloudWatch stream is
`oxy-api/oxy-api/43b54aa7736846c3b9043b7842214f70`. The query selected no locator
or credential value. Therefore no read-once import is required for this cut,
but the post-deploy column removal remains mandatory.

`0067` is an additive pre-deploy migration. It leaves the old `secret_ref`
column nullable solely so the previous image can coexist during a rolling
deployment. Keep custody signing configuration disabled until every old task is
gone. Post-deploy migration `0068_drop_legacy_provider_secret_ref` then rechecks
that no locator was written during the rollout and drops the legacy column, its
constraints and its index. Successful execution of that post phase remains a
launch gate.

## Authorization

- Public writes require the dedicated BYOK account/application permission.
- A service credential may read metadata but cannot create, rotate, revoke,
  reconcile, enable, disable or report validation on this surface.
- Another account's connection returns `404`, never an existence-revealing
  `403`.
- Kaana mutations accept only the dedicated signed internal lane.

## Launch gates

Do not enable `KAANA_CREDENTIAL_CONTROL_SIGNING_*` or BYOK routing until all are
recorded:

1. Production query proves zero legacy rows, or a reviewed read-once import has
   receipts for every exact connection and confirms removal from the old store.
   The count-only 2026-09-02 receipt above satisfies this inventory gate.
2. The rolling deploy is complete and post-deploy migration `0068` has dropped
   `secret_ref` and its old constraints/index.
3. Kaana draft #50's exact mutation/outcome ledger is merged and deployed, and
   Oxy's same-ID create/rotate/revoke reconciliation gates pass lost-response,
   `404`, mismatch, conflict and concurrent-revision cases against that deployed
   contract.
4. The Kaana control database role exists before its migration; grants match
   `kaana_customer_credential_control`, `kaana_runtime` and admin exactly.
5. The control task has KMS Encrypt only; runtime has Decrypt only; both are
   limited to the customer-BYOK key/context.
6. The control endpoint is private behind TLS and security-group/WAF controls;
   the Go listener's internal HTTP port is not internet-facing.
7. Kaana inference consumes the full exact route binding and no BYOK catalogue
   scope remains ungrantable by accident.

Until then, the safe production state is: foundation merged, control signing
unset, BYOK catalogue scopes ungrantable, and every uncertain row non-routable.
