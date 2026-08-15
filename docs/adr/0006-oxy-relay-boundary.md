# ADR 0006 — Relay executes inference and stores only immutable references to Oxy ids

- Status: accepted
- Date: 2026-08-15
- Issue: #972

## Context

ADR 0005 says Oxy owns every customer-facing fact. That settles what Relay may
not have; it does not say what Relay *is*, and a boundary stated only as a
prohibition gets crossed the first time someone needs a field nobody assigned.

The data plane has real, separable work: normalizing a request, translating it
per provider, streaming and cancelling, failing over between deployments of the
same model, scoring provider health, and measuring what the upstream provider
actually charged. None of that needs to know who the customer is beyond an
opaque identifier, and all of it is latency-critical in a way a control plane is
not.

**The Relay repository does not exist.** Verified 2026-08-15: `gh repo view
OxyHQ/Relay` returns `Could not resolve to a Repository with the name
'OxyHQ/Relay'`. Workstream 13 of the epic is therefore an *external dependency*
of this epic, not a task inside it: the contracts in this ADR and ADRs 0007–0010
are written to be implementable against a data plane that does not yet exist,
and the Oxy side must be buildable and testable before it does.

`Relay` is a working name only — see ADR 0011.

## Decision

**Relay owns execution. Oxy owns everything a customer can see, edit, or be
charged for. Relay stores Oxy identifiers as immutable opaque strings and never
as records it may create, edit or delete.**

### Responsibility matrix

Every domain has exactly one source of truth. "Consumes" means the system reads
the value; only the owner may write it.

| Domain | Source of truth | Data plane's relationship |
|---|---|---|
| Accounts, organizations, projects, members, roles | **Oxy** | consumes `accountId` as an opaque string |
| Applications and application ids | **Oxy** | consumes `applicationId` as an opaque string |
| Application credentials and credential ids | **Oxy** | consumes `credentialId`; never sees the secret |
| Customer scopes and permissions | **Oxy** | none — authorization happens at the edge, before forwarding |
| Customer balance, ledger, subscriptions, payments, invoices | **Oxy** | none |
| Customer-visible usage and spend | **Oxy** | supplies technical usage; does not decide the charge |
| Public API edge and developer experience | **Oxy** | none |
| Routing *policy* (what a customer configured) | **Oxy** | consumes a versioned policy snapshot |
| Routing *execution* (which deployment served it) | **Relay** | owns; reports the resolved route back |
| Provider adapters, request translation, streaming, cancellation | **Relay** | owns |
| Provider health, circuit breakers, deployment inventory | **Relay** | owns; exposes a customer-safe projection to Oxy |
| Upstream provider cost | **Relay** | owns; never in an ordinary customer response |
| Technical usage measurement (tokens, time, images) | **Relay** | owns the measurement; Oxy owns the price |
| Model catalogue *identity and pricing* (customer-facing) | **Oxy** | consumes canonical model ids |
| Model catalogue *deployment availability* | **Relay** | owns |
| BYOK secret material | **Vault/KMS (Oxy-managed)** | consumes a secret *reference*, never the secret at rest |
| BYOK connection metadata (owner, scope, status) | **Oxy** | consumes |
| Alia memory, agents, tools, product behavior | **Alia** | none |
| Training and release of Alia-owned models | **Alia Models pipeline** | consumes published artifacts |

The exhaustive, per-table/event/API version of this table — including which repo
each item lives in and whether it exists today — is
`docs/architecture/inference-responsibility-matrix.md`.

### What Relay may store about a customer

Exactly three shapes, all immutable after write:

```text
attribution   { accountId, applicationId, credentialId, userId? }  — opaque, copied from the envelope
request       { requestId, generationId?, receivedAt, policyVersion, resolvedRoute, status }
usage         { requestId, units{…}, upstreamCost, providerReportedUsage?, measuredAt }
```

`accountId`, `applicationId`, `credentialId` and `userId` are **strings Relay
never parses, joins against a local entity, or writes**. There is no
`relay.accounts`, no `relay.applications`, no `relay.api_keys`, no
`relay.balances`. A Relay table whose primary key is an Oxy id is a copy of an
Oxy entity and is forbidden; a Relay table whose *foreign* column is an Oxy id,
written once at request time and never updated, is the intended shape.

### What crosses the boundary

- **Oxy → Relay**, per request: the versioned internal envelope (ADR 0010),
  carrying attribution (ADR 0007), the normalized request, the resolved routing
  policy snapshot and its version, and the reservation ceiling (ADR 0009).
- **Relay → Oxy**, per request: `requestId`, `generationId` where applicable, the
  resolved route in customer-safe form, normalized unit counts, a terminal
  status, and a typed error with a retryability classification.
- **Relay → Oxy**, out of band: deployment and provider health, as a customer-safe
  projection with no upstream credentials and no internal route ids.
- **Never across the boundary**: Oxy account/member/application/credential
  *mutations* in either direction; upstream provider secrets toward Oxy's
  application storage; wholesale cost into an ordinary customer response; prompts
  or completions into any durable store on either side by default.

### Authorization happens before forwarding

Relay authorizes nothing about a customer. Scope checks, account access,
credential status and spend reservation are all resolved at the Oxy edge, and
the envelope Relay receives is *already* an authorized instruction. Relay's own
authentication is service-to-service and proves only "this envelope came from
the Oxy edge". This is why credential revocation is effective immediately at the
edge without any Relay-side propagation.

## Alternatives rejected

**Give Relay a read replica of the Oxy account graph so it can authorize
locally.** It would remove one network hop from the hot path and buy a
replication lag on exactly the decisions where lag is a security property —
revocation, suspension, budget exhaustion. A stale replica authorizes a revoked
credential and cannot be distinguished from a working one.

**Let Relay compute the customer charge, since it already measures the units.**
Measurement and pricing are different facts with different owners. Pricing needs
the price version, the account's contract, promotional grants and BYOK platform
fees — all Oxy state — and putting the arithmetic next to the measurement is how
a second ledger starts.

**Define the boundary later, once Relay exists.** The Oxy work in this epic is
blocked on knowing what it may assume. Writing the contract against a repository
that does not exist is the point: it forces the interface to be stated rather
than discovered.

## Consequences

- Workstream 13 is tracked as an external dependency. Nothing in workstreams 0–12
  may block on `OxyHQ/Relay` existing; the internal envelope, the reservation
  protocol and the catalogue are testable against a stub data plane.
- The Oxy edge is on the latency path of every inference request, so its own
  work — attribution resolution, scope check, reservation — has a latency budget
  that must be measured, not assumed.
- A Relay-side schema review is a boundary review: any column holding an Oxy id
  must be justified as write-once attribution, and any table keyed by one is
  rejected.
- Because Relay stores no customer entity, a customer deletion in Oxy does not
  require a Relay deletion of accounts, members or credentials — only the
  retention rules on request and usage records apply.
- The boundary is asymmetric on purpose: Oxy can be correct about a customer
  while Relay is down, but Relay cannot be correct about a customer while Oxy is
  down. Configuration snapshots (workstream 13) exist to keep the data plane
  *serving* during a control-plane outage, not to let it make new customer
  decisions.
