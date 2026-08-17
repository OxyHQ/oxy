# Inference platform — responsibility matrix

- Issue: #972 (workstream 0/A)
- Date: 2026-08-15. **§15 was re-verified and updated on 2026-08-16**, when the
  SDK catalogue client and the `docs/inference/` doc set landed; one §5 row was
  corrected at the same time because `models-stats.ts` no longer exists. **§6
  and one §7 row were re-verified on 2026-08-16** against #1012's route-selection
  enforcement and the usage-unit contract (#1017, #1018). **Five §12 rows were
  re-verified and updated on 2026-08-17** — the two payload-retention rows and the
  PII row against [ADR 0016](../adr/0016-no-inference-payload-persistence.md), and
  the secret-scanning and rotation-runbook rows against the gates and
  [`docs/runbooks/`](../runbooks/README.md) that landed with it. Every other row is
  still a claim about 2026-08-15, and §5's descriptor rows in particular predate
  the catalogue merging (#982) — re-verify before citing them.
- Governing decisions: [ADR 0005](../adr/0005-oxy-is-the-single-control-plane.md),
  [ADR 0006](../adr/0006-oxy-relay-boundary.md),
  [ADR 0007](../adr/0007-canonical-request-attribution.md),
  [ADR 0008](../adr/0008-catalogue-concept-separation.md),
  [ADR 0009](../adr/0009-usage-reservation-and-settlement.md),
  [ADR 0010](../adr/0010-public-api-compatibility.md),
  [ADR 0011](../adr/0011-inference-data-plane-name.md)

This is the committed ownership record the epic's *"Define ownership of every
table/event/API in a responsibility matrix committed to the repo"* checkbox
refers to. It is exhaustive over every table, event and API surface named in
issue #972.

**Owner** is the single source of truth for the item (ADR 0006). Another system
may *consume* it; only the owner may write it.

**Status** is a claim about this repository on the date above:

- `exists` — present in the repo at the path given, verified by reading it.
- `planned` — named by the epic, and confirmed **absent** from the repo.
- `unverified` — a fact about production data or an external system that cannot
  be established from the repo. Used sparingly, and each occurrence says what
  would settle it.

`Relay` is a working name only (ADR 0011). Where a row's repo is
`OxyHQ/Relay`, the repository itself does not exist — verified 2026-08-15:
`gh repo view OxyHQ/Relay` → `Could not resolve to a Repository with the name
'OxyHQ/Relay'`. Workstream 13 is tracked as an external dependency of this epic.

---

## 1. Account, application and credential ownership (epic §1, §2)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Account graph (`users`, `kind`, `parent_account_id`) | Oxy | OxyHQServices `packages/api/src/db/schema/users.ts:144,353` | exists |
| Account kind vocabulary (`personal`/`organization`/`project`/`bot`/`channel`) | Oxy | OxyHQServices `packages/contracts/src/accountGraph.ts:35` | exists |
| Account membership and roles (`account_members`) | Oxy | OxyHQServices `packages/api/src/db/schema/accountMembers.ts:68` | exists |
| Effective-access resolution (caller → effective account role) | Oxy | OxyHQServices `packages/api/src/services/account.service.ts:724` | exists |
| Account graph client surface | Oxy | OxyHQServices `packages/core/src/mixins/OxyServices.accounts.ts` | exists |
| `applications` (`owner_account_id`) | Oxy | OxyHQServices `packages/api/src/db/schema/applications.ts:172` | exists |
| Application access derived from owning account, no per-app member table | Oxy | OxyHQServices `packages/api/src/routes/applications.ts:72-79` | exists |
| `application_credentials` (public key, secret hash, rotation grace, lineage) | Oxy | OxyHQServices `packages/api/src/db/schema/applicationCredentials.ts:55,71,87,102` | exists |
| Credential usability predicate (active OR deprecated-in-grace) | Oxy | OxyHQServices `packages/api/src/utils/credentialUsability.ts` | exists |
| `developer_api_keys` (legacy; removal candidate, epic §2.3) | Oxy | OxyHQServices `packages/api/src/db/schema/developerApiKeys.ts` | exists |
| `developer_api_keys` confirmed empty in production | Oxy | production database | unverified — settled by a production row count, not by reading the repo |
| Machine/API-key credential type (`oxy_sk_*`), one-time bearer | Oxy | OxyHQServices `packages/api/src/db/schema/applicationCredentials.ts` (extension) | planned |
| Helper: application → owner account | Oxy | OxyHQServices `packages/api/src` | planned |
| Helper: credential → application → owner account | Oxy | OxyHQServices `packages/api/src` | planned |
| Helper: owner account → billing profile | Oxy | OxyHQServices `packages/api/src` | planned |
| Relay organization / workspace / project / membership table | **forbidden** (ADR 0005 invariants 1–3) | — | must never exist |
| Relay application-id or API-key issuance | **forbidden** (ADR 0005 invariants 2–3) | — | must never exist |

## 2. Authentication and authorization (epic §2.2, §3)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `POST /auth/service-token` (client credentials → 1h service JWT) | Oxy | OxyHQServices `packages/api/src/routes/auth.ts:3663` | exists |
| Service-token claims: `appId`, `appName`, `credentialId`, `scopes`, `environment` | Oxy | OxyHQServices `packages/api/src/routes/auth.ts:3663-3673` | exists |
| Service-token claims: `ownerAccountId`, effective scopes envelope | Oxy | OxyHQServices `packages/api/src/routes/auth.ts` | planned |
| Delegated end-user header `X-Oxy-User-Id` | Oxy | OxyHQServices `packages/core/src/mixins/OxyServices.auth.ts:734`, `OxyServices.utility.ts:514` | exists |
| Service-token verification (signature required) | Oxy | OxyHQServices `packages/core/src/mixins/OxyServices.utility.ts` | exists |
| Shared-secret vs asymmetric/JWKS cross-repo verification decision | Oxy | OxyHQServices `docs/` | planned |
| `APPLICATION_SCOPES` vocabulary | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:61` | exists |
| `chat:completions`, `models:read` scopes | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts:67-68` | exists |
| `inference:invoke`, `inference:models:read`, `inference:usage:read`, `inference:routing:read`, `inference:routing:write`, `inference:providers:read`, `inference:providers:write` | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts` | planned |
| Credential scopes intersected with application scopes | Oxy | OxyHQServices `packages/api/src/routes/auth.ts:3660-3662` | exists |
| Privileged / staff-approval scope list | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts` (`PRIVILEGED_APPLICATION_SCOPES`) | exists |
| Account/application RBAC mappings for inference, usage, routing, BYOK, billing | Oxy | OxyHQServices `packages/api/src` | planned |
| Relay-side customer authorization | **forbidden** (ADR 0006) — the edge authorizes before forwarding | — | must never exist |

## 3. Public API edge (epic §4, ADR 0010)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `POST /v1/chat/completions` (today: Alia proxy under `authMiddleware`) | Oxy | OxyHQServices `packages/api/src/routes/alia.ts:65`, mounted `server.ts:647` | exists |
| `POST /v1/voice/token`, `POST /v1/voice/transcribe` (Alia product endpoints) | Alia | OxyHQServices `packages/api/src/routes/alia.ts:99,102` | exists |
| `/alia` mount (same router) | Alia | OxyHQServices `packages/api/src/server.ts:643` | exists |
| Static `ALIA_API_KEY` upstream forwarding (to be removed, epic §4, §14) | Alia | OxyHQServices `packages/api/src/routes/alia.ts:8,46-50,75-81` | exists |
| `POST /v1/responses` (preferred endpoint) | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `GET /v1/models`, `GET /v1/models/:id` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `GET /v1/generations/:id` (receipt lookup) | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/embeddings` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/images/generations` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/audio/transcriptions`, `POST /v1/audio/speech` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/rerank` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `POST /v1/batches` | Oxy | OxyHQServices `packages/api/src/routes` | planned |
| `GET /models/stats` (static catalogue; retired by ADR 0008) | Oxy | OxyHQServices `packages/api/src/routes/models-stats.ts`, mounted `server.ts:650` | exists |
| Edge attribution resolution before forwarding | Oxy | OxyHQServices `packages/api/src` | planned |
| Edge scope authorization before forwarding | Oxy | OxyHQServices `packages/api/src` | planned |
| Spend reservation before the data plane | Oxy | OxyHQServices `packages/api/src` | planned |
| Streaming pass-through without buffering | Oxy | OxyHQServices `packages/api/src/routes/alia.ts:83-88` (present shape) | exists |
| Client-cancellation propagation to Relay and upstream | Oxy → Relay | OxyHQServices + OxyHQ/Relay | planned |
| Normalized rate-limit and usage headers | Oxy | OxyHQServices `packages/api/src` | planned |
| Idempotency keys for non-streaming / batch-safe operations | Oxy | OxyHQServices `packages/api/src` | planned |
| Request-size, context-size, output-token limits | Oxy | OxyHQServices `packages/api/src` | planned |
| Abuse / fraud / anomaly controls before public launch | Oxy | OxyHQServices `packages/api/src` | planned |

## 4. Oxy↔Relay contracts (epic §0 "Contract package")

The package `@oxyhq/contracts` exists (`packages/contracts`, zod-only, epic's
"dependency-light" requirement already met). Every schema below is absent today.

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `@oxyhq/contracts` package | Oxy | OxyHQServices `packages/contracts` | exists |
| Authenticated principal and attribution schema | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Normalized inference request schema (internal envelope, ADR 0010) | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Normalized stream event schemas | Relay (shape agreed with Oxy) | OxyHQServices `packages/contracts/src` | planned |
| Model catalogue descriptor schemas | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Routing policy schema | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Usage reservation schema | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Usage settlement / receipt schema | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Refund / reversal schema | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Provider / BYOK connection metadata schema (no secrets) | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Price-version schema | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Error and retryability schema | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Envelope/event version fields on every externally consumed shape | Oxy | OxyHQServices `packages/contracts/src` | planned |
| Schema-version compatibility tests (Oxy ↔ Relay) | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |

## 5. Model catalogue (epic §5, ADR 0008)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Static `alia-lite` / `alia-v1` / `alia-v1-pro` / `alia-v1-pro-max` array (retired) | Oxy | OxyHQServices `packages/api/src/routes/models-stats.ts` | **gone** — the file was deleted with the catalogue landing (#982). Every surviving occurrence of the four names is enumerated in `docs/inference/migration.md` |
| Same fake ids in Console model docs | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/models.tsx:13-43` | exists |
| Same fake ids in quickstart / chat-completions examples | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/quickstart.tsx:127`, `documentation/chat-completions.tsx:109` | exists |
| Playground default model string | Oxy | OxyHQServices `packages/console/src/routes/_layout/playground.tsx:103` | exists |
| `AI_LABELING_MODEL` default `alia-lite` (internal consumer) | Oxy | OxyHQServices `packages/api/src/config/email.config.ts:100` | exists |
| `Publisher` descriptor | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| `Model` descriptor, canonical id `<publisher>/<model>` | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| `ModelRevision` (immutable), id `<publisher>/<model>@<revision>` | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| `InferenceProvider` identity | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| `Deployment` / endpoint identity and region | Relay (health/availability); Oxy (customer-safe projection) | OxyHQ/Relay + OxyHQServices | planned |
| `RoutingProfile` (`auto`, `fast`, `quality`, customer-defined) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Capability fields (tools, vision, audio, structured output, reasoning, context, max output, caching, modalities) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Publisher and model licence | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Provenance / base model | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Knowledge cutoff and release date | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Regions and deployment providers | Relay (truth); Oxy (projection) | OxyHQ/Relay + OxyHQServices | planned |
| Data-retention and training-on-customer-data policy | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Zero-data-retention availability | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Customer pricing by unit and price version | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Deprecation status and replacement pointer | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Model card, evaluation summary, safety metadata | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Upstream provider secrets, internal route ids, wholesale cost | Relay — **never exposed** to customers (ADR 0006) | OxyHQ/Relay | planned |
| `alia/*` namespace, reserved for real Alia-owned releases | Alia (publisher), Oxy (registry) | OxyHQServices `packages/api/src/db/schema` | planned |

## 6. Routing policy (epic §6)

**Re-verified 2026-08-16 (#1018)**, by reading `inferenceCatalogue.service.ts`
and `inferenceEdge.service.ts` rather than by inference from the schema. The
correction this section needed: the request envelope carries a policy
**reference** (`{routingPolicyId, policyVersion}`), never the resolved values, so
a row reading "Oxy (policy), Relay (execution)" was a promise the data plane had
no way to keep. Since #1012, ROUTE SELECTION IS COMPLETE BEFORE THE ENVELOPE IS
BUILT: the control plane filters candidates against every control expressible as
a predicate over one candidate and refuses with `policy_violation` when none
qualifies. What is left to the data plane is ranking among routes that already
qualify, and failover within destinations the policy authorized.

Every control of `routingPolicySchema` is either enforced by
`violatedConstraints` or named with its reason in `UNFILTERED_ROUTING_CONTROLS`;
a control in neither list fails `tsc`, so this table cannot silently fall behind
the contract.

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Per-application default model or routing profile | Oxy (policy + resolution) | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts` | exists |
| Provider allowlist / denylist | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Region / data-residency constraints | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Zero-retention requirement | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Prohibit-training-on-customer-data constraint | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Maximum customer price per unit/request — stored, versioned, pinned on the receipt, enforced by NEITHER side (named inert in `UNFILTERED_ROUTING_CONTROLS`, issue #1011) | Oxy | OxyHQServices `packages/api/src/db/schema` | exists |
| Sort by price / latency / throughput / balanced — the one routing decision the data plane makes | Oxy (policy), Relay (execution) | OxyHQServices + OxyHQ/Relay | planned |
| Oxy-hosted-only option | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Licence / usage-right constraints | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` | exists |
| Fallback-disabled option | Oxy (policy + enforcement) | OxyHQServices `packages/api/src/services/inferenceRoutingPolicy.service.ts` | exists |
| Same-model deployment fallback option | Oxy (policy + authorization), Relay (execution) | OxyHQServices + OxyHQ/Relay | planned |
| Explicitly authorized cross-model fallback option | Oxy (policy + authorization), Relay (execution) | OxyHQServices + OxyHQ/Relay | planned |
| Dedicated endpoint / capacity for enterprise accounts | Oxy (entitlement + candidate filter), Relay (capacity) | OxyHQServices `packages/api/src/services/inferenceCatalogue.service.ts` + OxyHQ/Relay | planned |
| Routing-policy versioning; the request envelope and the receipt record a REFERENCE to the exact policy revision used, as provenance rather than as instructions | Oxy | OxyHQServices `packages/contracts/src/inference/routingPolicy.ts` (`routingPolicyReferenceSchema`) + `packages/api/src/db/schema` | exists |
| Customer-visible route-switch event/receipt | Oxy (emission to customer), Relay (source) | OxyHQServices + OxyHQ/Relay | planned |
| Contradictory-policy validation | Oxy | OxyHQServices `packages/contracts/src/inference/routingPolicy.ts` | exists |
| Circuit breakers, health scoring, provider failover execution | Relay | OxyHQ/Relay | planned |

## 7. Financial ledger and billing (epic §7, ADR 0009)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `user_credits` (balance keyed on `users.id`, `bigint` counts) | Oxy | OxyHQServices `packages/api/src/db/schema/userCredits.ts:58,65` | exists |
| `billing_transactions` (`amount_minor_units bigint`) | Oxy | OxyHQServices `packages/api/src/db/schema/billingTransactions.ts:154,179` | exists |
| `billing_subscriptions` (Stripe-written) | Oxy | OxyHQServices `packages/api/src/db/schema/billingSubscriptions.ts` | exists |
| `subscriptions` (legacy plan record, pre-Stripe) | Oxy | OxyHQServices `packages/api/src/db/schema/subscriptions.ts` | exists |
| `GET /credits`, `GET /credits/usage` | Oxy | OxyHQServices `packages/api/src/routes/credits.ts:56,85`, mounted `server.ts:648` | exists |
| Billing checkout / subscription / portal / transactions routes | Oxy | OxyHQServices `packages/api/src/routes/billing.ts:107-362`, mounted `server.ts:649` | exists |
| Stripe webhook endpoint | Oxy | OxyHQServices `packages/api/src/routes/billing.ts:362` | exists |
| Account (not user) as the billable principal | Oxy | OxyHQServices `packages/api/src/routes/accountBilling.ts`, mounted `server.ts` at `/billing/accounts` | exists |
| Billing profile for organization/project accounts | Oxy | OxyHQServices `packages/api/src/db/schema/billingProfiles.ts` + `services/accountBilling.service.ts` | exists |
| Child-project shared balance vs allocated budget decision | Oxy | OxyHQServices `docs/adr/0014-account-billing-and-entitlements.md` | exists |
| `price_versions` | Oxy | OxyHQServices `packages/api/src/db/schema/priceVersions.ts` | exists |
| `usage_reservations` | Oxy | OxyHQServices `packages/api/src/db/schema/usageReservations.ts` | exists |
| `usage_receipts` (immutable) | Oxy | OxyHQServices `packages/api/src/db/schema/usageReceipts.ts` | exists |
| `billing_ledger_entries` (double-entry or equivalently auditable) | Oxy | OxyHQServices `packages/api/src/db/schema/billingLedgerEntries.ts` | exists |
| Account balance projections / read models | Oxy | OxyHQServices `packages/api/src/db/schema/accountBalances.ts` | exists |
| Spending-limit / budget tables (account, project, application, credential) | Oxy | OxyHQServices `packages/api/src/db/schema/spendingLimits.ts` | exists |
| Invoice aggregation references | Oxy | OxyHQServices `packages/api/src/db/schema/billingInvoices.ts` + `services/accountInvoicing.service.ts` | exists |
| Prepaid balance, promotional grants, auto-recharge | Oxy | OxyHQServices `packages/api/src/services/accountBilling.service.ts`, `db/schema/billingAutoRechargeAttempts.ts` | exists |
| Invoiced enterprise accounts and credit limits | Oxy | OxyHQServices `packages/api/src/services/accountInvoicing.service.ts` | exists |
| Alert thresholds, hard-stop / soft-stop behaviour | Oxy | OxyHQServices `packages/api/src/services/spendingLimit.service.ts`, read surface `routes/accountBilling.ts` | exists |
| Reserve → settle → refund protocol | Oxy | OxyHQServices `packages/api/src/services/inferenceLedger.service.ts` | exists |
| Idempotency by stable request/event id | Oxy | OxyHQServices `packages/api/src/services/inferenceLedger.service.ts` | exists |
| Estimation/reconciliation when a provider omits usage | Oxy (settlement), Relay (measurement) | OxyHQServices + OxyHQ/Relay | planned |
| **What a metered unit MEANS** — the unit set partitions a request, so `cached_input_tokens` and `reasoning_tokens` are siblings of their parents and not details inside them. Oxy owns the definition because settlement prices every unit and sums; Relay owns the subtraction that turns a provider's nested counts into it. Re-verified 2026-08-16 (#1017) | Oxy (definition), Relay (normalisation) | OxyHQServices `packages/contracts/src/inference/money.ts` (`USAGE_UNITS`) + OxyHQ/Relay | exists |
| Stripe as payment/invoicing processor only | Stripe (external) | — | exists |
| `billing_external_payments` (the ONE ledger↔processor join) | Oxy | OxyHQServices `packages/api/src/db/schema/billingExternalPayments.ts` | exists |
| Ledger ↔ Stripe reconciliation + discrepancy report | Oxy | OxyHQServices `packages/api/src/services/billingReconciliation.service.ts`, `db/schema/billingReconciliation.ts` | exists |
| Account-scoped checkout and portal migration | Oxy | OxyHQServices `packages/api/src/services/stripeAccountBilling.service.ts` | exists (unverified against a live Stripe account) |
| Webhook idempotency audit for account billing | Oxy | OxyHQServices `packages/api/src/routes/billing.ts` + `services/__tests__/stripeAccountBilling.service.test.ts` | exists |
| Safe deletion of an account with live subscriptions or retained financial history | Oxy | OxyHQServices `packages/api/src/services/accountFinancialHolds.service.ts`, used by `routes/users.ts` | exists |
| Entitlement interface consumed by Alia product plans | Oxy | OxyHQServices `packages/api/src/services/entitlement.service.ts`, `GET /billing/accounts/:accountId/entitlements` | exists |
| Internal cost-center attribution (Alia, Codea, research, voice, evaluations) | Oxy | OxyHQServices `packages/api/src/db/schema/internalCostCenters.ts` + `routes/costCenters.ts` | exists (table empty; the five centres are workstream 14's to register) |
| Upstream provider cost measurement and reconciliation | Relay | OxyHQ/Relay | planned |
| Relay balance, quota counter or customer-visible credit | **forbidden** (ADR 0005 invariant 4) | — | must never exist |

## 8. Usage telemetry and reporting (epic §8)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `api_key_usage_events` (append-only, 90-day retention) | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:61`, retention `:54` | exists |
| `credits_used double precision` (telemetry only, never the ledger) | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:95` | exists |
| `user_id` attribution | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:83` | exists |
| `application_id` attribution | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:87` | exists |
| `api_key_id` → `developer_api_keys` reference (obsolete) | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:75` | exists |
| `account_id` column | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned |
| `application_credential_id` attribution (replacing `api_key_id`) | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned |
| `request_id`, optional `generation_id` | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts` | planned |
| Endpoint, status, latency columns | Oxy | OxyHQServices `packages/api/src/db/schema/apiKeyUsageEvents.ts:89-97` | exists |
| Normalized unit totals (tokens/time/images, separate from money) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Requested model, resolved model revision, customer-safe serving provider/deployment | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Upstream wholesale cost kept out of customer responses | Relay | OxyHQ/Relay | planned |
| Telemetry retention separated from financial receipt retention | Oxy | OxyHQServices `packages/api/src/db/expiry.ts` | planned |
| Aggregates by account, project, application, credential, model, provider, status, day | Oxy | OxyHQServices `packages/api/src` | planned |
| Customer-visible usage with documented eventual consistency | Oxy | OxyHQServices `packages/console` | planned |
| Exact billed amount sourced from the ledger, not telemetry | Oxy | OxyHQServices `packages/api/src` | planned |
| Enterprise reconciliation exports | Oxy | OxyHQServices `packages/api/src` | planned |
| Spend/token spike anomaly detection | Oxy | OxyHQServices `packages/api/src` | planned |
| `GET /applications/:appId/usage` | Oxy | OxyHQServices `packages/api/src/routes/applications.ts:1139` | exists |

## 9. Oxy Console (epic §9)

There is **no second customer-facing console**; a Relay dashboard is forbidden by
ADR 0005 invariant 5.

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Account switcher and account-derived access | Oxy | OxyHQServices `packages/console/src/hooks/use-account.tsx:138,178` | exists |
| Applications list and detail | Oxy | OxyHQServices `packages/console/src/routes/_layout/apps/` | exists |
| Per-app General | Oxy | OxyHQServices `packages/console/src/components/apps/general-section.tsx` | exists |
| Per-app Credentials | Oxy | OxyHQServices `packages/console/src/components/apps/credentials-section.tsx` | exists |
| Per-app Usage | Oxy | OxyHQServices `packages/console/src/components/apps/usage-section.tsx` | exists |
| Per-app Store / Updates | Oxy | OxyHQServices `packages/console/src/components/apps/store-section.tsx`, `updates-section.tsx` | exists |
| Models page (static catalogue today) | Oxy | OxyHQServices `packages/console/src/routes/_layout/models.tsx` | exists |
| Playground (posts to `/v1/chat/completions`) | Oxy | OxyHQServices `packages/console/src/routes/_layout/playground.tsx:148` | exists |
| Usage page | Oxy | OxyHQServices `packages/console/src/routes/_layout/usage.tsx` | exists |
| Billing page | Oxy | OxyHQServices `packages/console/src/routes/_layout/billing.tsx` | exists |
| Account settings page | Oxy | OxyHQServices `packages/console/src/routes/_layout/settings/account.tsx` | exists |
| Documentation and SDK pages | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/` | exists |
| Members / account-settings management surface | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Inference overview | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Usage and spend | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Routing policy | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Provider connections / BYOK | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Limits and budgets | Oxy | OxyHQServices `packages/console` | planned |
| Per-app Webhooks / audit events | Oxy | OxyHQServices `packages/console` | planned |
| Per-app environment-specific configuration | Oxy | OxyHQServices `packages/console` | planned |
| Real model catalogue rendering (ids, publishers, revisions, capabilities, regions, providers, data policy, prices) | Oxy | OxyHQServices `packages/console` | planned |
| Routing profiles rendered separately from models | Oxy | OxyHQServices `packages/console` | planned |
| Catalogue filters (modality, tools, region, provider, price, data policy) | Oxy | OxyHQServices `packages/console` | planned |
| Playground bound to active account/application and selected credential/environment | Oxy | OxyHQServices `packages/console` | planned |
| Post-run detail: request id, model revision, provider route, latency, units, billed amount | Oxy | OxyHQServices `packages/console` | planned |
| Balance split: purchased / promotional / reserved | Oxy | OxyHQServices `packages/console` | planned |
| Pending reservations and settled charges | Oxy | OxyHQServices `packages/console` | planned |
| Spend by application / model / provider / time | Oxy | OxyHQServices `packages/console` | planned |
| Budget creation and alerts | Oxy | OxyHQServices `packages/console` | planned |
| Server-provided permission gating (no client role re-derivation) | Oxy | OxyHQServices `packages/console` | planned |
| Relay customer console | **forbidden** (ADR 0005 invariant 5) | — | must never exist |

## 10. BYOK provider connections (epic §10)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Provider connection metadata (provider, owner account, application scope, environment, status) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Provider secret material in Vault/KMS/managed secret storage | Vault/KMS (Oxy-managed) | oxy-infra | planned |
| Secret *reference* stored in Postgres | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Environment/account encryption separation | Oxy | OxyHQServices `packages/api/src` | planned |
| Safe prefixes / fingerprints / validation status in responses | Oxy | OxyHQServices `packages/api/src` | planned |
| Credential validation via a dedicated provider check (never logged) | Relay | OxyHQ/Relay | planned |
| Rotation, replacement, immediate disable | Oxy | OxyHQServices `packages/api/src` | planned |
| Audit log: create, validate, rotate, use, revoke | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Connection scope decision (account-wide / project-wide / application-only) | Oxy | OxyHQServices `docs/` | planned |
| Routing policy "prefer/require BYOK" | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| BYOK usage still produces Oxy usage receipts and platform-fee charges | Oxy | OxyHQServices `packages/api/src` | planned |
| Provider-terms acknowledgement record | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| BYOK secret in an application table | **forbidden** (ADR 0005 invariant 12) | — | must never exist |

## 11. Commercial permissions (epic §11)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `availabilityScope` (`internal_alia`, `public_payg`, `enterprise`, `byok_only`, `oxy_hosted`) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| `commercialPermission` (`standard_application_use`, `public_resale_approved`, `wholesale_contract`, `customer_byok`, `open_weight_hosting`) | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Public catalogue/routing block unless permission approved | Oxy | OxyHQServices `packages/api/src` | planned |
| Contract/legal review status and evidence reference | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Open-weight licence, attribution, acceptable-use requirements | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Base-model attribution requirement for derived names | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| "Available to Alia internally" vs "available to external customers" separation | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Admin workflow: approve, restrict, suspend, retire a route | Oxy | OxyHQServices `packages/console` + `packages/api/src` | planned |

## 12. Privacy, security, compliance (epic §12)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| No-user-IPs-at-rest invariant (platform-wide) | Oxy | OxyHQServices `packages/api/src/db/schema/securityActivities.ts:6-19`, `packages/api/src/utils/ipKey.ts` | exists |
| `security_activities` (account's own audit trail) | Oxy | OxyHQServices `packages/api/src/db/schema/securityActivities.ts` | exists |
| No prompt/response persistence by default | Oxy + Relay | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md`, `scripts/check-no-payload-persistence.mjs` + OxyHQ/Relay | exists for Oxy — no column in the schema can hold a prompt, a completion, a chat message body or a tool argument, enforced by a census over the drizzle barrel in the `Schema Payload Policy` CI job; `planned` for Relay, which does not exist |
| Opt-in, time-limited, encrypted, audited debug payload retention | Oxy | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md` | refused, not planned — ADR 0016 makes the four properties PRECONDITIONS on building capture rather than follow-up work, and precondition 3 (a key Oxy does not hold in PostgreSQL) needs the same absent managed-secret backend as ADR 0013 |
| PII/redaction controls for opted-in traces | Oxy | OxyHQServices `docs/adr/0016-no-inference-payload-persistence.md` | blocked on the row above, and vacuous until then — no trace or span infrastructure exists in this repository, so there is nothing to redact PII from |
| Deployment policy fields (retention, training, region, subprocessors, ZDR) | Oxy (catalogue), Relay (truth) | OxyHQServices + OxyHQ/Relay | planned |
| Deletion/export preserving legally required financial records | Oxy | OxyHQServices `packages/api/src` | planned |
| Secret-scanning and accidental-serialization tests | Oxy | OxyHQServices `scripts/check-secret-scan.mjs` (scanning), `packages/api/src/services/__tests__/inferenceProviderConnection.service.test.ts` (serialization) | exists — twelve issued-token grammars plus a tracked-dotenv refusal over every tracked file, in the `Secret Scan` CI job, each rule verified against its own sample on every run; the serialization half walks a returned DTO to every leaf, its `JSON.stringify`, its exact key set, every stored column and the audit trail, with a positive control proving the credential really passed through |
| Rotation runbooks and break-glass procedures | Oxy (credentials Oxy issues), infra (AWS) | OxyHQServices `docs/runbooks/` + oxy-infra `docs/runbooks/` | exists for the five credential classes Oxy issues — application credential, `oxy_sk_…` machine key, BYOK provider connection, the token signing keys, and the Oxy→Relay edge signing key (that one written against ADR 0015 and pending it); `planned` for the AWS half, which is oxy-infra's and is deliberately not duplicated here |
| Immutable audit events for credential, billing, routing, provider-connection changes | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Staff vs customer action distinction in audit | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Least-privilege admin roles | Oxy | OxyHQServices `packages/api/src` | planned |
| Rate limits and fraud controls before prepaid public inference | Oxy | OxyHQServices `packages/api/src/middleware/rateLimiter.ts` (factory exists; inference limiters planned) | planned |
| Privacy/security review gate for public launch | Oxy | OxyHQServices `docs/` | planned |
| Signed Alia model release manifest ingestion contract | Oxy (ingest), Alia (issuer) | OxyHQServices `packages/api/src` | planned |
| Model card, licence, provenance, evaluation, safety results, artifact digests | Alia (produces), Oxy (stores/publishes) | OxyHQServices `packages/api/src/db/schema` | planned |
| EU AI Act / GPAI documentation metadata | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Content-provenance / marking metadata | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |

## 13. Relay data plane (epic §13 — external dependency)

The repository does not exist (verified 2026-08-15). Every row is `planned`, and
none of workstreams 0–12 may block on it.

| Item | Owner | Repo | Status |
|---|---|---|---|
| Relay repository and ownership model | Relay | OxyHQ/Relay | planned |
| High-concurrency streaming data plane | Relay | OxyHQ/Relay | planned |
| Provider adapter interface (translation, streaming, cancellation, usage normalization, errors, health) | Relay | OxyHQ/Relay | planned |
| Provider adapters migrated out of Alia | Relay | OxyHQ/Relay | planned |
| Same-model deployment fallback, circuit breakers, health scoring | Relay | OxyHQ/Relay | planned |
| Cross-model fallback, only when Oxy policy allows | Relay | OxyHQ/Relay | planned |
| Configuration snapshots for control-plane outage | Relay | OxyHQ/Relay | planned |
| Technical usage receipts with stable request/event ids | Relay | OxyHQ/Relay | planned |
| Provider-cost measurement and reconciliation | Relay | OxyHQ/Relay | planned |
| Oxy-hosted deployments on established runtimes (vLLM/SGLang) | Relay | OxyHQ/Relay | planned |
| Orchestration (e.g. KServe), only when scale justifies it | Relay | OxyHQ/Relay | planned |
| Internal health/status exposure to Oxy (no secrets, no unsafe route detail) | Relay | OxyHQ/Relay | planned |
| Per-provider conformance tests before public availability | Relay | OxyHQ/Relay | planned |

## 14. Alia integration (epic §14)

| Item | Owner | Repo | Status |
|---|---|---|---|
| Alia registered as an Oxy first-party/internal Application under the correct account | Oxy (registry), Alia (consumer) | production registry | unverified — settled by reading the production `applications` row, not the repo |
| Separate development / staging / production credentials for Alia | Oxy | production registry | unverified — settled by reading production `application_credentials` rows |
| Inference scopes granted to Alia | Oxy | OxyHQServices `packages/api/src/utils/applicationScopes.ts` | planned |
| Alia delegating an end-user id while billing the Alia account/cost center | Oxy | OxyHQServices `packages/api/src` | planned |
| Internal cost centers: Alia production chat, Codea, research, voice, evaluations | Oxy | OxyHQServices `packages/api/src/db/schema` | planned |
| Entitlement/billing API consumed by Alia product plans | Oxy | OxyHQServices `packages/api/src` | planned |
| Removal of the static Oxy→Alia infrastructure proxy | Oxy | OxyHQServices `packages/api/src/routes/alia.ts` | planned |
| Deprecation of Alia-owned developer keys, provider billing, generic `/v1` endpoints | Alia | Alia repo | planned |
| Alia assistant product, conversations, memory, agents, tools, approvals | Alia | Alia repo | exists (outside this repo) |

## 15. SDKs and documentation (epic §15)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| `@oxyhq/core` client SDK | Oxy | OxyHQServices `packages/core` | exists |
| Typed inference methods on `@oxyhq/core` | Oxy | OxyHQServices `packages/core/src/inference/OxyInferenceClient.ts` | exists — catalogue reads, `respond()` and `getGeneration()`. No `stream()`: the edge refuses `stream: true`, so a method that could only fail would be a worse artefact than an absent one |
| Machine-credential lifetime and rotation-grace options on the SDK | Oxy | OxyHQServices `packages/core/src/mixins/OxyServices.accounts.ts` | exists — `createAppCredential({expiresInSeconds})` and `rotateAppCredential(…, {graceSeconds})`; the API accepted both since epic §2.3, the SDK could not send either |
| TypeScript SDK surface accepting both Oxy auth and OpenAI-style keys | Oxy | OxyHQServices `packages/core/src/inference/OxyInferenceClient.ts`, `packages/core/src/mixins/OxyServices.inference.ts` | exists — one client, one `credential` that is a static `oxy_sk_*` string or a function returning an Oxy bearer. `oxyServices.inference()` binds the session lane; the mixin declares no request of its own, so there is one spelling of each call. `packages/api/src/schemas/__tests__/sdkRequestCompatibility.test.ts` fails the build if the request type and the edge schema drift |
| Python SDK or generated client | Oxy | new repo | planned, and deliberately NOT started — the epic §4 contract has not stabilised: no endpoint serves a request, streaming has no wire format at the edge, and the catalogue that decides what `model` may say is empty. Reasoning in `docs/inference/sdk.md` |
| `docs/SERVICE_TOKENS.md` (native service-token flow) | Oxy | OxyHQServices `docs/SERVICE_TOKENS.md` | exists |
| Console authentication page (documents `oxy_dk_*` as the public client id, and names the two mechanisms that do authenticate) | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/authentication.tsx` | exists — corrected in epic §2.1; the bearer-secret framing it used to carry is gone |
| Console quickstart / chat-completions / SDK pages | Oxy | OxyHQServices `packages/console/src/routes/_layout/documentation/` | exists |
| Static machine API-key flow documentation | Oxy | OxyHQServices `docs/inference/credentials.md` | exists — creation, one-time token display, environments, opt-in rotation grace, revocation, audit and limits, and that **no endpoint accepts one yet** (epic §4 mounts it) |
| A bare `oxy_dk_*` is refused on every lane requiring a secret or a bearer | Oxy | OxyHQServices `packages/api/src/routes/__tests__/publicIdentifierNotASecret.test.ts`, `packages/api/src/middleware/__tests__/publicIdentifierNotABearer.test.ts` | exists — 4 lanes, each rejection paired with a positive control |
| Native service-token flow, as one of the three credential lanes | Oxy | OxyHQServices `docs/inference/credentials.md` | exists — frames the lane and defers to `docs/SERVICE_TOKENS.md`, which stays authoritative for the claim set (epic §2.2) |
| Attribution documentation (account/application/credential) | Oxy | OxyHQServices `docs/inference/attribution.md` | exists |
| Streaming, cancellation, retry documentation | Oxy | OxyHQServices `docs/inference/streaming.md` | exists — the CONTRACT for all three, plus which parts cannot be observed. No endpoint streams; an abandoned request today answers `service_unavailable` rather than `cancelled`, because the no-data-plane classification is checked first. Retries and idempotency ARE live and are documented as such |
| Model vs deployment vs routing profile documentation | Oxy | OxyHQServices `docs/inference/catalogue.md` | exists |
| Routing controls and fallback semantics documentation | Oxy | OxyHQServices `docs/inference/routing.md` | exists — every control, with an explicit split between the eleven filtered against the candidate routes since [#1012](https://github.com/OxyHQ/oxy/pull/1012) (and the `policy_violation` refusal when none qualifies), the fallback authorisation, and the three that are not enforced — the two price ceilings, which need a different mechanism, and `optimiseFor`, which is a ranking the data plane owns |
| Exact billing / reservations / usage-dashboard documentation | Oxy | OxyHQServices `docs/inference/billing.md` | exists — including why dashboard usage is eventually consistent while the billed amount comes from the ledger, and the `/inference/reporting` surface |
| BYOK behaviour and limits documentation | Oxy | OxyHQServices `docs/inference/byok.md` | exists — the metadata Oxy holds, the endpoints that work, the `503 provider_secret_store_unavailable` on create/rotate, why the refusal beats a Postgres column, and the three things that would wire a store |
| Data retention and regional policy documentation | Oxy | OxyHQServices `docs/inference/data-policy.md` | exists — what Oxy retains and for how long (including that neither the 90-day telemetry sweep nor the reservation-expiry sweep is scheduled), the no-user-IP invariant, the per-route `dataPolicy` fields, and the residency/retention routing controls, which ARE enforced against the candidate routes since [#1012](https://github.com/OxyHQ/oxy/pull/1012) — subset-not-overlap for regions, actually-not-retaining for zero retention |
| Migration guides for `chat:completions`, `models:read`, `alia_sk_*`, `oxy_dk_*` | Oxy | OxyHQServices `docs/inference/migration.md` | exists — `alia_sk_*` established as an Alia-issued key with zero references in this repo, cited to the Alia repo; plus the Alia proxy's move from `/v1/chat/completions` to `/alia/chat/completions` |
| Status board naming what is NOT built and what tracks it | Oxy | OxyHQServices `docs/inference/README.md` | exists |
| Published deprecation and sunset dates | Oxy | OxyHQServices `docs/inference/deprecation.md` | policy written, no date published, and none invented. Notice windows are relative to events rather than calendar dates, and are PROPOSED pending the owner's confirmation. Nothing an external developer can reach has been deprecated; the things retired so far did nothing, and each is recorded with why no notice was owed |

## 16. Testing, observability, rollout (epic §16)

| Item | Owner | Repo / path | Status |
|---|---|---|---|
| Oxy↔Relay schema compatibility tests | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| Attribution tests (account/application/credential) | Oxy | OxyHQServices `packages/api` | planned |
| Scope and RBAC tests | Oxy | OxyHQServices `packages/api` | planned |
| Credential create/rotate/revoke/expiry tests | Oxy | OxyHQServices `packages/api/src/routes/__tests__/applications.test.ts` (credential coverage exists; inference cases planned) | planned |
| Reservation/settlement/refund/idempotency tests | Oxy | OxyHQServices `packages/api` | planned |
| Price-version snapshot tests | Oxy | OxyHQServices `packages/api` | planned |
| Cross-account isolation tests | Oxy | OxyHQServices `packages/api` | planned |
| Commercial-permission route filtering tests | Oxy | OxyHQServices `packages/api` | planned |
| Retention-policy filtering tests | Oxy | OxyHQServices `packages/api` | planned |
| E2E: non-streaming, SSE streaming, disconnect-cancels, same-model failover, forbidden cross-model fallback | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| E2E: Alia service token with delegated user, external machine key, BYOK route | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| E2E: insufficient balance, partial stream settlement, retry with no duplicate charge, rotation during traffic | Oxy | OxyHQServices `packages/api` | planned |
| `requestId` correlation across edge, Relay, ledger and receipt | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| Metrics: request rate, error rate, TTFT, total latency, cancellation, fallback | Oxy + Relay | OxyHQServices + OxyHQ/Relay | planned |
| Metrics: reserve failures, settlement lag, reconciliation drift | Oxy | OxyHQServices | planned |
| Alerts: ledger imbalance, duplicate event ids, provider error/cost spikes | Oxy | OxyHQServices + oxy-infra | planned |
| Audit dashboards for credential and billing changes | Oxy | OxyHQServices `packages/console` | planned |
| Status-page signals from customer-safe model/deployment availability | Oxy (surface), Relay (source) | OxyHQServices + OxyHQ/Relay | planned |
| Feature flags for new auth, API edge, ledger, catalogue | Oxy | OxyHQServices `packages/api/src/config/rolloutFlags.ts` | exists |
| Rollout-flag readout (`GET /inference/admin/rollout`) | Oxy | OxyHQServices `packages/api/src/routes/inferenceAdmin.ts` | exists |
| Shadow technical metering before charging | Oxy | OxyHQServices `packages/api/src/services/inferenceEdge.service.ts` | exists |
| Bounded dual-read/dual-write migration window | Oxy | OxyHQServices `docs/inference/rollout.md` | not applicable — every table is new and holds no production rows, so there is no store to cut over from |
| Canaries: internal Alia, Oxy first-party, closed external beta | Oxy | OxyHQServices `packages/api/src/config/rolloutFlags.ts` | mechanism exists, no stage entered |
| Rollback plan preserving financial-event integrity | Oxy | OxyHQServices `docs/inference/rollout.md` | exists |

---

## Maintaining this matrix

- **An item in neither this matrix nor a stated not-applicable line FAILS the
  review.** A gate that silently skips what is missing from a hand-maintained map
  is not a gate; being absent from both lists is not permission to place a fact
  wherever is convenient.
- **`exists` is a claim about a path, and it is re-verified when the path
  changes.** A row whose path no longer resolves is a defect in this file, not a
  detail.
- **`unverified` must name what would settle it**, and must not be used where the
  repo can answer the question.
- **New tables, events and API surfaces are added here in the same PR that adds
  them**, with their owner, not afterwards.
