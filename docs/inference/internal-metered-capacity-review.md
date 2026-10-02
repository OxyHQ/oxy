# Internal metering: capacity and catalogue decision candidate

This document proposes review choices; it activates no policy, deployment, credential
or provider. Nate decided that Alia and Kaana do not charge one another. The .2
capacity values remain proposed for **production**: 32 concurrent requests and
5,000 per UTC day. They are neither staging settings nor a monetary cost ceiling.
The application/environment capacity population includes all non-refused economic
treatments, and Auto parents/children each consume a claim.

## Read-only catalogue evidence

[Projected evidence](internal-metered-catalogue-evidence-2026-10-02.json) was captured
at `2026-10-02T14:17:07.198843+00:00`: HTTPS to `https://kaana.ai`,
`POST /internal/v1/deployments/query` with `{}`, using an existing Oxy Ed25519-signed
request. No response signature is asserted. Source reader head `198d0bc14`, runtime
task definition `oxy-oxy-api:691`, response snapshot `snap_8801d0c4e843149f`, 272 entries.
No inference or ledger write was performed. Only projected catalogue metadata is
retained; no credential material is included.

Candidate exact allowlist for owner/provider review, all reporting the model
`openai/gpt-oss-120b@observed-2026-09-01`:

| Exact deployment ID | Provider | Reported regions |
| --- | --- | --- |
| `dep_cerebras_gpt_oss_120b_observed_2026_09_01` | cerebras | `[]` |
| `dep_groq_openai_gpt_oss_120b_observed_2026_09_01` | groq | `[]` |
| `dep_openrouter_openai_gpt_oss_120b_observed_2026_09_01` | openrouter | `[]` |

Presence proves only that the catalogue listed those identities at capture time.
It does not prove residency, permitted audience, rights, privacy, credential binding,
price readiness or route eligibility. An empty region list cannot attest residency.
Existing Jev/Auto/scoped provider gates remain closed; this is not their approval.

## Concrete review choices

1. **Bounded technical pilot candidate:** review the three exact deployments above,
   retain the proposed 32 concurrent / 5,000 UTC-day claims, and explicitly approve
   or adjust an input ceiling of **8,192 tokens** and output ceiling of **2,048**.
   These ceilings are new proposals, not current enforcement. The source catalogue
   at `198d0bc14` declares 131,072 context tokens and 40,960 maximum output tokens
   (`packages/api/src/config/kaanaInitialCatalogue.ts`); Alia's existing adapter
   defaults its requested output to 4,096. The smaller proposed bounds require an
   implementation and approval before activation. Request/token ceilings constrain
   work, but cannot be described as a strict upstream monetary ceiling, especially
   when failed attempts or failover consume additional provider units.
2. **Strict provider-cost ceiling:** choose a USD ceiling and require a reviewed
   Kaana pre-admission maximum for all execution attempts, authenticated rate-card
   provenance and enforcement before each paid attempt. Current asynchronously
   ingested provider-cost events cannot enforce that ceiling after spending has
   already occurred. This needs an additive executor/admission contract; no
   defensible numeric ceiling follows from catalogue presence alone.
3. **Published-tariff proxy budget:** choose a monetary budget against immutable
   Oxy tariff quotes and label it a proxy explicitly. It is not verified upstream
   cost or an invoice. Missing prices must remain unknown rather than zero; partial
   costs and other currencies need explicit coverage. Do not silently substitute
   this proxy for choice 2.

No amount is invented here: price readback, binding and eligibility were not verified
by the projected catalogue query. Provider-reported events are provider declarations;
rate-card events are estimates. Invoice reconciliation requires invoice evidence.

## What real Kaana reconciliation still requires

An authorized read-only operator feed capture must retain cursor/window, request and
attempt identities, complete/partial/unknown cost flags, currency and measurement
presence. Reconciliation needs matching Oxy admissions with immutable principal,
application/environment, policy, request/idempotency context and, where present,
financial receipt context; ingestion into an isolated fixture must preserve NULL and
replay without extra units or charges. A live capture alone does not show production
Oxy ingestion or deployment, and is not invoice reconciliation. Any production write,
rollout, new permission, credential, provider activation or real inference remains a
separate authorization.
