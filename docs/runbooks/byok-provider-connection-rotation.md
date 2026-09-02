# Runbook — BYOK provider connection rotation and containment

A BYOK provider credential is customer material. Oxy owns its metadata and
policy; Kaana alone owns the plaintext and KMS ciphertext in PostgreSQL. Oxy
stores only the opaque `credentialHandle` and exact revision described by
[ADR 0019](../adr/0019-kaana-byok-custody.md).

## Current status

This is the operational contract for the coordinated rollout, not a command to
run today. [Kaana #48](https://github.com/OxyHQ/Kaana/pull/48) is merged in
Kaana source; the Oxy custody cut is still draft, and the combined path has not
established a live service. The merged Oxy path continues to refuse
create/rotate with `503 provider_secret_store_unavailable`.

Do not call Kaana's internal mutation endpoint manually, edit either database,
invent a `secretRef`, or put the credential in SSM/environment while the cut is
pending. Complete the rollout gates in
[the BYOK guide](../inference/byok.md#rollout-gates) first.

## Triggers

Rotate when the customer requests it, the upstream provider requires it, a key
is near expiry, or either the customer or Oxy suspects disclosure. On suspected
compromise, **disable first** and rotate the key at the upstream provider; a
cross-service control path must never be the only containment lever.

## Before a rotation

1. Identify the exact Oxy `connectionId`, owner account and environment. Never
   select by provider/display name alone.
2. Read the connection and record its current `credentialHandle`, revision,
   fingerprint, prefix, lifecycle, custody and validation states.
3. Require `custodyState: ready` with both handle and revision. `pending`,
   `reconcile` or `revoked` is a stop condition, not a reason to retry blindly.
4. Confirm the caller has the dedicated BYOK write permission on the user lane;
   a service credential cannot perform the mutation.
5. Confirm the Kaana credential-control task, database role and KMS Encrypt path
   are healthy. This does not prove inference Decrypt; that is a separate
   post-rotation canary.

## Rotate through Oxy

Send the new credential to the Oxy provider-connection rotation endpoint for
that exact `connectionId`. Oxy fences the current handle and revision, signs one
strict mutation for `https://kaana.ai`, and Kaana advances the revision only if
the complete identity and `expectedRevision` match one active row.

Never send the credential directly to a Kaana operator, include it in a ticket,
shell history or log, or retry after an uncertain response. A timeout after
Kaana committed is indistinguishable from a timeout before it committed until
an exact readback proves the revision; Oxy must expose that uncertainty as
`custodyState: reconcile`.

## Verify the write took

Read the same Oxy connection back and require all of these:

- `credentialHandle` is unchanged;
- revision increased exactly once;
- `custodyState` returned to `ready`;
- fingerprint and safe prefix match the new credential without exposing it;
- validation reset to `unvalidated` and no stale failure code remains;
- one append-only `rotated` audit event records the previous fingerprint/prefix
  and new revision, never plaintext or ciphertext.

Then exercise one authorized BYOK request and prove:

- the signed route carries this exact handle/revision and full connection
  identity;
- Kaana resolves that identity, not a provider name or global default;
- the intended upstream account receives the request;
- Oxy creates one platform-fee-only receipt and settles it once;
- no key material appears in task definitions, environment, SSM, logs, traces,
  errors, responses or database metadata.

A successful HTTP rotation without this readback and canary is not a verified
rotation.

## Disable and enable

Disable is immediate Oxy metadata work and requires no Kaana round trip. Use it
first for containment: a disabled connection is excluded before reservation and
inference while its Kaana ciphertext remains for a later safe recovery.

Enable only after the custody state is `ready`. It returns to `active` only with
a valid credential verdict; otherwise it returns to `pending_validation`.
Enable is not evidence that the provider accepts the key.

## Revoke

Revoke is terminal. Oxy marks the connection non-routable and asks Kaana to
advance the exact revision to its revoked state. Verify both the Oxy lifecycle
and Kaana mutation outcome. If the remote outcome cannot be proven, keep the
connection `revoked` plus `custodyState: reconcile`; never restore routing or
pretend the ciphertext was destroyed.

There is no rollback for revoke. Create a new connection with a new id and
handle after the provider credential has been rotated upstream.

## Break-glass

**Kaana credential control is unavailable.** Disable the connection in Oxy,
rotate/revoke the credential at the upstream provider, and leave custody in
`reconcile` until the exact Kaana row/revision can be reconciled. Do not bypass
the signed endpoint with SQL or KMS commands.

**Inference resolution is unavailable but control is healthy.** Do not rotate
merely to test Decrypt. Keep the route disabled, diagnose the runtime database
role/KMS Decrypt path, then run the exact authorized-route canary.

**The customer is unreachable and the key is leaking spend.** Disable the Oxy
connection and suspend/rotate the upstream credential through the provider's
account recovery process. Oxy cannot read the credential back for support.

**A stale or replayed mutation conflicts.** Read the exact current revision. Do
not resubmit with a guessed `expectedRevision`; determine whether the intended
change already committed or a different actor advanced it.

## What must never exist

- an Oxy `secretRef` that independently resolves provider material;
- provider plaintext or ciphertext in Oxy PostgreSQL;
- a provider key in app, Oxy, Alia or Kaana environment variables;
- a plaintext read/list/export endpoint in Kaana;
- a direct database/KMS repair presented as a normal rotation;
- selection by provider/model/display name instead of exact opaque ids.
