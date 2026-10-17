# 0046 — Oxy One catalogue and shared credits

Status: product direction accepted by Nate on 2026-10-17; commercial rollout pending.

## Decision

The `/one` catalogue in the Website repository supplies Oxy One's personal,
family, creator and business plans, including monthly/annual prices, monthly
allowances, storage and product tier mappings. The shared display definitions
now live in `@oxy.so/contracts` (`products/one.ts`). Money remains integer USD
minor units. Family allowances are shared, not multiplied by member count;
business includes a base plus per-seat terms. Annual quotes round each billable
line before totaling it, matching Website.

The included product set covers Alia, Mention, Inbox, Noted, Clarity, Homiio,
Schedio and Mercaria according to the audience/tier mappings. Each product keeps
its own tier names and enforces actual capabilities on its server. A label or
client-side selection never grants access.

Nate explicitly confirmed that Oxy One credits must serve both Alia and the Oxy
API. This supersedes ADR 0033's product decision excluding API credits. It does
not authorize two independent balances for the same allowance: fulfillment,
consumption, replay, refund and expiry must conserve one shared allowance. The
existing API exclusion remains a runtime safety boundary until that atomic
cross-product path is implemented and validated.

## Current implementation and remaining work

Bloom's neutral `SubscriptionPlans` supplies presentation; the SDK's `OxyOne`
route supplies Oxy content and navigation. Catalogue preview is available now.
The purchase action is disabled, as requested for preview, and no existing
subscription or allowance is changed.

Commercial activation is not complete. The existing Peable adapter and signed
invoice validation are pinned to the old 29.99 USD monthly offer and deliberately
refuse production purchases. They need the expanded versioned mappings, shared
credit accounting, supported annual/family/business lifecycle semantics and
verified fiscal configuration. See `docs/products/oxy-one-launch-readiness.md`.
Existing product integrations cannot be assumed to support all new tier mappings:
Alia's adapter currently selects one configured plan; Mention uses its specific
mono capability; Noted uses shared storage. Inbox/Schedio/Clarity/Homiio/Mercaria
need their corresponding product mappings and capability enforcement verified.
No new app entitlements, live prices, subscriptions, migrations or deployments
were activated by the preview work.
