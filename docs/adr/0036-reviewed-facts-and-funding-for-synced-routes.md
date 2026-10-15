# ADR 0036 — Reviewed facts and Kaana-reported funding for synced routes

- Status: accepted; decision 4 superseded by [ADR 0038](0038-kaana-owns-provider-keys-costs-and-routing.md)
  (a provider's funding is the best available tier among all its keys)
- Date: 2026-10-11
- Changes: ADR 0027 decision 5 (where a synced route's price comes from) and
  its unstated default that every synced scorecard is `standard_payg`.

## Context

Kaana now serves Anthropic directly (OxyHQ/Kaana#166): provider slug
`anthropic`, deployments `dep_anthropic_*` attributed to the same
`anthropic/claude-*` lines OpenRouter serves, plus `anthropic/claude-haiku-5.5`.
Three gaps kept Oxy from routing to them:

1. Oxy held no `anthropic` data-policy row, so the sync skipped every route
   (`unknown_provider`).
2. ADR 0027 prices a synced route only from Kaana's per-deployment `listPrices`.
   Kaana reads a list price only from a provider's own model list, and
   Anthropic's Models API publishes none. Kaana also names a deployment to the
   catalogue only through its `listPrices` row, so an unpriced deployment was
   invisible to the sync.
3. Kaana publishes no accepted request parameters for these deployments either,
   while its Messages adapter refuses penalties, `seed` and a JSON response
   format, and Anthropic answers a non-default `temperature`/`top_p` (Claude
   4.7 and later) and a forced `tool_choice` (Fable 5.1, Opus 5.5, Sonnet 5.5)
   with a 400. Kaana treats both kinds of refusal as terminal, so a request
   signed onto such a route first never reaches the next one.

And the key funding the direct route is a monthly promotional credit grant
(Kaana credential metadata `capacityCategory: promotional`), which the funding
order (`routing.md`, "Funding class") ranks before standard paid usage — but the
sync wrote every scorecard as `standard_payg`.

## Decision

1. **Provider data-policy rows ship as migrations.** `anthropic` is inserted
   by migration 0153 with the facts of Anthropic's commercial API (30-day
   default retention, no training, zero data retention by separate
   arrangement), and the migration refuses to complete when the row present
   says anything else.
2. **A provider-published price outside the provider's model list is reviewed
   data in Oxy.** `config/kaanaReviewedProviderRoutes.ts` records, per exact
   `(provider, Kaana model line)`, the price read from the provider's pricing
   page (source and date), the upstream model id Kaana attributes to the line,
   and the accepted request controls stated by Kaana's adapter and the
   provider's documentation. The sync names those deployments from Kaana's
   signed serving snapshot (`{}` deployment query), attests them exactly like
   every other route, and writes the reviewed price into the same price
   versions. A Kaana-published list price always wins; a price is never
   borrowed from another provider of the same line.
3. **Reviewed accepted controls are intersected with Kaana's.** A route's
   stored `accepted_parameters` is the intersection of the reviewed statement
   and Kaana's per-deployment statement (an unknown statement abstains), so the
   edge's existing filter keeps such requests on another deployment of the
   line.
4. **Funding class comes from Kaana's credential economics.** Each sync reads
   the signed `POST /internal/v1/provider-telemetry/credentials`. A provider
   with exactly one enabled key described as `promotional` funds its synced
   routes as `promotional_credit`, observed at the read and valid for six
   hours; capacity evidence saying the grant is spent records `exhausted`.
   Several keys, an undescribed key, any other category and a failed read are
   unknown and keep `standard_payg`.

## Alternatives rejected

**Inherit OpenRouter's list price for the direct route.** It is another
provider's price for another contract; equal today, it can diverge silently.

**Price from Kaana's rate card.** A rate card is what the upstream invoices
Kaana, keyed by a deployment id that exists only after the publisher has
observed it, and no operator read exposes it as a price. The customer price is
Oxy's (ADR 0006).

**Drop direct routes by provider name when a request carries a sampling
control.** A provider allow-list in route selection; the stored per-deployment
set already expresses this through the existing filter.

## Consequences

- Kaana should publish the Anthropic adapter's accepted controls (and the
  model-level refusals) per deployment, as it does for OpenRouter; Oxy then
  intersects both statements and the reviewed one becomes redundant.
- The accepted-parameter vocabulary is presence-only, so a non-forcing
  `toolChoice` (`auto`) for Fable 5.1, Opus 5.5 or Sonnet 5.5 is also served by
  OpenRouter until the vocabulary distinguishes a forced choice.
  *Update 2026-10-12:* it now does (OxyHQ/Kaana#168, migration 0154):
  `toolChoice.none` / `.required` / `.function`, with `auto` needing nothing,
  so those routes serve `auto` and `none` and refuse only a forced choice.
  Kaana also publishes the adapter's per-model controls for Anthropic
  deployments, and the reviewed statement here agrees with it.
- Claude Haiku 5.5 is priced at its over-100,000-token tier, because a price
  version states one rate per unit. It stays unsynced until its modalities are
  published (`missing_modalities`): Anthropic's Models API carries none and no
  other provider serves the line. *Update 2026-10-12:* Kaana now reads them
  from Anthropic's `capabilities.image_input`/`pdf_input` (OxyHQ/Kaana#168), so
  Haiku 5.5 and the Fable lines sync on the first cycle after that deploy.
- A reviewed price has no expiry; a change on the provider's pricing page needs
  a reviewed edit here, which supersedes the active price version on the next
  sync.
