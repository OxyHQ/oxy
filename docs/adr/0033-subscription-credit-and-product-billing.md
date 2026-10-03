# 0033 — Subscription credits and product billing

Status: accepted for implementation under Nate's approval of the documented I06/I07 recommendations in #1519 on 2026-10-03. This decision does not invent plan prices, promotion amounts or an Oxy One sale.

References: [I06](https://github.com/OxyHQ/oxy/issues/1524), [I07](https://github.com/OxyHQ/oxy/issues/1525), [period proposal](../billing/proposals/i06-period-rules.md), [product proposal](../billing/proposals/i07-product-access.md), ADR 0014.

## Decision

P1 uses integer arithmetic and floors a paid upgrade's credit difference multiplied by the paid period's remaining fraction. The period cap is the highest paid plan's full allowance, with the verified base allowance reserved even when its delivery is late. A downgrade creates no top-up and no automatic clawback. Attribution follows a complete, verified paid-invoice set ordered by payment time and invoice ID; committed receipts are immutable. If a newly discovered backdated invoice would change an existing assignment, reconciliation rejects before writes and reports the discrepancy. Repeated paginated provider reads improve detection of changes but do not prove an atomic remote snapshot or the absence of omitted history.

P2 awards only declared, versioned trial/coupon promotions with explicit credits and once-per-account behavior. The production declaration registry remains empty: illustrative proposal values are not active offers. A zero-amount invoice without an exact declaration awards nothing.

P3 consumes cumulative signed refund evidence using floor(granted × refunded / paid). It removes at most the matching grant's unconsumed remainder. It does not claw back opaque historical/purchased credits, sum repeated snapshots, or call a remote refund API. The adapter supports one fully allocated charge per invoice and rejects ambiguous split payments; non-subscription purchases retain their existing behavior.

New subscription grants record conserved granted, consumed, refunded and remaining credit counts. Spending uses FIFO across tracked grants, then the opaque historical/purchased paid remainder, then free credits. No historical balance is reconstructed and no inference-money-to-credits conversion is introduced. Grant/receipt/aggregate and spend/refund histories commit or roll back together. Financial paths lock the account before its balance and before the first receipt or ledger INSERT; refunds may maintain retained history after closure, while fresh grants and spends require an active account without a closure fence. Confirmed replays make no new award or debit.

Product access and API credits are separate benefits. A strict versioned catalogue names products, offers, combination rules, provider account/mode/environment and effective price windows explicitly. Empty or ambiguous mappings cannot award product rights. Oxy One excludes API credits; this implementation supports explicit bundle composition without launching or inferring an Oxy One catalogue. Existing API-credit plans and pack prices are retained.

A verified invoice that grants both product access and API credits uses one transaction after all remote evidence has been collected. Product ownership/application locks are acquired in canonical order before credit account/balance locks. Source/segment/access grants/provider evidence/delivery and receipt/credit grant/aggregate commit together. Verified historical paid periods can be recorded without rewinding or reactivating a current subscription. Provider updated/deleted events read the current subscription and monotonically update an existing product source without awarding rights.

Console presents each source, original paid segment and credit grant separately. Reads and named cancellations bind to the authenticated subject, so switching accounts cannot display or cancel a cached subscription from the previous subject.

## Acceptance and limits

Fixtures prove these rules with synthetic provider evidence. Trusted normalization is not proof of a remote provider's complete history. The existing catalogue and subscriptions of Oxy, Clarity and Mercaria still require a read-only inventory and comparison before backfill; ambiguity remains on the documented legacy adapter. SDK/backend rollout must preserve compatible publication/deployment ordering. This ADR alone does not satisfy the complete I06/I07 acceptance checklists.
