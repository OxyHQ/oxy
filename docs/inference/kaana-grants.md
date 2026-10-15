# Grants and settlements for `kaana.ai/v1`

**Rolling out** (Kaana ADR 0002, phase 2). Oxy's side is built and deployable
with no caller: nothing reaches it until Kaana serves `https://kaana.ai/v1`
(phase 3). The old edge (`api.oxy.so/v1`) keeps serving until phase 5.

Kaana serves the public API and keeps the request's content. Oxy keeps
identity, Console policy, the ledger and billing, and answers two questions
over a private API:

| Call | What Oxy does |
|---|---|
| `POST /internal/kaana/v1/authorizations` | authenticates the caller's credential, applies the application's policy and limits, reserves, and returns a **grant** signed Ed25519 — or the public error Kaana relays |
| `POST /internal/kaana/v1/settlements` | settles one grant, exactly once, from Kaana's measured units |

Shapes are `@kaana.ai/contracts/internal` (`grant.ts`, `settlement.ts`),
the published npm package pinned exactly in `packages/api/package.json`.
Code: `packages/api/src/routes/internalKaana.ts`,
`services/kaanaGrant.service.ts`, `kaanaGrantReads.service.ts`,
`kaanaSettlement.service.ts`, `kaanaGrantSigning.ts`.

## Who may call it

Kaana alone, as a workload (ADR 0026): a service token minted for the
audience **`oxy-api:kaana-control`**, which only the pinned Kaana application
(`KAANA_APPLICATION_ID`) may hold. The token's row is re-read on every call,
and its APPLICATION comes from that row, never from the claim. An `oxy-api`
token is refused. The router is mounted before `/internal`.

Settlements are also signed by Kaana's own settlement key over their exact
bytes (`kaana-oxy-settlement:v1`, headers `X-Oxy-Kaana-{Key-Id,Timestamp,Signature}`,
five-minute window). Oxy holds the public halves:

```text
KAANA_SETTLEMENT_PUBLIC_KEYS   kid:base64,kid:base64   (raw 32-byte Ed25519 keys)
```

Unset, every settlement is answered 503; nothing is accepted unsigned.

## The caller's credential

Kaana forwards the `Authorization: Bearer` value verbatim. Oxy authenticates
it exactly as the old edge does (`authenticateInferenceBearer`):

- `oxy_sk_…` (Console) — the machine lane, behind `INFERENCE_MACHINE_CREDENTIAL_AUTH`,
  with the edge's own per-credential (60/min) and per-application (300/min)
  limits on the **same Redis buckets**, so a key has one budget across both
  surfaces. Over it: `429 rate_limited` with `retryAfterMs`.
- A service token minted with **`audience: "kaana.ai"`** (`POST /auth/service-token`
  or the workload mint). The mint refuses `kaana.ai` unless the minted scopes
  include `inference:invoke`; Oxy's own API refuses `kaana.ai` tokens and the
  grant API refuses `oxy-api` ones.
- A user session (`product_session`) is **not granted yet** (see below).

## The grant

`kind: "inference"`, from Kaana's content-free facts (counts, never content):

1. `inference:invoke`; `X-Oxy-User-Id` (`onBehalfOfUserId`) is attribution only.
2. Treatment from the versioned relationships (`config/inferenceEconomicPolicy.ts`).
3. The operation's hold units from the facts — a missing fact is `invalid_request`
   naming it: completions `estimatedInputTokens` (+ `maxOutputTokens`, else the
   route's maximum), embeddings, images, speech `inputCharacters`, transcription
   **`audioInputMilliseconds`** (Kaana reads it from the upload's container;
   the hold is exactly that duration, and a route that prices the transcript's
   output tokens is not admitted).
4. The routing policy, pinned: default target, allowed levels, price cap,
   providers, regions, ZDR, licences, fallback.
5. **Steps.** A model target is one step plus the policy's authorized
   cross-model fallbacks; a level is one step (`auto`: every level it may land
   on). Per step, each model line Oxy's catalogue qualifies is admitted at the
   price version of its **dearest** qualified route — the line's list price for
   this grant, so the hold covers whichever route Kaana picks and the price
   never depends on its choice. `providerAllowlist` is the providers Oxy
   qualified; same-model failover off narrows it to the best one.
6. The ceiling: the dearest admitted line's quote.
7. `claimMeteredAdmission`: idempotency (`Idempotency-Key` shares the edge's
   ledger key), internal capacity, Console session limits.
8. `reserve` (balance, spending limits, `promotional-only`), unless internal.
9. Validated by `grantSchema`, stored (`kaana_grants`, `kaana_grant_steps`,
   `kaana_grant_admitted_lines`), signed with the edge key
   (`KAANA_EDGE_SIGNING_*`) under `oxy-kaana-grant:v1`. Kaana verifies with the
   `KAANA_EDGE_PUBLIC_KEYS` it already holds. Kaana must start within 60 s.

`kind: "catalogue.read"` answers the catalogue audience (`public` /
`platform_internal`) and the policy's allowed levels (60 s). `kind:
"receipt.read"` answers the generation record (`inference:usage:read`, own
credential only) in the public shape: amount, never provider.

## Who pays: the matrix is today's

| Lane (credential) | Grant `principal` / `economics` | Hold | Notes |
|---|---|---|---|
| `oxy_sk_` of Console (`machine_credential`) | owner of the app → billable ancestor; `commercial` | yes | rate limits as on the edge; `userId` attribution only |
| `oxy_sk_` of a third party forwarded by Alia (ADR 0035) | owner of the **calling** app; `commercial` | yes | same lane; Alia sends no `userId` |
| service token `aud: kaana.ai` (ADR 0026) | owner of the token's app (row, not claim); `commercial` | yes | |
| service token of Alia in production (`alia-kaana`) | Alia's owner; `internal_metered`, `relationshipId: alia-kaana` | **no** | `capacity.meteredUsageId`; pilot tuples and USD ceilings; realtime and transcription under their own terms |
| Alia outside production | owner of the Alia app; `commercial` | yes | relationship lists production only |
| Alia naming `pro`/`ultra` (ADR 0037) | `internal_metered` | no | step 1: the level, `maxFundingTier: credit`, USD 1.00; step 2: `xhigh` on the pilot's lines and providers, USD 0.05 |
| BYOK route ranked first | `platform_fee_only` + `customerProviderCredential` | yes (the fee) | no `maxFundingTier`; internal + BYOK is refused |
| product agent in Alia (token exchange) | — | — | **not yet**: needs the RFC 8693 exchange (phase 2.2) |
| `product_session` (Inbox, app sessions) | — | — | **not yet**: needs the public credential and Inbox's session check |
| scoped permit, Private Auto, Mention classifier, `decisions` | — | — | **not yet**: approvals must be re-issued under `canonicalInputSha256` |

Charged grants need `INFERENCE_CHARGING_AUTHORIZED`: a commercial grant must
carry its hold, so a shadow-metering deployment answers 503 instead.

## Realtime and transcription for `alia-kaana` (Alia ADR 0017)

Terms in `config/inferenceEconomicPolicy.ts` (policy version
`oxy-inference-economics/2026-10-15.2`), read only by the grant API:

- **`realtime_session`** (`conversation`): a line is admitted when ONE MINUTE of
  it quotes at most **USD 0.25**, over audio in, audio out, session time and,
  where the line prices it apart, the input transcription of that minute
  (`input_transcription_milliseconds`, `@kaana.ai/contracts` 4.1.0). Token-priced
  realtime lines have no per-minute bound and are not admitted. No hold; the
  usage row is the session's slot (`/v1/realtime`, up to 75 min unless settled).
- **`audio_transcriptions`**: at most **300 000 ms** (Alia's 5-minute clip) and
  **USD 0.05** per request.

A commercial realtime session is refused: the facts carry no session duration,
so no hold sized from them would be a bound.

## Limits are Console configuration

`application_inference_limits`, written in Console (Inference → Routing) or
`PUT /inference/routing-policies/applications/:id/limits` by a person with
`inference:routing:write` (never the application's own service token):

| Column | Bounds | NULL means |
|---|---|---|
| `max_concurrent_realtime_sessions` | sessions open at once, per app | no session limit |
| `max_concurrent_realtime_sessions_per_credential` | the same, per credential (≤ app's) | no per-credential limit |
| `max_concurrent_requests` | an internal relationship's requests in flight (sessions not counted) | the relationship's reviewed default (32) |
| `max_requests_per_utc_day` | an internal relationship's requests per UTC day | the reviewed default (5 000) |

Spend is `spending_limits` (budgets), enforced by `reserve`.

## Settlement and reconciliation

`applySettlement` (delivery and reconciliation alike) checks the settlement
names its grant (`requestId`, `reservationId`, `meteredUsageId`), prices the
served line at the step's admitted `priceVersionId` (a line outside the grant:
the served deployment's own price, `served_outside_grant`, logged
`policy_violation`), logs a tier above the step's `maxFundingTier`, calls
`settle` (charged grants), `settleMeteredUsage` and the usage telemetry, and
closes the grant by compare-and-set. Every write is idempotent on its own key:
a redelivery answers `{status: "duplicate"}` and charges nothing. A settlement
naming no grant or the wrong hold is `422` (permanent). The new unit
`input_transcription_milliseconds` is a ledger column (migration 0159) and is
priced like any other.

`startKaanaSettlementSchedule` (every minute): grants past `expires_at` + 5 min
become `expired` (holds and slots already lapse on their own; a late
settlement still settles them once), and — only when this deployment has both
the Kaana binding and `KAANA_SETTLEMENT_PUBLIC_KEYS` — reads
`GET kaana.ai/internal/v1/settlements?cursor=`, signed with the edge key under
`oxy-kaana-settlements-read:v1` over the request target, cursor in
`inference_provider_cost_feed_cursors` (`kaana-settlements`). Kaana builds that
endpoint in phase 3 and must verify that signature.

## Not in this phase

- Token exchange (`POST /auth/service-token/exchange`) for Alia's product
  agents; the `product_session` lane and Inbox's session check.
- Re-issued source approvals (scoped, Private Auto, Jev) and `decisions` grants.
- Commercial realtime grants (the contract needs session ceiling facts).
- `OxyServer.serviceToken({ audience: 'kaana.ai' })` in `@oxy.so/core`.
- Kaana publishing `powerClass` in its catalogue: admitted lines still come
  from Oxy's `inference_model_power_classes` until then.
- Deletion of the old edge, `@oxy.so/core/inference` and `api.oxy.so/v1` (phase 5).
