# ADR 0013 — Oxy holds a REFERENCE to a customer's provider credential, never the credential; with no secret backend wired, BYOK writes are refused rather than degraded

- Status: superseded by [ADR 0019](0019-kaana-byok-custody.md). The historical
  fail-closed refusal remains the safe behaviour until the coordinated Kaana and
  Oxy cuts are merged and deployed.
- Date: 2026-08-16
- Amended: 2026-08-18 — the reference GRAMMAR was open where this ADR read as
  though it were closed. `providerSecretReferenceSchema` admitted
  `<store>:<anything from a wide charset>`, so a credential spliced in after the
  store name satisfied it AND still ended with the partition suffix; measured
  against a real Postgres, such a row was written and read back. Migration `0054`
  closes the grammar to the canonical path and the contract now requires the
  reference to name its own connection. The partition bullet below states both
  halves.
- Issue: #972 (workstream 10)

This ADR records why the existing Oxy build refuses BYOK writes instead of
storing plaintext or inventing a backend. It is not the current custody
architecture: ADR 0019 moves every provider credential, including BYOK, to
Kaana PostgreSQL encrypted by KMS and leaves Oxy with an opaque handle only.

## Context

BYOK means a customer presents their own upstream provider credential — an
OpenAI key, a Bedrock role — and Oxy routes their requests through it. The
upstream provider bills that customer's own account directly; Oxy charges only
its platform fee (`usage_receipts.platform_fee_only`, ADR 0009).

That leaves one question, and everything else in the workstream is downstream of
it: **where does the credential live?**

The epic answers it — "Vault/KMS/managed secret storage, not PostgreSQL or
client-visible state" — and `providerConnectionSchema` in `@oxyhq/contracts` was
written so a secret cannot be REPRESENTED: the object is `.strict()`, so a
producer attaching `apiKey`/`secret`/`token` fails the parse, and `keyPrefix` is
capped at 12 characters so the one field designed to show part of a key cannot be
widened into showing all of it.

What this deployment actually has is narrower than it looks. `oxy-api` runs on
ECS Fargate and receives its OWN secrets from SSM Parameter Store
(`/oxy/oxy-api/*`, `/oxy/_shared/*`), injected by the task definition at LAUNCH.
That is a launch-time read of parameters an operator created. It is not a runtime
write path: the task role is not granted `ssm:PutParameter`, and the package's
AWS dependencies are three S3 clients and nothing else — no Secrets Manager, SSM,
KMS or Vault client exists in the tree. This process could not write a customer
secret anywhere if it were asked to.

So the real choice was between three options, and only the third is defensible:

1. **Add a runtime secret-writing path as part of this workstream.** It needs an
   IAM policy, a client dependency, a Dockerfile change and a rehearsal against a
   real store — none of which can be validated from this repository, and all of
   which are `oxy-infra`'s to own.
2. **Store the credential in Postgres "for now", encrypted.** This is the option
   that always looks reasonable and is the actual failure: a column full of
   customer provider credentials is the highest-value target in the database, the
   key to decrypt it has to live where the process can read it, and "for now"
   outlives the person who wrote it.
3. **Build the metadata side completely and REFUSE to accept a credential.**

## Decision

**Oxy stores a `secret_ref` — a `<store>:<locator>` pointer — and never
credential material, in any table, response, error or log. With no secret
backend configured, every path that would have to hold a credential refuses with
a typed `503 provider_secret_store_unavailable`, BEFORE the credential is read
out of the request body.**

Four things follow, and each is enforced rather than documented:

- **The refusal precedes the read.** The route authorises, then resolves the
  store, then parses the body. In a deployment with no backend — which is every
  deployment today — a customer credential is never read out of a request at all,
  so it is not in a stack trace or an error report either. Authorisation comes
  first so an unauthorised caller gets 403 and never learns what this deployment
  is configured with.
- **The reference is partitioned by account and environment, and the rest of it
  is fixed.** `providerSecretReference` builds
  `<store>:oxy/inference/byok/<environment>/<accountId>/<connectionId>`;
  `inference_provider_connections_secret_ref_partition` requires the stored value
  to END with `/<environment>/<owner_account_id>/<id>`, and
  `inference_provider_connections_secret_ref_format` (migration `0054`) requires
  the whole string to be that grammar and nothing else. A row naming another
  account's or another environment's locator cannot be written — refused by the
  database, not filtered by a query somebody must remember. The partition being
  IN THE PATH is also what makes a per-partition IAM or Vault policy expressible
  at the store, so Oxy does not have to be trusted to filter.

  The two CHECKs are not redundant, and one alone was not enough: the partition
  rule pins only the END of the string, so until the format was closed a
  credential could be spliced in at the FRONT and satisfy both it and the old
  regex. `providerConnectionSchema` now carries the same pair on the wire — the
  closed grammar, plus a refinement requiring the reference to name that
  connection's own environment, account and id.
- **Nothing can read a secret back.** The `ProviderSecretStore` interface has
  `put` and `destroy` and deliberately no `get`. Re-validating a credential
  therefore cannot be done by fetching it into this process; the component that
  holds it at use time — the data plane — performs the check and reports a
  verdict from a closed vocabulary with no free-form message field, which is
  exactly where an upstream SDK's error string would otherwise quote a key back.
- **A credential that transits the process is not a string.**
  `ProviderSecretValue` overrides `toString`, `toJSON` and
  `util.inspect.custom`, so a template literal, a `JSON.stringify` and a pino
  field all print `[redacted]`; `reveal()` is the single greppable accessor.

## What is NOT wired, and what would wire it

`PROVIDER_SECRET_STORE_BACKENDS` in `services/providerSecretStore.ts` is an
EMPTY map. Setting `INFERENCE_PROVIDER_SECRET_STORE` moves the refusal from
`not-configured` to `backend-missing`; it does not enable anything. Wiring one
means, together:

1. a client (`@aws-sdk/client-secrets-manager`, or a Vault client) in
   `packages/api/package.json` and in the Dockerfile's lean workspace install;
2. an ECS task-role policy scoped to the partition prefix above, so the process
   can write only inside a customer's own partition;
3. `INFERENCE_PROVIDER_SECRET_STORE` set in the task definition. It names a
   STORE, not a credential, so it is a plain environment variable and never an
   SSM parameter.

Nothing else changes: the metadata, the routes, the scope gate, the audit trail
and their tests are complete and green without it.

## Consequences, including the ones that cost something

- **BYOK cannot be used in production until a backend is wired.** That is the
  point, and it is a smaller cost than the alternative: a feature that stores
  secrets in the wrong place is worse than one that refuses.
- **The routing preference is NOT re-modelled here.**
  `inference_routing_policy_versions.byok_preference` (`disabled | prefer |
  require`, workstream 6) stays the one place a customer says whether their own
  credentials may or must be used. This workstream adds the object that
  preference resolves AGAINST, and
  `resolveProviderConnectionForApplication` returns a discriminated result so
  `require` with no live connection is a nameable outcome rather than a null a
  caller reads as "fine, use Oxy's".
- **BYOK does not override a provider's terms and is not a licence to share a
  credential.** Where a provider's terms require a per-customer acknowledgement,
  `inference_providers.byok_terms_acknowledgement_required` says so and a
  composite foreign key makes an un-acknowledged connection unwritable. Turning
  that flag on while un-acknowledged connections exist is REFUSED — the loud
  signal is deliberate, because flipping it silently would make every existing
  connection retroactively non-compliant with nothing to show for it.
- **A revoke destroys the credential first, then records the revoke, and a
  destroy failure never blocks it.** Retiring a connection is a safety operation,
  usually performed because a key leaked; refusing to record it because a store
  call timed out would leave the connection resolvable. The audit row states
  whether the secret was actually destroyed, so a failed destruction is visible
  rather than assumed.
- **The audit trail's immutability trigger guards `UPDATE` only, not `DELETE`,
  unlike ADR 0009's ledger trigger.** `used` events accrue for the life of every
  connection, so `db/expiry.ts` sweeps this table at two years and a DELETE guard
  would fail that sweep on every run rather than make the trail safer. The
  mutation that matters for an audit trail is the EDIT: a deleted row is absent
  and visibly so, while an edited one is a lie that reads as a fact. A schema
  test asserts BOTH halves, so widening the trigger later goes red before the
  sweep starts failing in production.
