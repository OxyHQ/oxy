# Inbox point inference

Inbox compose, daily brief, natural-language search, smart replies and thread
summary are bounded product inference, not Alia agents. They enter through
`/email/ai/*` with the user's normal Oxy session; capability tickets are not
accepted on this product-UI lane. Oxy
owns request schemas, prompts, content bounds and output validation, and then
uses the ordinary reservation, Kaana execution, usage and settlement path.

The billing application is the exact Inbox record
`6a37b3e61ddfd195b656819b`. `INBOX_APPLICATION_KEY` selects its revocable
server-side attribution credential and the resolver refuses any credential for a
different application, an inactive application, a non-service credential or a
credential whose effective application/credential scope intersection lacks
`inference:invoke`. It is not a provider key and it does not replace the human
session authorization. The user is recorded as `delegatedUserId`; the Inbox
application's owner account remains the billing principal.

Routing is equally explicit. `INBOX_INFERENCE_ROUTING_PROFILE_ID` must contain a
Postgres `inference_routing_profiles.id`. Runtime resolves that primary key and
never picks a profile by display name, order, slug fallback or “first row”. An
absent or unknown ID returns a fail-closed 503 before reservation or Kaana.

## Production bootstrap

Production currently has no routing-profile rows. The required order is:

1. Dry-run, review and then explicitly apply the exact-ID catalogue reviewer
   bootstrap in [the runbook](../runbooks/bootstrap-catalogue-reviewer.md).
2. Run the canonical inference-catalogue bootstrap, which creates `kaana-v1`
   and records the exact generated `inference_routing_profiles.id` in its
   reviewed result.
3. Verify that exact ID by primary-key lookup; do not rediscover it by name,
   ordering or an implicit first row.
4. Run the canonical application seed so exact Inbox application
   `6a37b3e61ddfd195b656819b` gains `inference:invoke`.
5. Dry-run, review, then apply **Reconcile service credential authority** for
   that exact application and existing production credential
   `01a06134-022c-72b6-a876-27da37a39e39`. The workflow pins this pair and adds
   only `inference:invoke`; it never looks up a credential by name or order.
6. Verify the application and credential selected by `INBOX_APPLICATION_KEY`
   are active and their effective scope intersection grants `inference:invoke`.
7. Set the GitHub Actions variable `INBOX_INFERENCE_ROUTING_PROFILE_ID` to that
   exact ID.
8. Deploy Oxy, enable the already-gated Kaana execution/charging rollout in its
   documented order, and smoke one non-stream and one cancelled stream while
   checking reservation settlement and usage attribution.

Do not invent or hardcode a routing-profile ID before step 2. Until all eight
steps pass, Inbox inference is intentionally unavailable rather than silently
routed elsewhere.

The old Oxy-to-Alia `/alia/chat/completions` and `/v1/voice/*` proxies and their
`ALIA_API_KEY` task binding are removed. Apps that use Alia chat, agents or voice
as product capabilities continue to call Alia directly; this change only removes
Alia as infrastructure for generic point inference.
