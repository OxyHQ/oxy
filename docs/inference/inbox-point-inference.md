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

## Routing: the `instant` power level

Every Inbox feature (compose, daily brief, natural search, smart replies,
thread summary, automatic labelling, card extraction) targets the `instant`
[power level](./power-levels.md), the cheapest one. Runtime names it by its
fixed primary key `power-instant` (`INBOX_ROUTING_PROFILE_ID` in
`packages/api/src/config/inboxInference.ts`), the equivalent of
`"model": "instant"` on the public dialects. Migration
`0129_power_routing_profiles` seeds that row identically in every environment,
so it is source, not deploy configuration: there is no
`INBOX_INFERENCE_ROUTING_PROFILE_ID` variable any more, and a leftover value is
ignored. If the row is absent the request fails closed with a 503 before
reservation or Kaana.

The edge picks the cheapest servable model of the reviewed `instant` class,
may fail over to another `instant` model, and names the concrete model that ran
in the completion (`model`). Inbox's `/email/ai/*` response bodies do not carry
it; it is recorded on the usage and route-switch rows.

Every feature's input is bounded well inside the `instant` class: the largest,
thread summary, is at most 30 messages of 800 characters (about 6 000 input
tokens, under `auto`'s 8 000-token `medium` floor) with 600 output tokens. The
previous `kaana-v1` profile's only candidate, `openai/gpt-oss-120b`, is itself
classed `instant`, so this is not a capability downgrade. No feature needs
`medium`.

### Application routing policy

Inbox's application routing policy should be:

```json
{
  "defaultTarget": { "kind": "routing_profile_id", "routingProfileId": "power-instant" },
  "allowedRoutingProfileIds": ["power-instant"]
}
```

Runtime always names `power-instant` explicitly, so the default only covers a
future call that names nothing; the allowed list is what refuses any other
level (`policy_violation`, 403). Because the list is non-empty, a policy that
omitted `power-instant` would refuse every Inbox request.

The console's routing-policy form can set the default to a routing profile but
has no control for `allowedRoutingProfileIds` (it preserves the stored list and
starts a new policy with `[]`), so write the whole policy through the API with
a principal holding the staff-granted `inference:routing:write`:
`GET /inference/routing-policies/applications/6a37b3e61ddfd195b656819b` first;
if it returns `source: "application"`, append a version with
`POST /inference/routing-policies/:policyId/versions`, otherwise create it with
`POST /inference/routing-policies/applications/6a37b3e61ddfd195b656819b`. The
body is the full `routingPolicyControlsBody` (every required control, not only
the two fields above). There is no workflow that writes routing policies.

## Production bootstrap

1. Verify migration `0129_power_routing_profiles` ran in production and the
   `power-instant` row exists, and that `GET /v1/models/routing-profiles` lists
   at least one `instant` candidate servable for the real Inbox principal
   (`first_party`, which sees `platform_internal` routes the Kaana catalogue
   sync publishes). Do not convert Inbox to `internal` or change a commercial
   scope merely to make the check green.
2. Write Inbox's routing policy (above).
3. Run the canonical application seed so exact Inbox application
   `6a37b3e61ddfd195b656819b` gains `inference:invoke`.
4. Dry-run, review, then apply **Reconcile service credential authority** for
   that exact application and existing production credential
   `01a06134-022c-72b6-a876-27da37a39e39`. The workflow pins this pair and adds
   only `inference:invoke`; it never looks up a credential by name or order.
5. Verify the application and credential selected by `INBOX_APPLICATION_KEY`
   are active and their effective scope intersection grants `inference:invoke`,
   with the read-only [principal and ledger readback](inbox-principal-readback.md).
   It proves metadata only and authorizes no canary or credential reuse.
6. Deploy Oxy, authorize charging in its documented rollout order, and smoke
   one non-stream and one cancelled stream while checking the concrete model,
   reservation settlement and usage attribution.

The `kaana-v1` profile (`01a06477-94f5-74f0-bc25-4c5c13b93ccd`), its reviewed
bootstrap and the
[exact-PK readback](../../.github/workflows/inbox-routing-profile-readback.yml)
predate this: runtime no longer routes Inbox through it.

The two inbound background consumers remain independently opt-in during that
period: `AI_LABELING_ENABLED=false` and `CARD_EXTRACTION_ENABLED=false` (both
default to false when unset). Do not enable either until the exact-profile
readback and real-principal audience proof pass. Interactive `/email/ai/*`
requests continue to fail closed with `INBOX_INFERENCE_UNAVAILABLE`; stored and
imported email must not generate one warning per message merely because the
deliberately unavailable card extractor is disabled.

The old Oxy-to-Alia `/alia/chat/completions` and `/v1/voice/*` proxies and their
`ALIA_API_KEY` task binding are removed. Apps that use Alia chat, agents or voice
as product capabilities continue to call Alia directly; this change only removes
Alia as infrastructure for generic point inference.
