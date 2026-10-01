# Typed decisions (implementation, not enabled)

`POST /v1/decisions` and `OxyInferenceClient.decide()` return nonstreaming typed
probabilities. They do not generate chat JSON. Choice assigns a distribution to
2–255 mutually exclusive options. Score assigns a distribution to 2–10 ordered
levels and reports the expected zero-based index. Noul reports a proposition's
probability, with no separate confidence claim. Every answer names an exact
question ID; missing, extra, duplicate and mismatched IDs are rejected.

```ts
const result = await inference.decide({
  model: 'typesafe/jev@reviewed-immutable-revision',
  state: 'Synthetic fixture',
  instructions: 'Evaluate only the supplied state.',
  effort: 'instant',
  questions: [{ id: 'eligible', kind: 'noul', question: 'Is the fixture eligible?' }],
}, { idempotencyKey: 'unique-decision-operation' });
```

This example currently receives `service_unavailable`. The production admission
function `decisionAvailability()` is closed for every caller, including internal
applications and BYOK. Ordinary TypeSafe standalone resale and OpenRouter resale
or competitor credentials do not establish eligibility. Enabling a route requires
independent review of its exact deployment and credential eligibility, provider
terms, internal-use permission, privacy and effective ZDR, plus matching generated
Kaana contracts. No environment switch bypasses this gate.

Questions, criteria, options, levels, state and instructions count toward a
conservative UTF-8 byte bound: 65,536 total and 32,768 for state plus instructions
plus the longest complete question. This is deliberately more restrictive than a
provider-token limit. Effort is strictly `instant`, `low`, `medium`, `high` or
`xhigh`. All probabilities are finite and in [0,1]; distributions sum to one and
score means match their distribution within 1e-6.

Oxy owns caller scopes, application/account attribution, policy, privacy,
capability checks, exact revision selection, reservation and settlement. A model
must affirmatively declare `decisions` in `apiFormats`; a legacy missing
capability is not permission. Kaana executes the signed envelope only at
`https://kaana.ai/internal/v1/decisions`. The existing envelope stays generation 2;
this addition is contract set 3.5.0. Each decisions wire result is generation 1.
The public result includes immutable model and policy references. Probabilities
are transient results, separate from technical usage and ledger amounts.

A classification has one request and one reservation. A subsequent generation
has its own request and reservation: the classifier never reserves the later
operation's budget. The conservative input ceiling includes the shared context
for every question; there is no generated-output-token allowance. Reviewed price
cards and actual adapter metering still need verification before activation.
Requests, criteria and answers are never persisted. Reusing an idempotency key
returns `idempotency_conflict`; there is no stored response to replay and the SDK
performs no automatic retry.

Alia and Homiio agents can call the same SDK through their Oxy delegation. One-shot
Mention features call Oxy directly. None needs product-local provider credentials,
response parsing or routing selection.
