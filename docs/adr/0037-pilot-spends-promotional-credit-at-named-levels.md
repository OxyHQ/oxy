# ADR 0037 — The internal pilot spends promotional credit only at named Pro and Ultra

- Status: accepted
- Date: 2026-10-12
- Changes: the `alia-kaana` internal metered pilot
  (`config/inferenceEconomicPolicy.ts`, [internal-metering.md](../inference/internal-metering.md)),
  which until now admitted only its exact deployment tuples at a USD 0.05 quote
  ceiling. Builds on ADR 0036 decision 4 (funding class from Kaana's credential
  economics).

## Context

Alia's production traffic runs under the pilot. It admits four exact tuples
(GPT-OSS 120B on three providers, DeepSeek V4 Flash) and refuses any signed
route quoting above USD 0.05. So a request Alia makes at `pro` or `ultra` has
no admitted member at all — no reviewed Pro or Ultra model is in the list — and
is refused before any claim.

Since ADR 0036, Kaana serves Claude directly (`dep_anthropic_*`) on a key whose
monthly promotional grant funds it, and the sync writes those scorecards as
`promotional_credit` for six hours at a time, renewed every 30 minutes. The
same Claude lines are also served by OpenRouter as ordinary paid routes. The
owner's decision: Alia may use Claude for its top levels **only while the grant
pays for it**; once it is spent or its evidence is stale Alia must fall back to
its ordinary cheap routes, and never to paid Claude.

Two facts make the existing controls insufficient on their own:

- the funding order ranks promotional credit before standard paid inside a
  priority, so adding Claude to the exact list would also make a promotional
  Claude model of a cheap class (Haiku 4.5 is `medium`, Sonnet 5 is `high`) win
  `auto`'s everyday requests and spend the grant there;
- at the pilot's worst-case input bound a Claude quote is above USD 0.05
  (Opus at 126,976 input units and 2048 output: USD 0.686).

## Decision

1. **A pilot may declare a promotional-credit lane** (`pilot.promotionalCredit`):
   the levels it covers, a fallback level and its own USD quote ceiling.
   `alia-kaana` declares `levels: ['pro', 'ultra']`, `fallbackLevel: 'xhigh'`,
   `maxPricePerRequestUsd: '1.00'`. Policy version
   `oxy-inference-economics/2026-10-12.1`.
2. **Admission by the route's own evidence, at a named level only.** When a
   completion request NAMES a lane level, a route outside the exact tuples is
   admitted at that level if, and only if, its current scorecard resolves to
   `promotional_credit` that is `available` and inside its observation window at
   this request (`EdgeRoute.fundingPriority`, from `fundingPriorityFor`). No
   provider, model or deployment name participates. `auto`, the other levels,
   an exact model target, a scoped permit and Private Auto never use the lane.
3. **Paid Claude is never admitted.** OpenRouter's Claude routes are
   `standard_payg`, are not exact tuples, and so stay outside the pilot exactly
   as before.
4. **Spent, stale or unknown evidence removes the route.** `exhausted`,
   `rate_limited`, an expired window, or a sync that could not read Kaana's
   credential economics (the scorecard then says `standard_payg`) leaves the
   lane level with no admitted route; Kaana additionally withholds a key retired
   by Anthropic's `billing_error` from its serving snapshot.
5. **The fallback level is signed beside it.** A lane request resolves
   `[level, fallbackLevel]` — one priority per level, exactly like `auto`'s
   ladder — and the fallback priority admits only the pilot's ordinary tuples at
   the ordinary ceiling. With the grant available, Claude is primary and the
   XHigh route is a signed failover whenever it resolves the same effort (both
   targets are `high`). Without it, the XHigh route serves the request. The
   fallback is dropped when the application's policy does not allow it.
6. **Each signed route answers to its own ceiling**: the lane's USD 1.00 for a
   route admitted by its promotional funding, the pilot's USD 0.05 for every
   other one. A tighter application `maxPricePerRequest` still wins for both.
7. **The input and output bounds do not change.** The completion input budget
   stays 126,976 and output stays 2048: the XHigh fallback signed beside Claude
   must fit the same request, and Alia already fits every step to this one
   budget. A per-funding-class input budget would need the route chosen before
   the input check and would buy nothing the fallback could serve.

## Alternatives rejected

**Add the `dep_anthropic_*` tuples to the exact list.** Funding then ranks a
promotional Claude model of a cheap class ahead of the cheap route at `auto`,
and every new grant-funded line (Fable 5.1, Haiku 5.5) needs a policy edit;
the exact list also cannot say "only while the grant lasts".

**Admit promotional routes at every level.** It spends the grant on `auto`
traffic — most Alia chats carry tools and land on `medium` or `high`.

**Let Alia retry a lower level when Pro is refused.** A second routing loop in
a caller; Oxy owns which routes are signed and Kaana owns failover.

## Consequences

- The grant's own evidence bounds the month: up to one 30-minute sync interval
  can pass between the grant running out and the scorecard saying so. In that
  window Anthropic answers `billing_error`, Kaana retires the key and fails over
  along the signed routes. The Anthropic organisation behind the key must not
  carry auto-reload or a paid fallback, or that window would spend money.
- A request at a lane level whose Claude route resolves a different effort
  than the fallback is signed without the fallback (one effort per envelope).
- A Claude line becomes a lane candidate only through its reviewed power class:
  Opus 4.7 and 4.8 (Pro), Opus 5 and Fable 5 (Ultra) today. Opus 5.5 and
  Fable 5.1 need a reviewed class first.
- The lane is pilot data; removing `promotionalCredit` restores the exact-tuple
  pilot with no other change.
