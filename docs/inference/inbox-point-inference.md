# Inbox point inference

Inbox compose, daily brief, natural-language search, smart replies and thread
summary are bounded product inference, not Alia agents. They enter through
`/email/ai/*` with the user's normal Oxy session; capability tickets are not
accepted on this product-UI lane. Oxy
owns request schemas, prompts, content bounds and output validation, and then
uses the ordinary reservation, Kaana execution, usage and settlement path.

## Daily Brief day boundary and data minimisation

The Inbox client must compute the start of the user's current local calendar day
and the start of the next local day, then send both instants as UTC ISO strings
in `POST /email/ai/daily-brief`:

```json
{
  "startAt": "2026-09-02T21:00:00.000Z",
  "endAt": "2026-09-03T21:00:00.000Z",
  "stream": true
}
```

Oxy cannot reconstruct that boundary from server time. It requires both values
with the `Z` suffix, requires `endAt > startAt`, and accepts only a 23-25 hour
window so ordinary, spring-forward and fall-back local days work while an
arbitrary history range fails closed. The interval is half-open
`[startAt, endAt)`, which assigns a message on midnight to exactly one day.

The backend issues one account-scoped PostgreSQL aggregate over `messages.date`
for `total`, `unread`, `starred` and `withAttachments`. Attachment presence is a
correlated `EXISTS`, so a message with several attachments is counted once.
There is no message-list limit or sample, and the query never selects sender,
subject, body, headers or attachment metadata. Only those four integer counts
are placed in the inference prompt.

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

The last recorded production database read, on 2026-08-17, found no
routing-profile rows. That evidence is dated and is not a statement about the
current live database. The current state must be proved by the exact-primary-key
[Inbox routing-profile PostgreSQL readback](../../.github/workflows/inbox-routing-profile-readback.yml),
which is SELECT-only and cannot create or repair a row. The required order is:

1. Dry-run, review and then explicitly apply the exact-ID catalogue reviewer
   bootstrap in [the runbook](../runbooks/bootstrap-catalogue-reviewer.md).
2. Dry-run, review and explicitly apply the canonical Kaana catalogue bootstrap.
   It owns permanent reviewed primary keys; for Inbox, `kaana-v1` is exactly
   `01a06477-94f5-74f0-bc25-4c5c13b93ccd`. The publisher seed is not this
   bootstrap and does not prove or create the routing-profile row.
3. From `main`, run the manual readback with the exact reviewed live task
   definition, immutable live image digest and that exact primary key. Require
   one matching profile and one matching
   `openai/gpt-oss-120b@observed-2026-09-01` candidate at priority `100`; do not
   rediscover either row by name, ordering or an implicit first row.
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

The permanent source-reviewed ID is an intended identity, not proof that its row
exists in the live database. Do not configure the GitHub variable from source
alone: require the successful exact-PK readback in step 3. Until all eight steps
pass, Inbox inference is intentionally unavailable rather than silently routed
elsewhere.

The old Oxy-to-Alia `/alia/chat/completions` and `/v1/voice/*` proxies and their
`ALIA_API_KEY` task binding are removed. Apps that use Alia chat, agents or voice
as product capabilities continue to call Alia directly; this change only removes
Alia as infrastructure for generic point inference.
