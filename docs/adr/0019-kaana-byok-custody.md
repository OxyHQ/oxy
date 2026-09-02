# ADR 0019 — Kaana holds every provider credential in PostgreSQL/KMS, including BYOK

- Status: accepted architecture; Kaana source merged, Oxy cut and production rollout pending
- Date: 2026-09-02
- Supersedes: [ADR 0013](0013-byok-secret-custody.md) for the custody backend.
  ADR 0013 remains the record of why the existing Oxy build refuses a BYOK write
  instead of accepting material it cannot store safely.
- Issue: #972 (workstream 10)
- Source changes: [Kaana #48](https://github.com/OxyHQ/Kaana/pull/48) and the
  coordinated Oxy custody cut. Kaana #48 is merged; the Oxy cut remains draft.
  Neither fact is production evidence.

## Context

The platform used to distinguish Oxy-owned provider keys from a customer's BYOK
credential when deciding where ciphertext should live. That creates two custody
systems, two rotation paths and two components that can eventually resolve
provider plaintext. The operator cannot then answer “where are all provider
keys?” with one bounded system.

Oxy still has to own customer-facing metadata and policy: account, application,
scope, environment, provider, lifecycle, terms acknowledgement, validation and
audit. None of those responsibilities requires Oxy to own a resolvable secret
locator or the ciphertext.

## Decision

**Every upstream provider credential has one durable home: KMS ciphertext in
Kaana PostgreSQL. This includes both Oxy-funded provider pools and customer BYOK
credentials.** No provider key is a steady-state environment variable, SSM
parameter, Vault/Secrets Manager locator in Oxy, application row, inventory
field, log value or API response.

For BYOK:

- Oxy stores the connection metadata plus an opaque Kaana `credentialHandle`
  and positive `credentialRevision`. The handle is an identifier, not a locator
  Oxy can resolve.
- Kaana binds ciphertext to the exact tuple `provider + ownerAccountId +
  connectionId + environment + credentialHandle + revision` through both the
  PostgreSQL identity and KMS encryption context. Selection is by those opaque
  values only, never by display name, provider/model alias, insertion order or a
  partial match.
- A dedicated signed mutation endpoint performs create, rotate and revoke. Its
  signing domain and public-key set are distinct from inference execution.
- The credential-control task may mutate through narrow PostgreSQL functions and
  use KMS Encrypt, never Decrypt. The inference runtime may resolve one exact
  active row and use KMS Decrypt, never Encrypt. Neither exposes a plaintext
  read/list HTTP route.
- Oxy records a fail-closed custody state: `pending`, `ready`, `reconcile` or
  `revoked`. Only `ready` with an exact handle and revision may enter routing.
  An uncertain cross-service outcome becomes `reconcile`, never “probably
  active”.
- An authorized BYOK route carries the exact credential binding signed by Oxy.
  Kaana cannot infer it from account, provider, connection metadata or global
  inventory.

The canonical mutation and inference origin is exactly `https://kaana.ai`.

## Rollout status and gates

The architecture is decided; availability is not. Kaana #48 is merged in Kaana
source, while the coordinated Oxy cut remains draft. The Kaana merge alone does
not establish the Oxy wire/storage contract, migrated production rows, task IAM,
a live database principal or a working customer request.

BYOK remains fail closed until all of these pass together:

1. the Oxy cut merges compatible strict contracts and Kaana pins the
   published immutable package;
2. the Oxy migration proves the legacy provider-connection inventory is empty,
   or every legacy credential is explicitly imported or revoked rather than
   transformed by guessing;
3. infrastructure creates separate credential-control and inference database
   principals plus inverse KMS permissions;
4. create, rotate, revoke, conflict/replay and `reconcile` paths pass against
   PostgreSQL and KMS without a plaintext read/list surface;
5. an exact BYOK handle and revision travel in one authorized route, execute at
   Kaana, and settle one platform-fee-only Oxy receipt;
6. logs, task definitions, environment, SSM, responses and both databases are
   checked for forbidden plaintext and legacy locators.

Until those gates pass in the target environment, documentation must say
“draft” or “pending”, not “available”, “published” or “deployed”.

## Consequences

- There is one provider-key custody system and one KMS audit boundary.
- Oxy can disable a connection immediately through metadata, but create, rotate
  and revoke require a provable Kaana mutation result; uncertainty is visible as
  reconciliation work.
- A database dump from Oxy contains no provider ciphertext or independently
  resolvable locator. A Kaana database dump contains ciphertext whose KMS context
  prevents copying it to another identity.
- The provider may still bill a BYOK customer directly. Kaana custody does not
  change Oxy's platform-fee-only settlement or provider terms.
