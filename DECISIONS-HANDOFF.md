# Decisions implementation handoff (2026-10-01)

Authority: Oxy contracts in this worktree. Read source for final schemas. No public
Jev enablement; ordinary TypeSafe/OpenRouter credentials remain ineligible. No live
provider calls, deployment or credential changes are part of this work.

Observed baseline: Oxy `INFERENCE_CONTRACT_VERSION=3.4.0`, contracts package 4.6.0;
Kaana assigned tree `ContractVersion=3.3.0`, generator pins package 4.5.0; envelope
generation 2 on both. This change targets contract set **3.5.0**, envelope **2**, decisions result **1**.
The candidate package is **@oxy.so/contracts 4.7.0**, UNPUBLISHED (repo convention:
minor bump in the feature PR, released only after merge). A `-dev` prerelease was
rejected: it falls outside federation's `^4.0.0` range and made bun pull published
4.6.0 into the workspace lockfile. Until a release exists, Kaana's descriptor must
record provenance as LOCAL SOURCE: Oxy branch feat/jev-decisions-20261001 at the
exact commit it generated from, package 4.7.0 unpublished, contract set 3.5.0 —
never "published 4.6.0", and its generator pin must not claim an npm artifact.
Kaana must regenerate against final local Oxy source, never assume stale docs match.

Public `POST /v1/decisions`; SDK `OxyInferenceClient.decide(request, options)`.
Strict request: `{model, state, instructions?, questions, effort?}`. Model must be
an exact revision-pinned reference. Effort is `instant|low|medium|high|xhigh` only.
Questions have unique exact `id`, `kind`, `question`, optional `criteria`:
- choice: `options: string[]` (2..255 unique exclusive options).
- score: `levels: string[]` (2..10 ordered levels, zero-based indices).
- noul: binary proposition probability only.

Typed envelope input: `{format:'decisions', decisions:{state,instructions?,questions,effort?}}`;
`client.apiFormat='decisions'`, `modality='text'`, `stream=false`, empty sampling/tools,
no chat generation controls. State + instructions + criteria + question/options/levels
all count toward a conservative SERIALIZED UTF-8 byte budget, including JSON
escaping, keys, repeated question instructions and container overhead. Direct:
total <=64000 and state + longest complete question <=32000. OpenRouter:
TOTAL <=32000, including a 4096-byte reserved gateway-policy allowance. Oxy
filters gateway routes separately; Kaana MUST measure the final serialized
provider body before sending it. Context capacity uses the longest question,
not shared state multiplied by question count. Billing remains a separate ceiling.

Answers: `DecisionAnswer` discriminated by `kind`, always exact `id`:
- choice: `{id,kind:'choice',reply:string,confidence:number,probabilities:number[]}` parallel to options, sum 1.
- score: `{id,kind:'score',reply:number,confidence:number,mean:number,distribution:number[]}` parallel to levels,
  sum 1; mean equals sum(index * probability).
- noul: `{id,kind:'noul',probability:number}`; NO synthetic confidence.
Choice reply is the ORIGINAL provider `choice` label and must select a maximum
probability option. Score reply is the ORIGINAL provider `score` (same numeric
expected index as mean). Confidence is REQUIRED from the actual Choice/Score
provider response; NEVER infer it from probabilities or a default. Missing
confidence/reply fails closed. Noul prohibits confidence. Official source:
https://docs.typesafe.ai/api and https://docs.typesafe.ai/models .
All probabilities finite [0,1]; sums/mean tolerance 1e-6. Result IDs must exactly
match questions once each, matching kind and option/level cardinality.

Nonstreaming signed endpoint proposed: `POST /internal/v1/decisions` with the same
InferenceRequest envelope and exact-body signature/origin as existing inference.
`DecisionResult = {schemaVersion:1,requestId,model,data:DecisionAnswer[],usage:NormalizedUsageReport}`.
Public `DecisionSuccess` uses same keys with `usage:UsageQuantity[]` and
`routingPolicy:RoutingPolicyReference` (no provider money from Kaana).
Failures use the existing typed inference error HTTP body. Classification cost is
its own request/receipt; no second reservation for the eventual generation.

Admission requires affirmative `apiFormats:['decisions']`; legacy omitted formats
do not qualify. Internal eligibility/privacy/ZDR and exact route review must pass
before any hold or provider execution. Initial production gate remains closed.
Alia/Homiio/Mention can reuse the SDK and typed questions; no local provider plumbing.

Final wire note: DecisionResult validates that usage.requestId/model match the
outer result and usage.outcome is completed. Envelope decisions forbid all
cross-model/revision substitution, including within signed authorizedRoutes.
Contract source is now available at packages/contracts/src/inference/decisions.ts;
Revision checks are recorded separately in IMPLEMENTATION-RESULT.md. API production
gate is hard closed, not an environment flag. No npm release has been made.

SDK decisions bind the successful body requestId to X-Oxy-Request-Id. No replay.
Reviewer revisions in progress: do not merge/deploy until exact-head CI and
independent coordinator review. Source schemas in this worktree are authoritative.

## Failures after the signed forward (revision 3)

Kaana's decisions failure body is now typed in Oxy contracts as
`DecisionFailure = {schemaVersion:1, requestId, error: InferenceError, usage?: NormalizedUsageReport}`
(versioned shape 1; add it to the generated descriptor). `error.requestId` and
`usage.requestId` must equal `requestId`; `usage.outcome` must NOT be `completed`.
Kaana SHOULD answer a provider failure with HTTP 502 + DecisionFailure and include
`usage` whenever the provider measured anything; absent `usage` means unmeasured,
never zero. A bare InferenceError 502 is still accepted (no usage). Oxy semantics:
- 4xx: envelope rejected before execution (unchanged).
- 5xx with a typed failure for this request: code preserved; usage settled exactly.
- Anything else after send (transport cut, untyped 5xx, foreign requestId,
  truncated/non-JSON 200): `execution_uncertain` → public `provider_error`,
  settled with `usageSource: estimated` and zero billed (refund reason
  usage_unavailable), never presented as measured.
- Every decisions failure after the forward is `retryable: false`: the request
  may already have executed and responses are not retained.

Idempotency (shared semantics, Auto please note): the edge's pre-check is a fast
path only. A ledger `already-reserved` result is now refused with
`idempotency_conflict` instead of borrowing the winner's hold, so two concurrent
same-key requests execute once. This is base #1503 and does not depend on #1504.
