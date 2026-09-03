# BYOK provider credentials

Kaana is the only custodian of upstream provider credentials. It encrypts each
credential with the customer-BYOK KMS key and stores only the ciphertext and its
exact binding in **Kaana PostgreSQL**. Decryption is available only to Kaana's
inference runtime. Provider credentials never live in an Oxy/product database,
environment variable, task definition, application bundle, MongoDB, Vault, SSM
or Secrets Manager.

Oxy is the control plane. It stores the connection's provider, exact owner and
scope, environment, lifecycle, Kaana-minted opaque `credentialHandle`, exact
`credentialRevision` and cross-service operation ledger. Oxy stores no provider
credential plaintext, ciphertext, fingerprint or hash. Credential idempotency
and digest validation stay inside Kaana and are never exposed through Oxy.

This cut is intentionally fail-closed. Source code is not enough to launch it;
the deployment gates at the end of this document must all pass. The
authenticated edge now calls the effective-connection resolver, applies
`prefer`/`require`/`disabled`, and signs the exact active generation into
`customerProviderCredential`. It also resolves a separate BYOK platform-fee
version for reservation and settlement. None of that proves the migrations,
matching Oxy/Kaana releases, IAM, the chosen fee version or live probes are in
production. Initial validation now has a separate authenticated bootstrap;
normal inference is never used as that bootstrap.

## Credential input and client handling

A provider credential is exactly **1–4096 visible ASCII bytes** (`0x21` through
`0x7e`). Empty values, spaces, control characters, multiline text, non-ASCII
text and values over 4096 bytes are refused by the public schema and by the
signed Kaana contract.

Oxy stores and returns **no value derived from the credential**: no prefix,
suffix, fingerprint or hash. Clients render “credential hidden” / “stored
securely in Kaana” and never synthesize a recognition hint from another field.

The request-only plaintext wrapper redacts string, JSON and inspection
serialization. The Console sends write requests without retry or request
deduplication and never places a secret-bearing payload in React Query's query
or mutation cache. Plaintext exists in Oxy only for the current create, rotate
or explicitly requested recovery call.

## Signed control flow

Create, rotate, revoke and outcome lookup use a separate signed authority at the
only canonical Kaana origin, `https://kaana.ai`:

```text
POST /internal/v1/customer-provider-credentials/mutations
POST /internal/v1/customer-provider-credentials/outcomes
X-Oxy-Kaana-Key-Id
X-Oxy-Kaana-Timestamp
X-Oxy-Kaana-Signature
```

The signature domain is `oxy-kaana-credential-control:v1`, distinct from the
inference-envelope domain and public-key set. The signed identity contains the
exact `provider + ownerAccountId + connectionId + environment`; rotate and
revoke also bind the exact opaque handle and expected revision. IDs are supplied
as opaque values and are never recovered from names, slugs used as display
labels, list order or “first matching” rows.

Kaana binds the encrypted value to that exact identity in its PostgreSQL row and
KMS encryption context. The same operation ID is idempotent only for the same
action, identity, actor, handle/revision and credential. Kaana validates its
internal digest; a different payload under an existing ID is a conflict, not a
new attempt.

`operationActor` is not accepted from a public request. The route authenticates
and authorizes the Oxy principal first, converts it to the closed audit actor,
and the signed client derives `operationActor` from it. Public request schemas
are strict, so client-supplied identity or actor fields are refused.

## Oxy metadata and routability

`inference_provider_connections` contains:

- provider, exact owner/scope/environment and lifecycle metadata;
- the opaque `kcred_…` handle minted by Kaana and its positive exact revision;
- `custody_state`: `pending | ready | reconcile | revoked`;
- validation state and provider-terms acknowledgement.

Custody must be `ready`, but readiness alone is not enough. The normal
effective-connection resolver returns only `active + valid`. `pending`,
`reconcile` and `revoked` custody are non-routable. So are
`pending_validation`, unvalidated, disabled, invalid, expired and every other
lifecycle/validation combination. A more-specific non-routable row shadows
broader account/ancestor connections fail-closed instead of falling back to
one. A fully revoked row no longer shadows inheritance.

A create or rotate therefore cannot become usable through normal inference.
The dedicated authenticated bootstrap below is the only path allowed to probe
the exact pending generation; it does not widen normal `authorizedRoutes`.

## Explicit initial validation and recovery

Console and API clients must select an exact Oxy catalogue `deploymentId` from
`GET /:connectionId/validation-deployments?applicationId=…`; no result is
preselected and no provider name or list order is used as identity. Oxy resolves
that exact row once to its protected Kaana route id, persists both ids with the
exact application/provider/owner/environment/connection/handle/revision, then
calls `POST /:connectionId/validation-bootstrap`. `GET` on that same bootstrap
path returns the latest durable state/outcome for the exact application.

The Oxy operation is committed before dispatch. A dispatch failure answers
`retry_required` while leaving the row pending; repeating the same POST resends
the same operation id. Kaana's own PostgreSQL ledger leases execution, rejects
selector rebinding, replays terminal outcomes without another provider call,
and re-emits the service-authenticated callback at
`POST /:connectionId/validation-bootstrap/outcome`. A lost callback or either
service restarting is therefore recoverable by the same explicit action.

Kaana runs a fixed text probe (`.` with at most one output token) against only
that deployment and credential generation, then discards all output. It does
not enter normal request execution, create a user response, reserve/settle Oxy
billing, produce a usage receipt, fail over, or affect shared breakers. The
upstream provider may still charge its customer account for this minimal call.

Only a successful real provider call yields `valid`; only an explicit provider
authentication rejection yields `invalid/unauthorized`. Billing/credit refusal
is `inconclusive/forbidden`, quota/throttle is
`inconclusive/rate_limited`, and network, timeout, missing-route/resolver and
other failures remain inconclusive. Inconclusive never disables or validates a
key. After adding credit or quota, the customer starts a new operation against
the same exact handle/revision; rotation is neither required nor desirable.

`inference_provider_credential_operations` is the durable cross-service ledger.
Before any network request, Oxy commits the operation ID, action, exact signed
identity, actor, requested handle/revision where applicable and `pending` state.
It contains no plaintext, base64,
ciphertext, fingerprint, hash or environment-secret reference. Its terminal
state is `applied`; an uncertain operation is `reconciliation`, while a
confirmed conflict is `manual`.

An authorized inference route may carry
`customerProviderCredential = {credentialHandle, credentialRevision,
ownerAccountId, connectionId, environment}`. The provider is already an exact
field on that route. Only Kaana resolves that complete binding to plaintext.

## Cross-service transitions

- **Create** commits an Oxy `pending` connection and the exact operation, asks
  Kaana to create with that persisted operation ID, then moves the row to
  `ready` only after a matching `applied` outcome. A new connection starts
  `pending_validation + unvalidated`, never falsely `active`, and remains
  non-routable until a dedicated authenticated bootstrap validates that exact
  generation through the explicit exact-deployment bootstrap above.
- **Rotate** first changes custody to `reconcile`, making the connection
  non-routable, and commits the exact handle/revision transition before calling
  Kaana. A matching applied outcome keeps the opaque handle, increments the
  revision by exactly one and resets validation to `unvalidated`. An active
  connection moves to `pending_validation`; a concurrently disabled connection
  remains disabled rather than being reopened by the rotation.
- **Revoke** first sets lifecycle to `revoked` and custody to `reconcile`, so the
  connection stops routing even when Kaana control is unavailable. A matching
  outcome advances the revision by one and changes custody to `revoked`.

No transition promotes a row based on a plausible response. The outcome must
match the persisted operation ID, action, identity, handle and revision exactly;
a create result is revision 1, and rotate/revoke is exactly
`expectedRevision + 1`.

## Lost-response recovery: outcome first, same operation ID

Use
`POST /inference/provider-connections/:connectionId/reconcile` only for a
connection in custody reconciliation. The route never accepts an operation ID
from the caller: Oxy loads the one unresolved durable operation for that exact
opaque connection ID.

Recovery always follows this order:

1. Oxy asks Kaana for the signed outcome of the persisted operation.
2. A matching `applied` outcome is committed locally without replaying the
   mutation. A matching conflict moves the operation to `manual`.
3. **Only an explicit Kaana `404`** proves no outcome exists and permits an
   at-least-once replay under the **same operation ID**. Network failures, 5xx,
   malformed bodies and identity/revision mismatches never replay anything.
4. Create/rotate recovery requires the customer to re-enter the credential used
   for that operation. Oxy resends it only with the same persisted operation ID,
   identity, actor and handle/revision; Kaana alone validates the credential's
   internal digest/idempotency binding against its PostgreSQL ledger. A missing
   value is refused by Oxy, and a different value is a Kaana conflict rather
   than a new operation.
5. Revoke recovery accepts no credential and replays the same exact revoke only
   after the outcome `404`.

Recovery never mints a replacement operation, substitutes an ID, submits a new
create/rotate, guesses whether Kaana applied a request, or edits a database row
manually. Until the exact operation reaches `applied`, the connection remains
non-routable.

## Account and application closure fences

Account closure and provider-credential creation serialize on the same exact
account row. Before destructive cleanup, self-delete writes a durable
`account_closure_fences` row. This leaves an active person able to retry a
partially failed cleanup but permanently refuses new BYOK connection creation
for the closing account. Archival writes the same fence atomically.

An account cannot close while any owned connection has custody other than
`revoked`; lifecycle `status = revoked` alone is not enough while Kaana's
acknowledgement remains uncertain. An application delete likewise locks the
exact application and refuses while an application-scoped connection still has
non-revoked custody. Connection creation takes those same locks and re-checks
exact ownership and lifecycle, so it cannot race closure and strand a Kaana
credential.

## Authorization

- Public writes require the dedicated BYOK account/application permission.
- The bootstrap POST is a public metadata-only write under that same narrow
  permission. Its application and deployment ids are exact opaque selectors;
  the service rechecks scope applicability and the approved BYOK catalogue row.
  The outcome POST is not public: it requires Kaana's live service principal,
  validation scope, staff-controlled capability and matching environment.
- A service credential may read metadata only within its exact application and
  environment boundary. It cannot create, rotate, revoke, reconcile, enable,
  disable or report validation on this surface merely by being a service
  credential.
- `POST /:connectionId/validation` accepts only a live trusted service
  principal holding the exact `inference:byok:validate` scope **and** the
  staff-controlled application capability
  `kaana:provider-credential-validation`. User sessions and ordinary service
  principals are refused. The request must bind the exact current
  `credentialHandle + credentialRevision`; a stale generation is refused. Its
  rate-limit identity is `appId:credentialId`, never an IP address. The audit
  actor is `platform`, because the verdict is reported by Kaana machinery rather
  than by the customer's credential.
- Another account's connection returns `404`, never an existence-revealing
  `403`.
- Kaana mutations accept only the dedicated signed internal lane.
- `PUT /inference/admin/deployments/:deploymentId/platform-fee-price-version`
  requires the staff `inference:catalogue:publish` capability and only associates
  an existing immutable version whose provider and exact model revision match
  the BYOK deployment. It cannot author, alter or approve a fee amount.

## Legacy inventory and rolling deploy

The previous Oxy build shipped an empty provider-secret backend registry, so the
expected production inventory was zero. Migration `0067` enforces that fact and
aborts if a legacy provider-connection row exists. If the count is nonzero, stop
and perform an explicit read-once import with exact opaque identities, Kaana
receipts and confirmed removal from the old backend. Never convert a locator
into a handle or infer an ID.

The production inventory was proven on 2026-09-02 by a one-shot Fargate task
using deployed task definition `oxy-oxy-api:289`. It emitted only the count
receipt `provider_connections = 0`, `rows_with_legacy_locator = 0`, with
`populated_database_control = 85055` as a positive control. Task
`43b54aa7736846c3b9043b7842214f70` exited `0`; its CloudWatch stream is
`oxy-api/oxy-api/43b54aa7736846c3b9043b7842214f70`.

The custody-fence migration at journal index `0067` is additive so the previous
image can coexist during rollout. After every old task is gone, post-deploy
migration `0068_natural_slapstick.sql` rechecks the inventory and removes the old
locator column, constraints and index. That column is migration history, not an
allowed custody fallback.

## Launch gates

Do not enable `KAANA_CREDENTIAL_CONTROL_SIGNING_*` or BYOK routing until all are
recorded:

1. Production has zero legacy locator rows, or every exact row has a reviewed
   import receipt and confirmed removal from the old store. The count-only
   2026-09-02 receipt above satisfies the zero-inventory case.
2. The rolling deploy is complete, migration `0068_natural_slapstick.sql` has
   removed the legacy locator column and constraints, and migration
   `0069_dazzling_switch.sql` has added the separate BYOK platform-fee pointer.
3. The same-operation-ID recovery gates pass create, rotate and revoke cases for
   lost response, outcome `404`, network/5xx, malformed response, mismatch,
   conflict and concurrent revision against the deployed Kaana contract.
4. Kaana PostgreSQL roles are created before its migrations; grants separate
   credential control, runtime and administration exactly.
5. The Kaana control task has KMS Encrypt only; runtime has Decrypt only; both
   are restricted to the customer-BYOK key and encryption context.
6. The control endpoint is private behind TLS and network controls; its internal
   listener is not internet-facing.
7. The deployed Oxy edge obtains only an exact `ready + active + valid`
   generation from `resolveProviderConnectionForApplication`, attaches it only
   to the selected authorized route, and Kaana inference consumes that complete
   opaque handle/revision and identity binding. Separately, a dedicated
   authenticated initial-validation bootstrap uses the exact pending
   generation and reports a generation-bound closed verdict through the
   restricted callback. A normal authorized route is not an acceptable
   substitute. No BYOK catalogue
   scope may be grantable until both paths and their deployed identities are
   verified.
8. Account/application closure-race and no-derived-secret-metadata gates pass
   against the migrated PostgreSQL schema and generated OpenAPI contract.
9. Oxy has a reviewed, dedicated BYOK platform-fee product, rate and immutable
   price version, and an operator has published and associated its exact ID to
   every intended BYOK deployment through
   `platform_fee_price_version_id`. Source code validates identity, active status
   and effective window before reservation and settles that exact version with
   `platformFeeOnly = true`. The upstream provider's `price_version_id` remains
   `NULL` and must never be reused as Oxy's fee. The pointer and accounting path
   do not create, choose, approve, publish or associate a production fee on
   their own; those commercial/data actions and end-to-end deployed proof remain
   mandatory.

Until then the safe production state is: control signing unset, BYOK catalogue
scopes ungrantable, BYOK routing disabled, and every uncertain row quarantined.
