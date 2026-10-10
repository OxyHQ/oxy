# Canonical AI request routing

The layers (app, Alia, Oxy edge, Kaana) and the ways to call are summarised in
the [developer guide](./README.md#the-mental-model). This document is the
authority for choosing between Kaana and Alia per product feature. It is an
architecture contract, not a production-status assertion: deployment state must
be verified with the live Oxy and Kaana rollout gates.

## Responsibilities

| System | Responsibility |
|---|---|
| **Oxy** | authenticates the caller; resolves account, application and delegated user; checks scopes and policy; resolves the target (exact model, power level or the app's default); chooses and orders the routes; reserves spend; signs the request; settles the receipt |
| **Kaana** | executes the signed request; retries the same route on transient failures and fails over only along the signed routes, before the first output; adapts provider protocols; streams and cancels; measures technical usage and provider health |
| **Alia** | runs assistants and agents; owns conversations, memory, tools, approvals and orchestration; offers users power levels, never model names (rolling out); invokes models through Oxy and Kaana, and never retries or fails over on its own |

Neither a product app nor Alia implements its own retry, failover or model
substitution: that is Kaana's, along the list Oxy signed. See
[When a request fails](./README.md#when-a-request-fails).

The canonical signed data-plane origin is
[`https://kaana.ai`](https://kaana.ai). No Oxy subdomain or old inference-service
name is a compatibility origin. The Oxy edge is still the customer authority:
Kaana does not issue customer keys, authorize accounts or own the billing
ledger.

Historical provider adapters and provider aliases that ran under Alia, plus the
former inference service identity, are Kaana. **The Alia product itself remains
Alia** because agent behavior is not provider execution.

## Choose the path by product behavior

```text
bounded one-shot operation -> product -> Oxy inference edge -> Kaana
stateful agent operation   -> product -> Alia -> Oxy inference edge -> Kaana
```

A one-shot operation is owned by the product and has no assistant state: for
example translate, classify, summarize, rewrite or draft a smart reply. An
agent operation needs conversation history, memory, tools, approvals or a bot
identity. The fact that both eventually invoke a model does not make them the
same integration.

| Product surface | Required route |
|---|---|
| Mention assistant/chat | Mention -> Alia -> Oxy -> Kaana |
| Mention translation, classification and moderation helpers | Mention -> Oxy -> Kaana |
| Inbox embedded assistant/chat | Inbox -> Alia -> Oxy -> Kaana |
| Inbox summary, rewrite and smart reply | Inbox -> Oxy -> Kaana |
| OxyOS assistant | OxyOS -> Alia -> Oxy -> Kaana |
| Homiio Sindi | Homiio -> Sindi as an Alia agent/bot -> Oxy -> Kaana |
| Clarity assistant | Clarity as an Alia agent/bot -> Oxy -> Kaana |

Sindi and Clarity need Alia agent identities and bot-account delegation. They
do not get provider credentials or private provider adapters. Provisioning,
ownership and delegated-user attribution must be verified in Oxy and Alia before
either integration is described as deployed.

## Exact deployment identity and selection

`deploymentId` is the opaque identity of one exact Kaana deployment. It is not
a display name and is never reconstructed from a provider slug, model name,
database row id or list position. Oxy copies the exact identity into the signed
`authorizedRoutes` entry; Kaana resolves that ID against one inventory snapshot
and requires its signed provider, revision-pinned model reference and complete
region set to match.

Oxy orders the policy-qualified deployments by explicit profile priority,
BYOK preference, reviewed funding class (free allowance, discounted
pay-as-you-go, promotional credit, standard paid), score, then exact
`deploymentId`. The single statement of that rule, the funding-class
definitions and the price-ceiling qualification is
[routing.md](./routing.md#ranking-after-qualification). Kaana receives the
already ordered signed list, attempts it in that order (retrying the same route
on transient failures before moving on) and never re-ranks it by health or name.

Exact credential spending needs each signed deployment bound to one reviewed
`(provider, keyId)`. That binding is in Kaana source
([Kaana#93](https://github.com/OxyHQ/Kaana/pull/93) and follow-ups: a
deployment runs on its exact binding, or on its provider's only key, never a
pick among several). Its production cutover is recorded in Kaana
`docs/schema-0013-cutover-2026-09-24.md`. Source is not rollout evidence; read
back the running configuration before describing production as
credential-exact.

After Oxy has selected and ordered the complete authorized set, but before it
creates a hold, it sends one signed, non-cacheable
`POST /internal/v1/deployments/query` containing 1–64 unique exact
`deploymentId` values. Kaana answers from one inventory snapshot. The response
must contain exactly the same IDs once each, and every ID must still bind to the
same revision-pinned `modelReference`, provider and complete region set that Oxy
is about to sign. Missing, extra, duplicate, ambiguous or mismatched evidence;
an unreadable response; or a transport failure returns `service_unavailable`
with zero reservation, zero receipt and zero inference POST.

That query is an attestation, never a selector: it cannot replace an ID with a
provider or model name, and response order has no meaning. The later inference
executor validates the exact route again because the inventory can change
between the preflight snapshot and execution; the preflight is not described as
a lease that Kaana does not actually provide.

`regions: []` means that no upstream execution or residency region is attested.
It does not mean global or unrestricted. Such a deployment is excluded whenever
the effective policy has either an allowed-region or denied-region control.

The v2 metering contract carries the same exact identity in both forms of usage
evidence: a terminal normalized usage report requires `deploymentId`, and every
partial streamed `usage` event requires `deploymentId` as well. The ID must
resolve to exactly one entry in the signed `authorizedRoutes`; a terminal report
must also match that entry's revision-pinned model and provider. Missing,
unauthorized, ambiguous or contradictory identity is rejected rather than
attributed to the admitted route. A present but invalid terminal report is not
replaced by earlier partial evidence. Any known Kaana frame that is malformed or
fails its per-shape schema invalidates the whole measurement record, so a v1 or
malformed terminal `usage_report` is never reinterpreted as an absent report.

## Catalogue projection

How a catalogue entry summarises several deployments without choosing a
"primary" one is in [catalogue.md](./catalogue.md#what-a-catalogue-entry-tells-you).

## Provider-key custody

Upstream provider plaintext has one durable destination: Kaana's PostgreSQL
`provider_credentials` table, encrypted by KMS with context binding it to
`provider + keyId`. It never belongs in an app, Alia, Oxy or Kaana environment
variable; a GitHub secret; a task definition; a model inventory; argv; or a
tracked file. `DATABASE_URL` is a database connection credential, not a provider
key.

Legacy SSM values are migration inputs, not supported steady state. The
allow-listed `kaana-credentials import-ssm` command reads a `SecureString`
directly through the AWS SDK, emits no value and writes KMS ciphertext to
PostgreSQL. The historical Cerebras value must use this path; do not describe
that migration as complete until non-secret row metadata, authenticated
discovery and a real signed Kaana request all pass. Only then remove the legacy
parameter, old deployment reference and old service.

The same custody boundary includes customer BYOK credentials. Oxy owns the
connection metadata and policy but stores only the opaque Kaana
`credentialHandle` and exact revision. Kaana stores the ciphertext in
PostgreSQL/KMS, bound to provider, owner account, connection, environment,
handle and revision. The signed authorized route must carry that exact binding;
no component may resolve BYOK by provider name or an Oxy/Vault locator. This is
the accepted architecture in [ADR 0019](../adr/0019-kaana-byok-custody.md).
Kaana and Oxy source support are implemented; live readback and signed canaries
remain the authority for production readiness.

## Provider and model discovery

The unlicensed `itsfree.ai` checkout is a discovery lead only. No code, prose or
catalogue data is copied from it. Each provider origin, protocol, model identity
and account-visible deployment is re-derived from provider-owned documentation
or an authenticated provider API and must pass Kaana's onboarding gates.

## PostgreSQL-only invariant

Oxy, Kaana and Alia production state use PostgreSQL. New work must not add a
second database, a localhost database fallback or a parallel read/write path
beside PostgreSQL.

## A cutover is complete only when measured

A merge does not prove production. Before removing the old inference path,
verify all of the following against live state:

1. the Oxy service has the complete Kaana signing configuration and no old
   inference base URL or provider-key secret;
2. Kaana serving tasks are running and healthy behind `https://kaana.ai`;
3. a real Oxy-signed request streams successfully, cancellation reaches the
   provider, and settlement records the same `requestId` exactly once;
4. a mismatched batch attestation, a disallowed route/region and an invalid
   signature all fail closed, with no hold and no inference POST;
5. provider credentials load from PostgreSQL/KMS and no provider key appears in
   any live task definition;
6. Sindi and Clarity bot/agent provisioning is verified before those product
   paths are enabled;
7. observability, rate limiting and rollback gates pass through the soak window.

Until those checks pass, documentation may describe the target architecture and
the implementation, but must not call the production cutover complete.

For a new isolated candidate, run the
[`Kaana signed deployment readback`](../../.github/workflows/kaana-signed-deployment-readback.yml)
against the exact live Oxy task definition and immutable image digest; it may
project descriptors only and must record zero provider requests and zero Oxy
ledger writes. Then run the
[`Kaana signed production canary`](../../.github/workflows/kaana-signed-canary.yml)
with one exact `deploymentId` and the exact `snapshotId` from that readback. It
makes the two explicitly confirmed one-token provider requests against an
isolated Kaana candidate task attested by exact task ARN, task-definition ARN,
image digest and RFC1918 address without changing ambient production traffic. The
signer runs in a separate Oxy task and reaches the candidate only through its
private task address on port 8080; `https://kaana.ai` remains the sole external
Kaana origin and no signing key enters the Kaana task. The Kaana workflow always
stops the candidate and deregisters its temporary definition when the bounded
canary window ends. Product consumers such as Alia remain on the established
canonical Kaana path; candidate promotion happens only after the isolated
rollout and readback pass. The complete
inputs, negative probes and rollback order are in
[`kaana-request-v2-cutover.md`](../runbooks/kaana-request-v2-cutover.md).
