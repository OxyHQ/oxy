# Runbook — rotating, disabling, revoking or recovering a BYOK connection

A BYOK connection uses a customer's own upstream provider credential. Kaana is
its sole custodian: Kaana encrypts the value with KMS and stores the ciphertext
in Kaana PostgreSQL. Oxy stores control-plane metadata, a Kaana-minted opaque
handle and an exact revision; it never stores provider credential plaintext or
ciphertext and never returns a fingerprint or digest.

[ADR 0013](../adr/0013-byok-secret-custody.md) is the binding decision and
[the BYOK mechanism doc](../inference/byok.md) describes the cross-service state
machine. The only signed Kaana origin is `https://kaana.ai`.

This runbook documents the intended production mechanism; it is not evidence
that the current Kaana deployment consumes customer credential bindings or
reports validation. Do not execute customer BYOK changes until every launch gate
in [the mechanism doc](../inference/byok.md#launch-gates) is verified against the
deployed Oxy and Kaana revisions.

## Trigger

- **The upstream key leaked or was rotated at the provider.** Rotate the
  connection to the replacement value. If spend is leaking, disable first.
- **The connection must stop serving immediately but may be restored.** Disable;
  this is the only reversible containment action.
- **The customer is leaving BYOK, or the connection has the wrong exact owner,
  scope or environment.** Revoke; there is no move or identity rewrite.
- **A create, rotate or revoke returned
  `kaana_credential_reconcile_required`.** Recover the same durable operation;
  never create a substitute operation.
- **Account/application closure is blocked.** Every scoped connection must have
  `custodyState = revoked`, meaning Kaana acknowledged the exact revocation.

## Before any write

Use the connection ID returned by Oxy. IDs are opaque: do not choose a row by
display name, list order, provider alone or a “first” match. Read the exact row
and record at least its `connectionId`, `provider`, `ownerAccountId`, `scope`,
`environment`, `status`, `custodyState`, `credentialHandle` and
`credentialRevision`.

```bash
OXY_API=https://api.oxy.so
CONNECTION_ID=<exact opaque connection id>
TOKEN=<user access token with the required account/application BYOK permission>

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID" | jq '.data'
```

The provider credential must be 1–4096 visible ASCII bytes (`0x21`–`0x7e`). Do
not paste it on the command line or assign it to a shell variable: both can
persist it in shell history or process inspection. Feed JSON on standard input
from the customer's secret-handling workflow.

## Rotate — replace the value, preserve the connection identity

`POST /inference/provider-connections/:connectionId/rotate` accepts
`{"secret":"…"}`. Oxy fences custody before calling Kaana, and only a signed
outcome matching the exact handle and expected revision returns the connection
to `ready`.

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/rotate"
```

Enter one JSON object on standard input through the approved secret source. A
successful rotation keeps `credentialHandle`, increments
`credentialRevision` by exactly one, resets validation to `unvalidated`, and
moves an active connection to `pending_validation`. A concurrently disabled
connection stays disabled; rotation must never reopen it. A revoked connection
is terminal.

No prefix, suffix, fingerprint or hash is returned after rotation. The Console
continues to render “credential hidden” / “stored securely in Kaana”.

If the response is uncertain, Oxy leaves `custodyState = reconcile` and the
connection non-routable. Do not retry `/rotate`; follow the recovery procedure
below.

## Disable and enable — immediate, local and reversible

These transitions update Oxy PostgreSQL only. They do not retrieve the provider
credential and do not need a Kaana round trip.

```bash
# Stop resolution immediately.
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/disable"

# Undo a deliberate disable.
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/enable"
```

Prefer `disable` for uncertain incidents: it is the only reversible operation.
It does not satisfy an account/application closure gate because Kaana still
holds the credential.

## Revoke — terminal and acknowledged by Kaana

Oxy first writes `status = revoked` and `custodyState = reconcile`, making the
connection non-routable even if the control hop is down. It then asks Kaana to
revoke the exact handle/revision. Success returns `credentialRevoked: true` and
`custodyState = revoked`.

```bash
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/revoke"
```

There is deliberately no connection `DELETE`. Deleting it would remove the
identity needed to explain historical routing and charges. A 503 after local
fencing does not mean “nothing happened”: read the row. If custody remains
`reconcile`, recover the existing revoke operation without a secret.

## Recover an uncertain operation — outcome first

The recovery route loads the one unresolved operation for the exact connection;
the caller never supplies an operation ID. It always performs a signed Kaana
outcome lookup first.

- Matching `applied`: Oxy commits it locally; no mutation replay occurs.
- Explicit outcome `404`: only then may Oxy replay the **same operation ID**.
- Network failure, 5xx, malformed response or binding mismatch: no replay; the
  connection stays quarantined.
- Conflict: the operation becomes `manual`; automated recovery stops.

### Recover create or rotate

Re-enter the credential used by the uncertain operation, not a replacement.
Oxy sends it only with the persisted operation's same ID, identity, actor and
handle/revision. Kaana alone validates its internal digest and exact idempotency
binding. A missing value is refused by Oxy; a different value becomes a Kaana
conflict and never a replacement operation.

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/reconcile"
```

Enter `{"secret":"<the exact original value>"}` on standard input through the
approved secret source. The route uses that value only if Kaana's outcome lookup
returned 404; it never mints a new operation or accepts an operation ID from the
body.

### Recover revoke

A revoke replay contains no credential. Passing one is a `400`.

```bash
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/reconcile"
```

Never “recover” by calling create/rotate/revoke again, changing an opaque ID,
editing custody columns, or choosing a connection by name. Those produce a new
fact or an unprovable database state; they do not settle the existing operation.

## Verify every transition

A 200 alone is not evidence. Read the connection and its audit trail:

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID" | jq '.data'

curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$OXY_API/inference/provider-connections/$CONNECTION_ID/audit" | jq '.data'
```

What must be true:

- **Create:** `credentialRevision = 1`, custody is `ready`, lifecycle starts at
  `pending_validation`, validation is `unvalidated`, and the exact Kaana handle
  is present. It is not an active credential and is never returned by the
  normal-serving resolver. Immediately open Console's **Validate** action,
  choose an exact deployment ID, and start the durable bootstrap below.
- **Rotate:** handle unchanged, revision exactly previous + 1, custody `ready`,
  validation `unvalidated`; an active connection becomes `pending_validation`,
  while a concurrently disabled one remains disabled. There is no
  credential-derived display hint.
- **Disable/enable:** disable sets lifecycle to `disabled`. Enable returns to
  `active` only when the exact generation is already `valid`; otherwise it
  returns to `pending_validation`. Custody and handle/revision do not change.
- **Revoke:** lifecycle and custody are both `revoked`, revision is exactly
  previous + 1, and the transition response carried `credentialRevoked: true`.
- **Recovery:** the response names `reconciledAction`; the same exact connection
  reaches the state expected for that action. No credential-derived value
  appears in the connection or audit response.

The audit trail is append-only for updates in PostgreSQL. A missing event means
the transition was not committed; do not infer it from a provider-side change.

## Account and application closure

Do not work around a `409` closure refusal. Account closure is fenced durably
before destructive cleanup and cannot race a new BYOK create. An active user may
retry cleanup after an external failure, but the closing account cannot create
another connection. Application deletion takes the same exact-row lock as an
application-scoped connection create.

For every connection named by the refusal:

1. Disable it if containment is urgent.
2. Revoke it by exact opaque connection ID.
3. If custody is uncertain, recover that same revoke operation.
4. Confirm `custodyState = revoked`.
5. Retry account/application closure.

Lifecycle `status = revoked` with `custodyState = reconcile` is intentionally
still a blocker: Oxy has stopped routing, but Kaana custody is not yet proven
revoked.

## Rollback and break-glass

- **Disable → enable** is the only direct rollback.
- **Rotate has no automatic rollback.** The previous plaintext is not readable
  from Oxy or Kaana's control API. If the upstream provider still accepts it,
  the customer may supply it as a later, new rotation after the current one is
  fully reconciled.
- **Revoke has no rollback.** Create a new connection with a new opaque ID after
  the old revocation is acknowledged.
- **Kaana control unavailable:** disable for immediate containment. Revoke still
  fences locally, then requires same-operation recovery when control returns.
  Create and rotate must not fall back to an environment variable, Oxy database,
  MongoDB or a second secret store.
- **Recovery reports conflict/manual:** leave the row quarantined and escalate
  with the exact connection and operation ledger IDs. Do not include the
  provider credential or any derived value in a ticket, log or message.
- **Customer unreachable while spend leaks:** disable. This stops resolution
  without guessing ownership or destroying customer material.

Neither Oxy nor support can read a provider credential back. Oxy's normal
resolver returns only `ready + active + valid`; a pending or unvalidated row
shadows broader scopes fail-closed. The authenticated edge source binds that
exact resolved generation into the selected authorized route, but it must never
bind a pending generation as a validation shortcut. Use
`GET /:connectionId/validation-deployments?applicationId=…` and explicitly
select one returned catalogue deployment ID; never derive it from provider/model
name or choose the first row. `POST /:connectionId/validation-bootstrap` creates
or resumes the durable operation, while `GET` on the same path shows its latest
state. A pending result may be retried with the same selectors and operation;
an inconclusive billing/quota result may be revalidated as a new operation over
the same credential generation after the provider account is fixed. Do not
rotate a cryptographically correct key merely to recover credit or quota.

Kaana uses the exact pending generation and its protected mapped deployment for
a fixed one-token probe, discards output, bypasses normal response/receipt/Oxy
billing, and enqueues a closed outcome with no free-form upstream error text.
Only authentication rejection is invalid; billing is inconclusive `forbidden`
and quota is inconclusive `rate_limited`. The Oxy validation receiver
accepts only a live trusted service principal carrying both the exact
`inference:byok:validate` scope and the staff-controlled
`kaana:provider-credential-validation` application capability. User sessions
and ordinary service credentials cannot report verdicts; accepted validation
events must name the current exact `credentialHandle + credentialRevision`,
reject a stale generation, are rate-limited by `appId:credentialId` rather than
IP, and are audited as actor `platform`. Do not open production until the
dedicated bootstrap migrations and compatible releases are deployed, an exact platform-fee version has been authored,
published and associated, migration `0069` is deployed, the compatible Kaana
runtime/callback and required SSM parameters exist, and both deployed
image/commit identities plus live probes have been verified.
