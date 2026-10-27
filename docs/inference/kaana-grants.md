# Grants and settlements for `kaana.ai/v1`

This is the grant/settlement mechanism introduced in Kaana ADR 0002 phase 2.
Its original "built, no caller until phase 3" status is historical. Current
source lives at the paths below; verified deployment and authority cutovers are
recorded in the [migration ledger](../architecture/first-party-integration-migration.md).
Neither source presence nor a service-identity probe proves a particular model,
provider route or paid generation has executed.

Kaana serves the public API and keeps the request's content. Oxy keeps
identity, Console policy, the ledger and billing, and answers two questions
over a private API:

| Call | What Oxy does |
|---|---|
| `POST /internal/kaana/v1/authorizations` | authenticates the caller's credential, applies the application's policy and limits, reserves, and returns a **grant** signed Ed25519 — or the public error Kaana relays |
| `POST /internal/kaana/v1/settlements` | settles one grant, exactly once, from Kaana's measured units |

Shapes are `@kaana.ai/contracts/internal` (`grant.ts`, `settlement.ts`,
`catalogue.ts`), the published npm package pinned exactly in
[`packages/api/package.json`](../../packages/api/package.json).
Code: `packages/api/src/routes/internalKaana.ts`,
`services/kaanaGrant.service.ts`, `kaanaGrantRoutes.service.ts`,
`kaanaDeclaredCatalogue.service.ts`, `kaanaGrantReads.service.ts`,
`kaanaSettlement.service.ts`, `kaanaGrantSigning.ts`.

## Where the price comes from: Kaana's catalogue, not Oxy's

Kaana ADR 0002, amendment 2026-10-15 («el catálogo es de Kaana»): the model
catalogue — identity, licence, provenance, data policy, capabilities, voices,
audience, power class and the **list price per unit** — is Kaana's
`configs/public-catalogue.json`, and nobody else's. Kaana relays it, whole, as
the `declaredCatalogue` member of its signed `GET /internal/v1/models`
(`declaredCatalogueSchema` in that pinned contract package). Oxy does not own a catalogue
any more; it **rates grants by reading Kaana's**.

```text
Kaana  GET /internal/v1/models  (signed, empty body)
        └─ declaredCatalogue.models[]  { modelId, audience, capabilities, license,
                                         dataPolicy, powerClass, pricing{priceVersionId, currency, unitPrices[]} }
   │  kaanaDeclaredCatalogue.service   in-memory cache, 60 s, single-flight,
   │                                   stale ≤ 5 min, then `service_unavailable`
   ▼
authorize  (kaanaGrant + kaanaGrantRoutes)
   1. model          declared? audience admits the viewer? not `retired`?   else model_not_found
   2. shape          modalities, apiFormats, realtime kind, context/output   else unsupported_modality / *_limit_exceeded
   3. price          `pricing` present? priceVersionId not republished?      else no_route_available (typed), never 0
   4. routes         deployments Kaana PUBLISHES for the line, with how Kaana says each may be sold (`commercial`)
                     ∩ the application's policy (providers, regions, ZDR, licences, price caps). EVERY eligible
                     route is admitted; Kaana chooses provider and key among them and fails over within them
   5. quote          the ceiling scenarios of the operation × the declared unit prices (the ledger's own SQL arithmetic)
   6. grant          admittedModelLines[{modelLine, priceVersionId}] and COPY of the unit prices:
                     kaana_grant_admitted_lines + kaana_grant_line_unit_prices
   ▼
settle     rates at the COPY on the grant (the version the grant admitted), never at a price Kaana publishes later
```

- **Versioned by `priceVersionId`.** A new price is a new id; a published id
  never changes. If an id Oxy has seen reappears with different prices that
  model prices nothing (`price_version_changed`) until Kaana publishes a new
  id. A grant keeps the entries it was rated at, so a settlement minutes later
  — on another task, after a restart, through the reconciliation feed — is
  rated at exactly that version.
- **No price, no grant; no price for a unit, no settlement.** A model without
  `pricing` (the BYOK-only case) is refused when granted
  (`no_route_available`, reason `pricing:model_not_priced`). A settlement in a
  unit the grant's list does not carry is rejected `422 unpriced_unit`, and a
  line served outside the grant that Kaana declares no price for is rejected
  `422 model_not_priced`. Nothing is ever settled at zero by absence.
- **Served outside the grant** is rated at Kaana's *current* declared list for
  the model that served, recorded `served_outside_grant`; if Kaana's catalogue
  cannot be read then the settlement is **deferred** (`503 catalogue_unavailable`,
  redelivered; the reconciliation feed stops before it and does not advance its
  cursor).
- **Not persisted.** The declared catalogue is cached in memory
  («lo cachea en memoria … no lo persiste»); what is stored is the grant's own
  copy of the entries it was rated at, the same discipline as
  `usage_receipt_unit_prices`. `price_version_id` columns of the ledger
  (`usage_receipts`, `usage_reservations`, `inference_metered_usage`,
  `kaana_grant_admitted_lines`) carry Kaana's label and have **no foreign key**
  to `price_versions` any more (migration 0161). The ledger takes the list by
  value (`PriceSnapshotInput` in `inferenceLedger.service.ts`).
- **What is still Oxy's** (the customer's, read from Oxy as before): the
  application's routing policy (allowed models and levels, providers, regions,
  data controls, price caps), Console limits, budgets and spending limits,
  holds, receipts, discounts and margins, the customer's provider connections
  (BYOK) and the BYOK platform fee (below). No Oxy catalogue table is read —
  `inference_deployments` included: how a deployment may be sold is published
  by Kaana.

### Kaana chooses the provider

Owner decision 2026-10-12: Kaana picks provider and key, cheapest first, with
failover and recovery. The grant therefore never narrows a step to one provider
and ranks nothing. `providerAllowlist` is every provider with an eligible route
under the application's policy (and the declared `denylist`, regions, ZDR,
licences are passed as values for Kaana to filter by).

The policy's **same-model failover** (`fallback.sameModelDeployment`, or
`fallback.disabled`) is sent as is on every step, as `sameModelFailover` in the
step limits (contract set 4.4.0, default `true`): when the policy turns it off
Kaana serves each admitted line on one provider and key and does not fail over
within the step. Every eligible provider is still admitted; Kaana, not Oxy,
chooses which.

### Kaana publishes how a route may be sold

The commercial basis of a deployment is a fact of the deployment and the
provider, so Kaana publishes it, per deployment, as `commercial` on the
deployment descriptor (`deploymentCommercialSchema`, the descriptors Oxy already reads for
`kaanaDeploymentPublication.service.ts`). Oxy sells a route only if the
descriptor carries it, its `availabilityScope` is one the viewer holds
(`byok_only` is decided apart, below), and its `commercialPermission` agrees
with the scope (`customer_byok` is exactly the `byok_only` permission). A
descriptor without `commercial` is not sold (fail closed).

### BYOK: platform_fee_only at Oxy's platform fee

A `byok_only` route is served on the customer's own provider key, which the
customer connected in Oxy (`inference_provider_connections`; a ready, valid
connection for the application, provider and environment, else the route does
not exist for that application). The grant is then `platform_fee_only`, carries
that one credential binding, takes no `maxFundingTier`, and is rated at Oxy's
**platform fee alone**: one flat fee per request, every metered unit at an
explicit zero (the provider bills those to the customer).

The fee is Oxy billing configuration, not a model price: typed, versioned and
reviewed in code in `config/inferencePlatformFee.ts` (`PlatformFeeSchedule`:
`feeVersionId`, `effectiveFrom`, `currency`, `perRequest`, approval). It is not
in `price_versions` and not in Kaana's catalogue (a BYOK-only model declares no
`pricing`). The list of approved schedules **ships empty**: the owner has not
approved an amount, and production stays fail-closed (`billing.md`) — a BYOK
route is refused (`no_route_available`) rather than rated at zero. A grant
copies the schedule's entries like any other list, so its settlement is rated
at the version it was granted under. Kaana's own keys are used unless the
policy prefers the customer's key (`byokPreference: prefer`) or has none to
offer; `require` serves only the customer's key and `disabled` never.

### What serves the old edge only

Oxy's own catalogue — `inference_models`, `inference_model_revisions`,
`inference_publishers`, `price_versions` / `price_version_unit_prices`,
`inference_deployment_routing_scores`, `inference_model_power_classes` — their
service (`inferenceCatalogue.service.ts`), the Kaana catalogue sync
(`kaanaCatalogueSync.service.ts`) and the bootstrap
(`scripts/bootstrap-kaana-catalogue.ts`) keep serving **only the old edge**,
`api.oxy.so/v1`, and its `/v1/models`, while they exist. Phase 5 deletes them
(Kaana ADR 0002, «Qué se retira de Oxy en la fase 5»). There is **no reverse
sync and no double write**: nothing writes Oxy's tables from Kaana's file or
Kaana's file from Oxy's tables. The guard
`services/__tests__/kaanaGrantCatalogueGuard.test.ts` fails if the grant, the
settlement or the catalogue reader imports one of those tables or resolvers.

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
  for external credentials, or protocol-2 workload mint for own services).
  External tokens require the live `inference:invoke` scope. Own workloads
  carry `authority: 'first_party'` without scopes and retain live binding,
  owner, environment and inference-domain checks. Oxy's ordinary API refuses
  `kaana.ai` tokens and the grant API refuses `oxy-api` ones.
- A person's Oxy session (`product_session`, [ADR 0050](../adr/0050-product-session-inference-on-kaana.md)),
  tried when the bearer is neither, or is presented as
  `oxy_session:<public client id>:<access token>`: verified by
  `sessionService.validateSession`; the application read from the session ROW
  (`sessions.application_id` and the live credential `client_id` names), or, for
  the shared device session of every official app (ADR 0029, no application on
  its row), from the live `public` credential row of the presented client id,
  only when that application's terms accept it (`sharedSessionAttribution`);
  its owner the payer, the session's subject account the `userId`. Grants only
  (a catalogue or receipt read is `permission_denied`), and only under reviewed
  product-session terms. A shared session presented alone, or with an unknown,
  revoked or termless client id, or an application-bound one with another
  client id, is `permission_denied`; an invalid, expired, revoked, supervised or
  malformed one is `authentication_failed`. `X-Oxy-User-Id` may be omitted; naming anyone
  but the session's person is `permission_denied`.

## The grant

`kind: "inference"`, from Kaana's content-free facts (counts, never content):

1. Verified own workload authority, or external `inference:invoke`;
   `X-Oxy-User-Id` (`onBehalfOfUserId`) is attribution only.
2. Treatment from the versioned relationships (`config/inferenceEconomicPolicy.ts`).
3. The operation's hold units from the facts — a missing fact is `invalid_request`
   naming it: completions `estimatedInputTokens` (+ `maxOutputTokens`, else the
   route's maximum), embeddings, images, speech `inputCharacters`, transcription
   **`audioInputMilliseconds`** (Kaana reads it from the upload's container;
   the hold is exactly that duration, and a route that prices the transcript's
   output tokens is not admitted), decisions `estimatedInputTokens` (input
   only; a line that prices output is not admitted).
4. The routing policy, pinned: default target, allowed levels, price cap,
   providers, regions, ZDR, licences, fallback.
5. **Steps.** A model target is one step plus the policy's authorized
   cross-model fallbacks; a level is one step (`auto`: every level it may land
   on), its lines being the models Kaana declares in the level's `powerClass`.
   Per step, each model line Kaana declares and the policy qualifies is admitted
   at the `priceVersionId` of the line's **declared list** — one price per line,
   so the hold covers whichever route Kaana picks and the price never depends
   on its choice. `providerAllowlist` is the providers that serve the line
   (published by Kaana with a `commercial` basis the audience may be sold,
   qualified by the policy), all of them; Kaana chooses and fails over, and the
   policy's `sameModelFailover` travels in the step limits. **Decisions** take
   their steps from the decisions profile instead (`config/decisionsPolicy.ts`):
   one per line, each pinned to the profile's revision or the one Kaana
   publishes, or the one line named; never a level; each with zero data
   retention, no training and no same-model failover
   ([decisions.md](decisions.md)).
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
| service token of Clarity's backend in production (`clarity-kaana`) | Clarity's owner; `internal_metered`, `relationshipId: clarity-kaana` | **no** | `embeddings` only, on the one pilot route; every other operation is outside the pilot |
| Alia naming `pro`/`ultra` (ADR 0037) | `internal_metered` | no | step 1: the level, `maxFundingTier: credit`, USD 1.00; step 2: `xhigh` on the pilot's lines and providers, USD 0.05 |
| BYOK route | `platform_fee_only` + `customerProviderCredential` | yes (the fee) | rated at Oxy's platform fee (`config/inferencePlatformFee.ts`), never a model price; no `maxFundingTier`; internal + BYOK is refused; no approved fee schedule yet, so refused |
| product agent in Alia (token exchange) | — | — | **not yet**: needs the RFC 8693 exchange (phase 2.2) |
| `product_session` of Astro, `responses` (`astro-kaana-session`, ADR 0050) | Astro's owner; `internal_metered`, `relationshipId: astro-kaana-session` | **no** | application from the session row; `instant` only (else `policy_violation`, `pilot-level`); 8 000 input, 512 output tokens (the caller's limit is required), USD 0.004 a request; 200 a person, 10 000 an application a UTC day, 16 in flight. Astro's shared device session is attributed by its public client id in the bearer (ADR 0050 option b) |
| `product_session` without reviewed terms (Inbox, any other app) | — | — | refused `permission_denied` (`product-session-not-enabled`); nothing is held or recorded |
| service token of Mention in production, `decisions` (`mention-kaana-decisions`) | Mention's owner; `internal_metered`, `relationshipId: mention-kaana-decisions` | **no** | decisions only, on the decisions profile; 2 in flight, 2 000 a UTC day on its own rows; first-party class, not `is_internal`; Mention's other operations are `commercial` unless the next row names them ([decisions.md](decisions.md)) |
| service token of Mention in production, `responses` / `chat_completions` (`mention-kaana-text`) | Mention's owner; `internal_metered`, `relationshipId: mention-kaana-text` | **no** | the `instant` level only (a model or other level is `policy_violation`, `pilot-level`); 32 000 input and 8 192 output tokens (the caller's limit is required), USD 0.035 a request (the dearest instant line at full size quotes USD 0.0301); 8 in flight, 5 000 a UTC day on its own rows; first-party class |
| `decisions` without decisions terms | — | — | refused `permission_denied` (`decisions-not-enabled`) |

Charged grants need `INFERENCE_CHARGING_AUTHORIZED`: a commercial grant must
carry its hold, so a shadow-metering deployment answers 503 instead.

## Realtime and transcription for `alia-kaana` (Alia ADR 0017)

Terms in `config/inferenceEconomicPolicy.ts` (policy version
`oxy-inference-economics/2026-10-15.2`, unchanged in `.3`), read only by the grant API:

- **`realtime_session`** (`conversation`): a line is admitted when ONE MINUTE of
  it quotes at most **USD 0.25**, over audio in, audio out, session time and,
  where the line prices it apart, the input transcription of that minute
  (`input_transcription_milliseconds`, `@kaana.ai/contracts` 4.1.0). Token-priced
  realtime lines have no per-minute bound and are not admitted. No hold; the
  usage row is the session's slot (`/v1/realtime`, up to 75 min unless settled).
- **`audio_transcriptions`**: at most **300 000 ms** (Alia's 5-minute clip) and
  **USD 0.05** per request. The hold is the measured duration; a line that also
  prices `requests` is quoted with one request, a line that prices the duration
  alone (xAI `grok-voice-transcribe-2.0`, settled in `audio_input_milliseconds`
  only) without it. A line that prices the transcript (`output_tokens`) is never
  admitted. When no line is admitted, `inference.grant.refused` logs
  `reason: no_admissible_line` with `exclusions` (`no-routes`,
  `priced-transcript`, `over-price`, `unquoted:<reason>`).

A commercial realtime session is refused: the facts carry no session duration,
so no hold sized from them would be a bound.

## Embeddings for `clarity-kaana` (Clarity search)

Terms in `config/inferenceEconomicPolicy.ts` (policy version
`oxy-inference-economics/2026-10-15.3`), read only by the grant API; the old
edge refuses every operation for this relationship:

- **`embeddings`** only, on the one route `dep_openrouter_qwen_qwen3_embedding_8b_observed_2026_10_15`
  (`qwen/qwen3-embedding-8b@observed-2026-10-15`, `openrouter`): at most
  **65 536** estimated input tokens (Clarity's largest request, 128 chunks of
  2 000 characters, estimates at 64 128) and **USD 0.001** per request. No hold.
- **Capacity:** 16 in flight, 60 000 requests a UTC day.
- No text, speech, realtime or transcription terms: each is refused as outside
  the pilot. A pilot carries its text terms whole or not at all
  (`pilotTextTerms`).

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
served line at the list the step admitted (a line outside the grant: Kaana's
current declared list, `served_outside_grant`, logged `policy_violation`), after
refusing a unit that list does not price (`422 unpriced_unit`), logs a tier above the step's `maxFundingTier`, calls
`settle` (charged grants, with the grant's copy of the list), `settleMeteredUsage`
and the usage telemetry, and closes the grant by compare-and-set. Every write is idempotent on its own key:
a redelivery answers `{status: "duplicate"}` and charges nothing. A settlement
naming no grant or the wrong hold is `422` (permanent). The new unit
`input_transcription_milliseconds` is a ledger column (migration 0159) and is
priced like any other.

`startKaanaSettlementSchedule` (every minute): grants past `expires_at` + 5 min
become `expired` (holds and slots already lapse on their own; a late
settlement still settles them once), and — only when this deployment has both
the Kaana binding and `KAANA_SETTLEMENT_PUBLIC_KEYS` — reads
`GET kaana.ai/internal/v1/settlements?cursor=`, signed with the edge key under
`SETTLEMENT_READ_SIGNATURE_DOMAIN` (`oxy-kaana-settlement-read:v1`) over the raw
query string only, cursor in `inference_provider_cost_feed_cursors`
(`kaana-settlements`). The domain, the path and the query come from
`@kaana.ai/contracts/internal` (>= 4.4.1), never from a copy here: until
2026-10-15 Oxy signed its own `oxy-kaana-settlements-read:v1` over `path?query`
and Kaana refused every read as unsigned (`Kaana settlement feed answered 401`).

## Not in this phase

- Token exchange (`POST /auth/service-token/exchange`) for Alia's product
  agents.
- Commercial realtime grants (the contract needs session ceiling facts).
- `OxyServer.serviceToken({ audience: 'kaana.ai' })` in `@oxy.so/core`.
- An approved BYOK platform fee amount (the schedule list ships empty).
- Revisions: the declared catalogue names a model, not its revisions, so a
  pinned `@revision` is held to the deployments Kaana publishes for it.
- Deletion of the old edge, `@oxy.so/core/inference` and `api.oxy.so/v1` (phase 5).

## What Kaana publishes (`@kaana.ai/contracts` 4.4.0)

- **`commercial` on each deployment descriptor** (`deploymentCommercialSchema`,
  from `@kaana.ai/contracts/internal`): `availabilityScope`,
  `commercialPermission` (`customer_byok` iff `byok_only`) and optional
  `dedicatedCapacity`. Oxy checks it against the published schema and carries it
  on `PublishedRoute.commercial`; there is no local copy of the type. A
  descriptor without it is not sold.
- **`sameModelFailover` on the grant step limits** (`grantStepLimitsSchema`),
  sent from the application's policy.
