# ADR 0013 — Kaana is the sole custodian of customer provider credentials

- Status: accepted
- Date: 2026-08-16
- Superseded custody mechanism: 2026-09-02 — the former Oxy secret-locator
  design is replaced by Kaana PostgreSQL + KMS custody
- Issue: #972 (workstream 10)

## Context

BYOK means a customer supplies a credential for their own upstream provider
account. The provider bills that customer directly; Oxy charges only its
platform fee (`usage_receipts.platform_fee_only`, ADR 0009).

The credential must be available to the component that executes inference, but
it must not become ordinary application configuration or control-plane data.
Provider keys in environment variables, task definitions, product databases or
application bundles cannot be isolated per customer, rotated transactionally or
bound to an exact account/application route. Storing encrypted credential blobs
in the Oxy database would still give the Oxy API both the ciphertext and the
decryption path.

The former design stored a `secret_ref` locator in Oxy and expected a separate
managed secret backend. No backend shipped. That refusal was safer than an Oxy
PostgreSQL fallback, but it also made BYOK unusable and split custody from the
inference data plane. Kaana now owns both the encrypted credential store and the
only runtime that may decrypt it.

## Decision

**Kaana is the only custodian of upstream provider credentials.** It encrypts
each value with the customer-BYOK KMS key and stores the ciphertext, exact
identity binding and durable operation outcome in **Kaana PostgreSQL**. Only
Kaana inference receives KMS Decrypt permission. The Kaana control task may
encrypt but cannot decrypt.

The canonical signed control origin is exclusively `https://kaana.ai`.
No Kaana hostname under `oxy.so` is valid.

Oxy stores only control-plane metadata:

- exact `provider + ownerAccountId + connectionId + environment`;
- exact account/project/application scope and lifecycle;
- Kaana's opaque `kcred_…` handle and positive revision;
- custody state and non-secret validation/terms metadata;
- a durable mutation ledger containing exact IDs and non-secret state only.

Oxy stores no provider credential plaintext or ciphertext and exposes no
fingerprint/hash. Credential digest validation and idempotency stay inside
Kaana; Oxy neither persists nor exposes that digest.

There is no provider-key fallback to an environment variable, MongoDB, Oxy
PostgreSQL, Vault, SSM or Secrets Manager. Kaana itself is PostgreSQL-only;
MongoDB/Mongoose are neither a fallback nor a migration destination.

## Exact signed identity and opaque IDs

Oxy mints and persists one opaque operation ID before any control request. The
signed request binds that ID to the action, actor and exact
`provider + ownerAccountId + connectionId + environment`; rotate/revoke also
bind the opaque handle and expected revision. No participant derives an ID from
a name, display label, provider ordering or a first match.

Kaana includes the complete binding in its PostgreSQL uniqueness/idempotency
checks and KMS encryption context. Kaana validates the credential against its
internal digest. Reusing an operation ID with a different action, identity,
actor, credential, handle or revision is a conflict.

Credential input is exactly 1–4096 visible ASCII bytes (`0x21`–`0x7e`). The
public contract and signed Kaana contract both reject empty, whitespace/control,
non-ASCII and oversized values. Oxy persists and returns no prefix, suffix,
fingerprint, hash or other credential-derived recognition value. Clients render
the credential as hidden and name Kaana custody without a hint.

## Cross-service state machine

Oxy writes the connection/operation fence before calling Kaana. Only an exact
signed `applied` outcome makes custody routable:

- create: `pending` → `ready`, with revision 1;
- rotate: `ready` → `reconcile` → `ready`, with the same handle and exactly the
  next revision;
- revoke: lifecycle becomes `revoked` and custody becomes `reconcile` before
  the network call, then custody becomes `revoked` only after Kaana acknowledges
  the exact next revision.

Anything except `ready` custody is excluded from routing. Even with ready
custody, the normal edge admits only `active + valid`. Pending validation,
unvalidated, invalid, expired, disabled and every other lifecycle/validation
combination remain excluded. A more-specific non-routable row shadows broader
connections fail-closed; it is never bypassed by selecting a parent. A fully
revoked row stops shadowing inheritance.

Create and rotate intentionally leave the current generation
`pending_validation + unvalidated`. The signed normal-serving route has no
bootstrap purpose, so that generation must never be placed in its
`authorizedRoutes`. A separate authenticated initial-validation bootstrap has
not been implemented; it is a launch gate, not an exception in the normal
resolver.

## Lost-response recovery

Recovery always looks up the signed outcome for the persisted operation first.
A matching applied result is committed locally; a conflict becomes manual.
Only an explicit Kaana `404` permits a replay, and that replay uses the **same
operation ID and exact binding**.

Create/rotate replay requires the customer to re-enter the original value. Oxy
resends it only with the persisted operation's same ID, identity, actor and
handle/revision; Kaana alone validates its internal digest/idempotency binding.
Revoke replay accepts no credential. Network/5xx, malformed response or any
identity, handle or revision mismatch never triggers a mutation replay.

A recovery route cannot accept an operation ID from the caller, mint a
replacement, resubmit with a new ID, or guess from current rows. Manual database
editing is not recovery.

## Closure fencing

Account closure and provider-connection creation take the same exact account-row
lock. Self-delete writes a durable `account_closure_fences` row before external
cleanup, so a failed cleanup remains retryable by the person but cannot race a
new BYOK connection. Archival writes the same fence atomically.

Account closure requires every owned connection to have
`custodyState = revoked`. Application deletion takes the exact application-row
lock and likewise refuses an application-scoped connection with non-revoked
custody. Lifecycle `status = revoked` alone is insufficient while Kaana's
outcome is uncertain.

## Validation authority

Only a live trusted service principal holding the exact
`inference:byok:validate` scope and the staff-controlled application capability
`kaana:provider-credential-validation` may call
`POST /inference/provider-connections/:connectionId/validation`. User sessions
and ordinary service credentials cannot report a verdict. The request names the
current exact handle/revision and refuses a stale generation; rate limiting is
keyed by the live service principal's `appId:credentialId`, never an IP. The
resulting audit actor is `platform`, because the credential check is Kaana
machinery rather than the customer service credential that authenticated the
report.

Validation belongs inside Kaana, where the credential is decrypted. Oxy accepts
only a closed verdict vocabulary with no free-form provider error string. A
`valid` verdict for the exact ready generation promotes `pending_validation` to
`active` in the same transaction; `invalid` or `expired` disables it. The Oxy
receiver exists, but there is no dedicated authenticated path that can bootstrap
a new pending generation without exposing it to normal serving. That bootstrap,
the compatible Kaana callback, and their production deployment remain launch
gates.

## Consequences

- Provider keys are written and rotated at runtime without becoming Oxy API
  configuration or product data.
- Oxy cannot read a credential back for support, validation or migration. The
  control protocol has no plaintext read operation.
- A control outage cannot make uncertain custody routable. Disable remains a
  local reversible containment action; revoke fences locally before it contacts
  Kaana.
- BYOK does not override provider terms. A provider that requires per-customer
  acknowledgement remains protected by the connection/catalogue foreign-key
  invariant.
- The former `secret_ref` column and its Oxy-side locator backend/configuration
  are deleted. Migration `0054` remains historical evidence of the old locator
  grammar; migrations `0067`/`0068` prove zero inventory and remove the legacy
  column during the clean cut.

Operational details and launch gates live in
[the BYOK mechanism doc](../inference/byok.md); incident procedures live in the
[BYOK runbook](../runbooks/byok-provider-connection-rotation.md).
