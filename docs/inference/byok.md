# BYOK — customer provider credentials in Kaana

A BYOK connection lets a customer use their own upstream provider account. The
provider bills that customer directly; Oxy charges only its platform fee and
records that fact on the receipt.

The custody contract is simple: **all provider credentials live as KMS
ciphertext in Kaana PostgreSQL, including BYOK.** Oxy owns connection metadata,
permissions, policy, validation and billing, but retains only an opaque Kaana
handle and its exact revision. See
[ADR 0019](../adr/0019-kaana-byok-custody.md).

## Status: architecture accepted, rollout pending

[Kaana #48](https://github.com/OxyHQ/Kaana/pull/48) and the coordinated Oxy cut
implement this boundary in draft source. They are not merged, published or
production-verified. The currently merged Oxy path still refuses create and
rotate with `503 provider_secret_store_unavailable`; that historical refusal is
safer than reading a credential into a process with no approved custody path and
is recorded by [ADR 0013](../adr/0013-byok-secret-custody.md).

Do not infer availability from either draft. A live BYOK request remains blocked
until the contracts, migrations, database roles, inverse KMS permissions,
authorized-route binding and end-to-end settlement gate all pass.

## One owner for each part

| Concern | Owner |
|---|---|
| account, application, scope, environment and provider metadata | Oxy |
| terms acknowledgement, lifecycle, validation and customer audit | Oxy |
| opaque `credentialHandle` allocation and exact revision | Kaana |
| provider plaintext and KMS ciphertext | Kaana only |
| route eligibility and platform-fee-only settlement | Oxy |
| exact credential resolution during execution | Kaana only |

Oxy never stores plaintext, ciphertext or a Vault, SSM, Secrets Manager or
other independently resolvable locator. Kaana never turns Oxy account or
connection ids into a customer model of its own.

## Exact identity, never a name lookup

One customer ciphertext is bound to:

```text
provider + ownerAccountId + connectionId + environment
+ credentialHandle + revision
```

`credentialHandle` is an opaque `kcred_…` identifier minted by Kaana. Oxy may
compare and sign it but cannot dereference it. Rotation keeps the handle and
advances the positive revision. Kaana's PostgreSQL lookup and KMS encryption
context both bind the complete tuple, so copying ciphertext to another provider,
owner, connection, environment, handle or revision cannot produce a usable key.

No fallback may resolve a credential by provider display name, account name,
insertion order, a partial id or an old `secretRef` locator.

## Mutation and execution are separate authorities

Oxy sends create, rotate and revoke to the dedicated strict endpoint at the
canonical origin:

```text
POST https://kaana.ai/internal/v1/customer-provider-credentials/mutations
```

The exact body is signed with the dedicated
`oxy-kaana-credential-control:v1` domain. Credential-control keys do not inherit
inference authority, and inference keys do not authorize mutations.

- The credential-control task can execute narrow PostgreSQL mutation functions
  and use KMS Encrypt. It cannot select table rows or decrypt.
- The inference task can resolve one exact active row and use KMS Decrypt. It
  cannot create, rotate or revoke.
- There is no plaintext read, list, export or support endpoint.

The credential travels only inside the signed TLS mutation body, is wrapped in
a runtime-redacted value, encoded for the strict wire shape, encrypted
immediately, and never returned.

## Fail-closed cross-service state

Oxy records one of four custody states:

| State | Meaning | Routable? |
|---|---|---|
| `pending` | Oxy created metadata but Kaana has not acknowledged a handle | no |
| `ready` | exact handle and revision are committed on both sides | only if all other policy and validation checks pass |
| `reconcile` | a cross-service outcome could not be proven | no |
| `revoked` | Kaana confirmed the terminal revision | no |

Only `ready` with both handle and revision may enter candidate resolution. A
timeout after Kaana may have committed does not become success or trigger a
blind second mutation; it becomes `reconcile` for an exact readback workflow.

Rotate and revoke carry `expectedRevision`. The first successful mutation
advances it, so a replay or stale concurrent request conflicts instead of
modifying a later generation.

## Routing binding

`byokPreference` remains an Oxy policy control:

- `disabled` excludes customer credentials;
- `prefer` prefers an eligible BYOK route without making it mandatory;
- `require` refuses if no eligible BYOK route remains.

An eligible BYOK candidate must carry the exact connection identity,
`credentialHandle` and revision in its signed `authorizedRoutes` entry. Kaana
resolves only that binding. Global inventory, provider aliases and Oxy metadata
cannot grant a different credential.

`oxyHostedOnly` and `byokPreference: 'require'` remain contradictory and are
rejected rather than silently choosing one.

## Customer-visible metadata

The DTO remains strict and may expose only non-secret values needed to manage a
connection:

- connection, owner account, application scope, environment and provider ids;
- lifecycle, custody and validation state;
- opaque handle plus revision when custody is committed;
- a short recognition prefix and SHA-256 fingerprint;
- terms acknowledgement and audit timestamps.

A producer attaching `apiKey`, `secret`, `token`, `privateKey`, ciphertext or a
secret locator must fail schema validation. Another account's connection remains
404, never an existence-revealing 403.

## Permissions do not change

BYOK management remains a high-privilege human operation:

- `inference:providers:write` is staff-granted and not self-grantable;
- a credential's scopes cannot exceed its application's scopes;
- service credentials may read allowed metadata but cannot create, rotate or
  destroy a customer provider credential;
- account/application BYOK read and write permissions remain narrower than
  generic account or application editing.

Kaana custody does not grant Alia or a product app provider-key access. Agents
and conversations remain Alia workloads; bounded product AI calls Oxy directly.
Both paths reach provider execution only through Kaana.

## Rollout gates

Before enabling BYOK, prove all of the following in the target environment:

1. strict compatible contracts are merged, published and pinned by Kaana;
2. the Oxy migration refuses a non-empty legacy inventory unless every old
   credential is explicitly imported or revoked;
3. separate database principals and inverse KMS Encrypt/Decrypt roles are live;
4. create, rotate, revoke, stale-revision and replay tests pass with no plaintext
   in logs, environment, SSM, task definitions, responses or either database;
5. `pending` and every uncertain outcome stay unroutable as `reconcile`;
6. one signed BYOK route resolves the exact handle/revision, reaches the intended
   provider, and settles one platform-fee-only receipt;
7. disable and break-glass containment work while the Kaana mutation task is
   unavailable.

The operational procedure is
[the BYOK rotation runbook](../runbooks/byok-provider-connection-rotation.md).
