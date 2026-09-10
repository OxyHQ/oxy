# Canonical AI request routing

This document is the authority for choosing between Kaana and Alia. It is an
architecture contract, not a production-status assertion: deployment state must
be verified with the live Oxy and Kaana rollout gates.

## Responsibilities

| System | Responsibility |
|---|---|
| **Oxy** | authenticates the caller; resolves account, application and delegated user; checks scopes and policy; reserves spend; signs the request; settles the receipt |
| **Kaana** | executes the signed request; selects only among authorized routes; adapts provider protocols; streams and cancels; measures technical usage and provider health |
| **Alia** | runs assistants and agents; owns conversations, memory, tools, approvals and orchestration; invokes models through Oxy and Kaana |

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

Oxy orders policy-qualified deployments with one explicit rule:

1. for a routing profile, lower explicit candidate `priority` comes first;
2. within the same priority, the reviewed score for `optimiseFor` is descending;
3. if scores are equal, lexicographic comparison of the exact `deploymentId` by
   ECMAScript UTF-16 code units is the sole deterministic tie-break.

Provider name, model name, display name, locale collation, insertion order and
database return order never participate. Kaana receives the already ordered
signed list, attempts it in that order and never re-ranks it by health or name.

`maxPricePerRequest` qualifies routes within each explicit priority before the
score/ID winner is admitted. The catalogue may prefilter the unavoidable flat
fee because Kaana emits `requests: 1` once per attempted request, but the edge
authoritatively quotes the complete maximum for this request from each pinned
price version. A different currency or a total above the cap excludes that
candidate. If the caller omitted `maxOutputTokens`, the first priority that has
a price survivor chooses it by score descending then exact ID; that survivor's
model maximum fixes the implicit output ceiling before lower priorities are
resolved for capacity. A priority with no price survivor fixes nothing. If no
candidate survives, the edge returns `policy_violation` (403) before reservation
and before Kaana.

Selection fails closed before a reservation is created or an inference request is sent when
any otherwise eligible deployment lacks an exact ID, price version or required
score; when score evidence is stale or names a different price version; or when
an exact deployment ID is duplicated or collides with more than one approved
mapping. One incomplete survivor invalidates the complete authorized set; it is
not silently dropped to make another route selectable. A price version attached
to a servable deployment is complete only when it explicitly prices the
`requests` unit Kaana reports once per attempt; zero is allowed, absence is not.

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

## Conservative catalogue projection

A model catalogue entry summarizes every deployment visible to that viewer; it
does not select a representative route. Data-policy fields are aggregated in
the conservative direction: any retention or training applies, the longest
retention applies, zero-data-retention availability requires every visible
route, and subprocessors are the union. A policy URL is published only when all
routes agree.

Regions and serving providers are unions. Singular pricing, availability scope
and commercial permission are published only when every visible deployment
agrees; otherwise that singular field is absent. No provider name, display name,
locale comparison, insertion order or database order may invent a catalogue
"primary" route. Runtime selection remains exclusively the explicit
priority-score-ID rule above.

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
Kaana and Oxy source support are implemented; Oxy execution remains disabled and
the combined path is unverified in production.

## Provider and model discovery

The unlicensed `itsfree.ai` checkout is a discovery lead only. No code, prose or
catalogue data is copied from it. Each provider origin, protocol, model identity
and account-visible deployment is re-derived from provider-owned documentation
or an authenticated provider API and must pass Kaana's onboarding gates.

## PostgreSQL-only invariant

Oxy, Kaana and Alia production state use PostgreSQL. New work must not add
MongoDB, Mongoose, `MONGO_*` or `MONGODB_*` configuration, a localhost Mongo
fallback or a parallel Mongo read/write path. A remaining Mongo reference in an
older app is migration debt to remove, not an approved architecture and not a
reason to copy Mongo into another component.

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

For the first Oxy enablement, keep ambient
`INFERENCE_KAANA_EXECUTION=disabled`. Run the
[`Kaana signed deployment readback`](../../.github/workflows/kaana-signed-deployment-readback.yml)
against the exact live Oxy task definition and immutable image digest; it may
project descriptors only and must record zero provider requests and zero Oxy
ledger writes. Then run the
[`Kaana signed production canary`](../../.github/workflows/kaana-signed-canary.yml)
with one exact `deploymentId` and the exact `snapshotId` from that readback. It
makes the two explicitly confirmed one-token provider requests while ambient
execution remains disabled. Only a separate reviewed deploy change may enable
the ambient flag after both runs pass; product consumers such as Alia are
enabled after that Oxy rollout and readback, never before it. The complete
inputs, negative probes and rollback order are in
[`kaana-request-v2-cutover.md`](../runbooks/kaana-request-v2-cutover.md).
