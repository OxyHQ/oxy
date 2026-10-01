# Decisions implementation handoff (2026-10-01)

Authority: Oxy contracts in this worktree. Read source for final schemas. No public
Jev enablement; ordinary TypeSafe/OpenRouter credentials remain ineligible. No live
provider calls, deployment or credential changes are part of this work.

Observed baseline: Oxy `INFERENCE_CONTRACT_VERSION=3.4.0`, contracts package 4.6.0;
Kaana assigned tree `ContractVersion=3.3.0`, generator pins package 4.5.0; envelope
generation 2 on both. This change targets contract set **3.5.0**, envelope **2**.
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
all count toward a conservative UTF-8 byte budget: total <=65536; state + instructions
+ longest complete question <=32768 (gateway bound, applied at Oxy too).

Answers: `DecisionAnswer` discriminated by `kind`, always exact `id`:
- choice: `{id,kind:'choice',probabilities:number[]}` parallel to options, sum 1.
- score: `{id,kind:'score',mean:number,distribution:number[]}` parallel to levels,
  sum 1; mean equals sum(index * probability).
- noul: `{id,kind:'noul',probability:number}`; NO synthetic confidence.
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
49 contracts suites/851 tests and synthetic signed-hop tests pass. API production
gate is hard closed, not an environment flag. No npm release has been made.
