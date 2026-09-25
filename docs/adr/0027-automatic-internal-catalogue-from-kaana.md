# ADR 0027 — Official Oxy products see every model Kaana serves, synced and approved automatically

- Status: accepted
- Date: 2026-09-25
- Decided by: the owner (product direction), recorded here
- Changes: ADR 0008's consequence that the catalogue is populated by reviewed
  bootstrap rows; ADR 0010's edge step 5 for a policy-less official
  application. ADR 0005 invariant 8 (internal availability never implies public
  resale) is kept, and this ADR is built on it.

## Context

Kaana discovers hundreds of real models across its providers, OpenRouter-style.
Until now Oxy's catalogue held exactly the rows a reviewed bootstrap wrote by
hand — one text model and one speech route — and Alia reached them through
eight hand-named routing profiles (`kaana-lite` … `kaana-v1-pro-max`). Every
new model therefore needed a code change, a primary-source review, a plan hash
and a production workflow before an Oxy product could offer it. That is the
right process for PUBLIC resale, where Oxy asserts it may sell somebody else's
model. It is the wrong one for Oxy's own products consuming a provider under the
provider's ordinary terms, and in practice it meant Alia offered users one model
while Kaana could serve hundreds.

The owner's direction: Alia (and every official product) lists ALL models Kaana
discovers and sends a model id plus a reasoning effort. Nothing hardcoded or
hand-curated.

## Decision

1. **The catalogue for `platform_internal` is synced from Kaana.** A scheduled
   job (`services/kaanaCatalogueSync.service.ts`, every 30 minutes, one run
   fleet-wide under an advisory lock, plus `POST
   /inference/admin/catalogue/sync`) reads Kaana's signed
   `GET /internal/v1/models`, resolves every priced deployment through the
   signed `POST /internal/v1/deployments/query`, and writes models, revisions,
   deployments, price versions and routing scorecards.
2. **Bulk approval by a policy record, not per route.** Every synced deployment
   is `platform_internal` / `standard_application_use`, `approved`, and points
   at the `kaana-sync` row of `inference_catalogue_auto_approval_policies`. That
   table's CHECK allows only that scope and permission, so no automatic approval
   can reach `public_payg`, `enterprise` or `byok_only`: public resale keeps its
   reviewed process unchanged. `enabled = false` on the policy stops the sync.
3. **An emergency blocklist**, `inference_catalogue_blocklist`, empty by
   default. Blocking a model line retires its synced routes in the same commit;
   the sync never writes it again until the block is lifted.
4. **Retired upstream means gone.** A synced deployment Kaana stops reporting is
   retired on the next run. A report that would retire more than half of the
   synced routes at once is presumed broken and withheld unless an operator
   confirms it.
5. **Price from the provider's list price.** Each route gets a USD price version
   from Kaana's per-deployment `listPrices` (input and output per million
   tokens; cached input at the input rate, reasoning at the output rate,
   `requests` at zero). A changed list price supersedes the version; it never
   edits one. A route without a published price is not offered.
6. **Nothing required is invented.** A line without a context window, maximum
   output, modalities or a priced route is skipped and counted; a route on a
   provider with no Oxy data-policy row is skipped. Lines producing non-text
   output are skipped, because migration 0050 requires a reviewed provenance
   marking Kaana cannot supply.
7. **Reviewed rows stay reviewed.** Rows written by the bootstrap or staff
   (`catalogue_source = 'reviewed'`, `auto_approval_policy_id IS NULL`) are
   never rewritten by the sync, except for `reasoning_efforts`, which is a
   serving capability Kaana owns.
8. **Official applications can name a model without a policy.** An application
   in the `platform_internal` audience with no routing policy of its own is
   served under `platform-internal-default@1`: rank a model's routes by the
   `price` score, no failover. A third-party application without a policy is
   still refused.
9. **Reasoning effort is a catalogue capability.** `reasoningEfforts` is carried
   per model, and the edge refuses (400 `invalid_request`) an effort the
   resolved model does not list rather than forwarding it.

## The legal-review fields this auto-populates

`inference_models` and `inference_deployments` require licence, provenance and
legal-review columns. For synced rows they record the policy, not a review:

| Column | Synced value | Reading |
|---|---|---|
| `license_id` | `LicenseRef-Oxy-Serving-Provider-Terms` | governed by the serving provider's terms; weights' licence not reviewed |
| `commercial_use_allowed` | `false` | not asserted — `requireCommercialUseRights` excludes synced routes |
| `requires_attribution` | `true` | assumed until reviewed |
| `release_kind` | `third_party_hosted` | served by a third party; open weights not asserted |
| `legal_review_status` | `approved` | by `legal_review_evidence_ref = auto-approval-policy:kaana-sync`, reviewer NULL |
| `permission_state_note` | "Approved automatically by the kaana-sync policy …" | |
| scorecard latency/throughput/balanced | NULL score, source `reviewed_scorecard`/`cost_model`, evidence `not-measured:kaana-sync` | the source vocabulary has no "unmeasured" member; the evidence ref says so |

None of these values is presented to a customer as a review: the public
catalogue cannot see a synced route, and the internal catalogue entry shows the
`LicenseRef-` id verbatim.

## Alternatives rejected

**Keep per-route review for internal use.** It is what produced a one-model
Alia. The review answers "may Oxy resell this?", a question internal use under
the provider's own terms does not ask.

**A hand-maintained allowlist of model ids.** A second curated copy of Kaana's
inventory drifts in one direction — it keeps offering what was removed and
never offers what was added — which is exactly what Kaana's `/internal/v1/models`
was built to end.

**Invent conservative defaults for missing capabilities** (for example
`maxOutputTokens = contextTokens`). The edge sizes holds and signs
`maxOutputTokens` from these numbers; a guessed ceiling becomes an upstream
refusal or an unbounded hold. A skipped model is visible in the sync summary; a
wrong one is not.

## Consequences

- `scripts/bootstrap-kaana-catalogue.ts` is no longer the production catalogue
  writer. It remains the reviewed source for Inbox's `kaana-v1` profile and
  Alia's speech route and profile. The seven Alia text presets were removed
  from it; their existing rows are left in place (never deleted by this change,
  primary keys never reused) until Alia no longer references them.
- The number of models an official product sees is now bounded by what Kaana
  reports with a price and complete limits, and by which providers Oxy holds a
  data-policy row for. Adding a provider row is the one manual step left.
- The contract set is 3.1.0 (`reasoning`, `reasoningEfforts`, `releasedAt`).
