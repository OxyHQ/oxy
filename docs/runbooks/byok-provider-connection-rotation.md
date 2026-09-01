# Runbook — rotating, disabling or revoking a BYOK provider connection

A BYOK connection is a **customer's own** upstream provider credential — an
OpenAI key, a Bedrock role — that Oxy routes their inference through. Oxy does not
hold it: the table stores a `secret_ref` locator into managed secret storage, a
`key_prefix` capped at 12 characters, and a SHA-256 `fingerprint`.
[ADR 0013](../adr/0013-byok-secret-custody.md) is the decision; this is what to do
when the credential behind one has to change.

## Read this first

**No secret backend is wired in this deployment.**
`PROVIDER_SECRET_STORE_BACKENDS` in
`packages/api/src/services/providerSecretStore.ts` is an empty map, so every
write path — create, rotate — refuses with
`503 provider_secret_store_unavailable`, **before the credential is read out of
the request body**. Nothing here is broken; that refusal is ADR 0013's decision.

The consequence for this runbook: **the rotate procedure below cannot be executed
in production today.** It is written because the procedure is a property of the
API, not of the store, and because the day a store is wired is not the day to
work out what rotation does. What *can* be executed today is
`disable`, `enable` and `revoke`, which are pure database work and need no store
round trip — see below, and note that this is deliberate: "immediate" must not
depend on the availability of the thing being stopped.

## Trigger

- **The customer's upstream key leaked, or they rotated it at the provider.** The
  credential Oxy holds a reference to is stale; requests will fail upstream with
  an authentication error, and the connection's validation state will be recorded
  as `invalid` (which also disables it).
- **The customer is leaving BYOK**, or the connection was created against the
  wrong account or environment. Revoke; there is no move.
- **Account deletion.** `inference_provider_connections.owner_account_id` is
  `RESTRICT`, not `CASCADE`, so deletion cannot silently orphan a secret in the
  store. A live connection therefore BLOCKS a hard delete, and the account is
  archived instead — revoke the connection first, deliberately, so the stored
  secret is destroyed rather than left behind with nothing in Oxy pointing at it.

## Rotate — replace the credential, keep the connection

`POST /inference/provider-connections/:connectionId/rotate` with the new
credential in the body. Requires `app:update` or `account:update` on the owner
plus the `inference:providers:write` scope.

**The `secret_ref` does not change.** It is pinned to the connection's
environment, owner account and id by the
`inference_provider_connections_secret_ref_partition` CHECK, and a rotation
touches none of those — so a data plane already holding the reference keeps
working, and the previous credential is gone the instant the store write lands. A
new reference would leave the old secret in the store with nothing pointing at
it.

Two refusals to expect, both `409`:

- **`unchanged-credential`** — "That is the credential this connection already
  holds; a rotation must supply a new one." Compared by `fingerprint`, so
  re-submitting the same key is caught without Oxy reading either one back. This
  is a real safety property: a rotation that silently accepted the same value
  would report success and change nothing.
- **`revoked`** — a revoked connection cannot be rotated. Revocation is terminal.

`status` is deliberately NOT reset by a rotation — a working connection is not
suspended because its key changed, or customers would avoid rotating.
`validation` IS reset to `unvalidated`, because the previous verdict was about a
credential that no longer exists.

```bash
OXY_API=https://api.oxy.so
CONNECTION_ID=<connection id>
TOKEN=<user access token with account:update / app:update and inference:providers:write>

# Do NOT paste the credential on the command line — it lands in shell history.
# Read it from a file the editor never wrote to disk unencrypted, or from stdin.
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @- \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/rotate" <<'JSON'
{"secret": "<the customer's new upstream credential>"}
JSON
```

## Disable, enable, revoke — the three that work today

```bash
# Immediate and REVERSIBLE. Pure database work, no store round trip.
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -d '{}' -H 'Content-Type: application/json' \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/disable"

# Undo a disable.
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -d '{}' -H 'Content-Type: application/json' \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/enable"

# TERMINAL, and it destroys the stored credential.
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -d '{}' -H 'Content-Type: application/json' \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/revoke"
```

**Prefer `disable` when you are unsure.** It stops the connection being resolved
without destroying anything, and it is the only reversible one.

**A revoke destroys the secret first, then records the revoke, and a destroy
FAILURE DOES NOT BLOCK IT.** Retiring a connection is a safety operation, usually
performed because a key leaked; refusing to record it because a store call timed
out would leave the connection resolvable. So the response carries
`secretDestroyed: true | false` and the audit row records the same field — **read
it.** `secretDestroyed: false` means the connection is revoked in Oxy and the
customer's credential may still be sitting in the secret store; the only correct
next action is to destroy it at the store, or ask the customer to rotate it at
their provider, and neither happens on its own.

There is deliberately **no `DELETE`**: a deleted connection would make a past
charge unexplainable and would take its own audit trail with it.

## How to verify any of these took

Read the connection back, and then read its audit trail — a 200 from a transition
endpoint is not evidence on its own.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID" | jq '.data'

curl -sS -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/audit" | jq '.data'
```

What must be true:

- **After a rotate:** `fingerprint` is DIFFERENT from the value you recorded
  before, `keyPrefix` matches the leading characters of the new credential, and
  `validation` is `unvalidated`. An unchanged `fingerprint` with a 200 response
  is impossible (the `unchanged-credential` refusal covers it) but an unchanged
  fingerprint after a 409 you did not read IS the likely story — check the status
  code, then the field.
- **After a disable:** `status` is `disabled`, and it went back to `active` only
  if you called `enable`.
- **After a revoke:** `status` is `revoked`, and the audit event carries
  `secretDestroyed`. If that is `false`, this procedure is not finished.
- The audit trail is **append-only in the database**, not by convention: an
  `UPDATE` trigger refuses edits (`0042_inference_provider_connection_immutability.sql`).
  A missing event means the write did not happen, not that the trail was tidied.

`secret_ref` must be unchanged by a rotate and must still be exactly
`<store>:oxy/inference/byok/<environment>/<owner_account_id>/<id>` for one of the
four stores. Both the grammar and the partition are database CHECKs, so a value
that fails them cannot have been written — but reading the reference back is how
you confirm you are looking at the connection you think you are.

## Rollback

- **`disable` → `enable`.** The one reversible transition.
- **A rotate cannot be rolled back**, because Oxy never had the previous
  credential: the `ProviderSecretStore` interface has `put` and `destroy` and
  deliberately **no `get`**, so there is nothing to restore from. Recovery is the
  customer supplying the previous credential again as another rotation, if their
  provider still accepts it.
- **A revoke cannot be rolled back.** Create a new connection; the new one gets a
  new id and therefore a new `secret_ref` partition.

## Break-glass

**The secret store is unreachable.** Rotation and creation refuse with `503
provider_secret_store_unavailable`, and `describeUnavailableStore()` reports which
of the four arms you are in — not-configured, backend-missing, and so on — because
the operator's next action differs in each. What still works: `disable`, `enable`
and `revoke`, all pure database work. **So the containment path never depends on
the store being up:** disable stops the connection being resolved immediately, and
you can rotate later when the store returns.

**A revoke left `secretDestroyed: false`.** Oxy has no way to retry the destroy —
there is no re-destroy endpoint, because the connection is already terminal and a
retry loop over a customer's secret store is not something the API should own.
The paths are, in order: destroy the secret directly at the store (its locator is
the connection's `secret_ref`, which is readable through the connection endpoint
and is not itself sensitive); or tell the customer to rotate the credential at
their provider, which makes the surviving copy useless. Record which you did.

**A live connection is blocking an account deletion.** That is the schema working
as designed. Revoke the connection first (which destroys the secret), then retry
the deletion. Do not remove the `RESTRICT`: a cascade here deletes the metadata
and leaves the credential in the store with nothing left in Oxy that knows it
exists.

**The customer is unreachable and their key is leaking spend.** `disable` is
yours to use — it is reversible, it needs no store, and it stops routing through
their credential. Nothing about it destroys anything of theirs.

**What Oxy cannot do, at all:** read a customer's credential back. Not for
re-validation, not for support, not for a migration. `ProviderSecretStore` has no
`get`, and validation is performed by the component that holds the credential at
use time (the data plane), reporting a verdict from a closed vocabulary with no
free-form message field — which is exactly where an upstream SDK's error string
would otherwise quote the key back.
