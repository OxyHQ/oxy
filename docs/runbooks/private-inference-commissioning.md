# Private inference commissioning

An exact source-reviewed scoped audience can measure a private deployment before
public serving approval. This is a separate admission state: its database row
stays `platform_internal`, `pending_review`, and `disabled`. Ordinary model,
profile and catalogue requests cannot select it. Legal review is still required;
commissioning does not grant resale rights or fabricate performance scores.

`sourceReviewedScopedAudience()` remains undefined in this change. Neither a
request field, environment variable nor this CLI activates a permit. Activation
requires a separately reviewed source change in Oxy and Kaana with the same exact
principal, environment, deployment, provider key, revision, immutable price and
rate-card observation, effective policy, input hash, idempotency key, USD ceiling
and expiry. Source expiry must cover the reviewed delivery window; the operator
call timeout is independently bounded. A consumed permit cannot be reused or
extended. Unknown regions remain unknown.

## Operator sequence

1. Confirm authenticated provider custody/discovery and the real published price.
   Preserve every existing card's observation time and expiry. Import the exact
   signed scoped descriptor through the canonical catalogue synchronizer. No
   operator SQL creates a model, price, score or entitlement.
2. Read back the exact newly imported deployment row, audience and price. It must
   remain pending and disabled, with no automatic approval policy. Review the
   applicable model/provider terms and privacy evidence for this specific private
   use, including any restrictions. Session approval and current staff metadata
   are evidence of operator authorization, not a legal conclusion themselves.
3. Prepare a `scoped-legal-review-v1` plan with the existing reviewer ID, exact
   deployment row ID/audience, expected legal status/evidence, new evidence
   pointer, reason, operator provenance and session-approval reference. Use the
   compiled canonical CLI on the reviewed image:

   ```sh
   node packages/api/dist/scripts/recordScopedLegalReview.js /private/review-plan.json
   node packages/api/dist/scripts/recordScopedLegalReview.js /private/review-plan.json --apply <planSha256>
   ```

   The first command is dry-run. `planSha256` is SHA-256 of the normalized plan's
   recursively sorted canonical JSON, returned by dry-run; it is not the hash of
   a pretty-printed file. The CLI rereads and locks the existing local active
   staff reviewer and exact deployment, requires `inference:catalogue:publish`
   and no closure fence, and compares every deployment precondition. It joins
   canonical `recordLegalReview` and a security audit in one transaction. It
   never creates a staff identity, changes its privileges, authenticates an HTTP
   bearer, or calls `applyPermissionAction('approve')`.
4. An identical canonical reimport preserves the exact private legal review. A
   changed audience, price, route/revision, model capability or provider privacy
   invalidates that review before reuse, even if immutable price import refuses
   the changed publication. Ordinary manually reviewed deployments keep their
   existing protection. Inspect legal/audit readback before invoking the one synthetic nonstreaming
   decisions fixture through the real scoped principal. The private selector
   still applies availability, capability, privacy, residency, effective-policy,
   price, capacity and attestation checks. Price-only routing uses the real price
   score. Other ranking dimensions with absent or stale measurements reject.
   The signed evidence says `private_commissioning` and truthfully retains
   `pending_review`/`disabled`. It does not claim public approval.
5. Reconcile a lost apply response by reading the exact deployment and audit
   plan hash. Do not blindly repeat the write. A stale expected legal state fails.
   A later ordinary public launch still requires its existing review and measured
   scorecard workflow; this private admission cannot satisfy that workflow.

No production operation is performed by the local qualification tests. Their
source authority, reviewer, provider transport and commercial promotional funds
are explicit synthetic fixtures. The actual first Alia commissioning principal
uses its separately verified internal-metered relationship, not those funds.
