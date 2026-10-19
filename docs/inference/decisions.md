# Typed decisions

**Rolling out.** Decisions are served by Kaana at `POST https://kaana.ai/v1/decisions`
(`@kaana.ai/sdk` `decisions.create`) and granted by Oxy like every other
`kaana.ai/v1` operation ([kaana-grants.md](kaana-grants.md)). The old edge's
`api.oxy.so/v1/decisions` route and `OxyInferenceClient.decide()` are gone
(`@oxy.so/core` 6.0.0, `@oxy.so/contracts` 5.0.0); Oxy's own decisions schemas
went with them.

A decision is nonstreaming and returns typed probabilities, not chat JSON. Choice
assigns a distribution to 2–255 mutually exclusive options. Score assigns a
distribution to 2–10 ordered levels and reports the expected zero-based index.
Noul reports a proposition's probability, with no separate confidence claim.
Every answer names an exact question ID; missing, extra, duplicate and mismatched
IDs are rejected. The request and answer shapes are `@kaana.ai/contracts`.

## Who may decide, and on which models

Two reviewed, versioned files decide it. Neither has an environment switch;
each changes only by a reviewed commit that bumps its version.

| File | Decides |
|---|---|
| `config/decisionsPolicy.ts` (`DECISIONS_POLICY_VERSION`) | the ordered **decisions profile**: the model lines that may answer, each with its revision once Kaana has published it, its own USD ceiling per request and the review it was admitted on; and the limits every step carries |
| `config/inferenceEconomicPolicy.ts` (`INFERENCE_ECONOMIC_POLICY_VERSION`) | which application may decide: a relationship with `operations: ['decisions']` and `pilot.decisions` terms (input ceiling, USD per request), plus its capacity |

The profile today is one line, `typesafe/jev-1.13` (TypeSafe's Jev 1.13, upstream
`typesafe/jev-1.13-20260917`, through OpenRouter, provider pinned, zero data
retention), at USD 0.001 a request. Kaana's publisher names a revision
`observed-<date of first publish>`, so the line carries no revision until the
activation change pins the one Kaana minted; until then the grant pins the one
revision Kaana publishes for the line. OpenAI's `gpt-6-luna` (Kaana provider slug
`openai-decisions`) is not listed: its Kaana route is built but has no funded key
or zero-data-retention evidence for Oxy's account yet.

The one relationship is `mention-kaana-decisions` (Mention's production service
token, decisions only): 2 in flight and 2 000 a UTC day, counted on its own rows,
at most 16 000 estimated input tokens and USD 0.001 a request, so at most USD 2 a
day. Console (`application_inference_limits`) can lower or raise both counts.
Mention is a first-party product, not `is_internal`: the relationship is of class
`first_party` and is re-checked against the live `applications.type`. Mention's
text generation at the `instant` level has a relationship of its own,
`mention-kaana-text` ([kaana-grants.md](kaana-grants.md)), so it never consumes
the decisions budget; every other Mention request stays commercial.

Provider facts are Kaana's, not Oxy's: the line's identity, data policy and list
price come from Kaana's declared catalogue, and its deployment from Kaana's
publication (`configs/public-catalogue.json`, `deployment-commercial.json`,
`provider-rates.json`).

## The grant

`authorizeInference` (`services/kaanaGrant.service.ts`):

1. An application without decisions terms is refused `permission_denied`
   (`decisions-not-enabled`): every commercial application, and an internal
   relationship that does not name decisions.
2. The hold is `requests` + `input_tokens` from `facts.estimatedInputTokens`,
   bounded by `pilot.decisions.maxInputTokens`. A line whose declared list does
   not publish `output_tokens` at exactly zero is not admitted
   (`priced-decision-output`): Kaana reports the few output tokens a decision
   emits, and they must settle inside the hold.
3. Target:
   - none: one step per profile line, in profile order (the application's
     default target is not used). Kaana moves to the next step only when the
     current one is skipped before anything is sent, never after a provider
     answered;
   - a model: it must be a profile line at its pinned revision, else
     `model_not_found` (`decisions-outside-profile`);
   - a power level: `invalid_request` (`decisions-level-target`).
4. Every step is revision-pinned: the profile's revision, or else the one
   revision Kaana publishes for the line. A line Kaana publishes no sellable
   route for, or several revisions of, is skipped
   (`decisions-revision-unpublished` / `-ambiguous` in the refusal log). That
   is what keeps a reviewed line inactive until Kaana serves it. No line
   admitted is `no_route_available`.
5. Every step requires zero data retention and no training on customer data,
   whatever the application's policy says, and sends `sameModelFailover: false`:
   each line is served on one provider and key. Its price ceiling is the tightest
   of the application's cap, the relationship's terms and the line's own.
6. Treatment `internal_metered`: no hold, a capacity slot, and the request past
   the day's limit is `quota_exceeded`.

Requests, criteria and answers are never persisted by Oxy. Reusing an idempotency
key is `idempotency_conflict`; there is no stored response to replay.

## Turning a line off

Remove its entry from the profile (or the relationship from the economic policy)
and bump the version, or have Kaana stop publishing its deployment.
