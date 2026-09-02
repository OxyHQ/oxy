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

An authorized customer route may carry
`customerProviderCredential = {credentialHandle, credentialRevision,
ownerAccountId, connectionId, environment}`. The provider is already an exact
field on the same route. BYOK-only deployments remain ungrantable until Kaana's
inference contract consumes and validates that full binding.

## Cross-service transitions

- Create commits an Oxy `pending` row, asks Kaana to create, then fences the
  exact row to `ready` with Kaana's returned handle/revision.
- Rotate first changes custody to `reconcile`, making the connection
  non-routable, then asks Kaana to advance the exact handle/revision. Only the
  matching fenced row can return to `ready`.
- Revoke first changes the Oxy lifecycle to `revoked` and custody to
  `reconcile`, then asks Kaana to revoke the exact generation. A positive Kaana
  acknowledgement changes custody to `revoked`.
- A timeout, rejected revision or unknown acknowledgement never guesses success;
  it remains `reconcile`.

An in-flight create conflict is recognizable because Kaana returns the existing
exact reference for the same immutable identity. A lost acknowledgement is not
convergent for any action, including create: Oxy deliberately discards the
plaintext and therefore cannot resubmit create, while replaying rotate or revoke
at the old revision yields the same conflict whether the first mutation landed
or a competing mutation won. Kaana currently exposes no signed metadata query
or durable operation outcome that can disambiguate those states.

This cannot be repaired inside Oxy without persisting plaintext or guessing.
Before launch, Kaana must add a signed, identity-bound status/outcome contract
(or equivalent idempotency ledger), and Oxy must reconcile every pending row
against it with lost-response, replay and concurrent-revision tests. Manual row
editing is not reconciliation.

## Legacy inventory and rolling deploy

The previous Oxy build shipped an empty provider-secret backend registry, so the
expected production inventory is zero. Migration `0065` enforces that statement:
it aborts if any legacy provider-connection row exists. If the count is nonzero,
stop and perform an explicit read-once import with receipts, exact identities,
Kaana acknowledgements and revocation/deletion in the old backend. Never convert
a locator into a handle or infer an ID.

`0065` is an additive pre-deploy migration. It leaves the old `secret_ref`
column nullable solely so the previous image can coexist during a rolling
deployment. Keep custody signing configuration disabled until every old task is
gone. Post-deploy migration `0066_drop_legacy_provider_secret_ref` then rechecks
that no locator was written during the rollout and drops the legacy column, its
constraints and its index. Successful execution of that post phase remains a
launch gate.

## Authorization

- Public writes require the dedicated BYOK account/application permission.
- A service credential may read metadata but cannot create, rotate, revoke,
  enable, disable or report validation on this surface.
- Another account's connection returns `404`, never an existence-revealing
  `403`.
- Kaana mutations accept only the dedicated signed internal lane.

## Launch gates

Do not enable `KAANA_CREDENTIAL_CONTROL_SIGNING_*` or BYOK routing until all are
recorded:

1. Production query proves zero legacy rows, or a reviewed read-once import has
   receipts for every exact connection and confirms removal from the old store.
2. The rolling deploy is complete and post-deploy migration `0066` has dropped
   `secret_ref` and its old constraints/index.
3. Deterministic create/rotate/revoke reconciliation exists and has lost-response,
   replay and concurrent-revision tests.
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
