# Account events: telling relying parties an account was deleted

> Related: [Oxy ID](README.md) · [Service tokens](../SERVICE_TOKENS.md) · OxyHQ/Mention#1169

When a person deletes their Oxy account (`DELETE /users/me`), every application
that may hold their data must erase it. Oxy used to stop at its own tables:
Mention kept serving a deleted account's profile design, posts and federated
actor because nothing told it the account was gone. The GDPR right to erasure
obliges the controller to pass an erasure on to whoever it disclosed the data to
(Art. 17(2), Art. 19). This page is how Oxy does that.

## Design

One event, recorded once, received two ways.

| | |
|---|---|
| **Record** | `account_events` (one row per deletion) and `account_event_deliveries` (one row per recipient application), written **in the transaction that deletes or archives the account**. An event exists if and only if the deletion committed. |
| **Push** | `accountEventWebhook.worker.ts` POSTs a signed token to each recipient's `webhook_url`, at least once, with exponential backoff. |
| **Pull** | `GET /account-events` serves the same signed tokens to the recipient application from a cursor. This is the reconciliation safety net: a relying party that was down past the retry window, has no webhook, or had a delivery dead-lettered still catches up. |

Relying parties should use both: the webhook for latency, a periodic pull for
certainty. They must never infer a deletion from a `404` on a profile lookup —
only a verified event is an instruction to erase.

### When an event is recorded

Both outcomes of `DELETE /users/me`:

- **Hard delete** — the `users` row is removed. `retained: false`.
- **Archive for retention** — financial records force the row to stay
  (`account_status = 'archived'`), every optional datum is erased.
  `retained: true`. The person still deleted their account: relying parties
  erase either way; the flag is informational.

And archiving a managed account (`DELETE /accounts/:id`: a channel,
organisation, project or bot; a personal account cannot be archived) records
the same event with `retained: true`, in the archive's transaction
(`accountService.archiveAccount`, OxyHQ/Mention#1178). It is not a person's
erasure request, but relying parties need the same instruction, for three
reasons:

- **The archive is permanent.** It writes an account closure fence, and nothing
  restores an archived account. The id is gone for good.
- **Relying parties hold managed-account data and cannot see the archive.**
  A Mention channel is an Oxy account whose posts, actor and followers live in
  Mention. The Accounts app's managed-accounts screen, the Console and the
  services SDK's account settings all archive directly. A channel archived
  there used to keep its posts, and stay federated, in Mention forever.
- **The event carries the handle**, which a relying party needs to address the
  actor `Delete` once Oxy stops resolving the archived account.

Recipients follow the rule below: first-party, internal and system
applications, plus any application the managed account granted or had a session
with.

Archiving a remote federated actor (`federation.ts`, after a peer answers
`410 Gone`) is a different path and records nothing. That identity was never
an Oxy account a relying party served, and Mention itself triggers it.

### Who is told

Active applications that are `first_party`, `internal` or `system` — they serve
every account without a per-user grant, and a first-party sign-in does not
always record which application a session belongs to — plus any application the
person granted access to (`app_grants`) or had a session with (`sessions`). The
recipient set is read before the `users` row is deleted, since those rows
cascade with it. A third-party application the person never used is not told:
the event would disclose the person to a stranger.

## The token

A Security Event Token (RFC 8417), compact JWS, signed with Oxy's Ed25519
service-token key and verifiable with the public key set at
`https://api.oxy.so/.well-known/jwks.json` — the same set that verifies service
tokens. The JOSE `typ` differs (`secevent+jwt` against `JWT`), so neither can be
accepted as the other.

```json
// header
{ "alg": "EdDSA", "typ": "secevent+jwt", "kid": "oxy-service-2026-09-17" }
// payload
{
  "iss": "oxy-auth",
  "aud": "<receiving application id>",
  "iat": 1790000000,
  "jti": "<event id, uuidv7>",
  "events": {
    "https://oxy.so/events/account.deleted": {
      "userId": "<Oxy user id>",
      "username": "<handle at deletion time, or null>",
      "occurredAt": "2026-09-26T09:14:00.000Z",
      "retained": false
    }
  }
}
```

`aud` is the receiving application, so a token captured from one relying party
cannot be replayed at another. `jti` is stable across every push retry and the
pull feed: it is the consumer's idempotency key. `username` is there for relying
parties that address the person by handle — Mention's ActivityPub actor is
`/ap/users/<username>` — and cannot look it up once the profile is gone.

### Verifying (`@oxy.so/core` ≥ 1.13.0)

```ts
// `oxy` is an OxyServer (@oxy.so/core/server) with its service credential.
const event = await oxy.accountEvents.verify(token);
// { eventId, type: 'account.deleted', userId, username, occurredAt, retained, applicationId, issuedAt }
```

The audience defaults to the `appId` of the client's configured service
credential. Anything else — a foreign key, another audience, another issuer, a
service token, an unknown event — throws `OxyAccountEventError`.

## Push

```
POST <application.webhook_url>
content-type: application/secevent+jwt
oxy-event-id: <jti>
oxy-event-type: account.deleted

<the token>
```

- Acknowledge with any `2xx` (RFC 8935 suggests `202`) **after** recording the
  event durably. Anything else, or no answer within 10 s, is a failure.
- Retries: 1 minute, doubling, capped at 6 hours; dead-lettered after 16
  attempts (about three and a half days). The pull feed still serves a
  dead-lettered event.
- The URL is owner-supplied, so the POST goes through `safeFetch`: public
  addresses only, DNS-pinned, no redirects.
- An application without a webhook gets its delivery closed at once with
  "available from the pull feed".
- `ACCOUNT_EVENT_WEBHOOK_WORKER_ENABLED=false` stops the push loop; events keep
  accumulating and the pull feed keeps serving them.

The webhook URL is set on the application in the Oxy Console (`webhookUrl`).
Mention's is `https://api.mention.earth/webhooks/oxy/account-events`;
CrowdSource's is `https://api.crowdsource.oxy.so/webhooks/oxy/account-events`
(OxyHQ/Mention#1178). Both are declared in the application seed
(`seedOxyApplicationsSpecs.ts`), which sets a declared webhook and mints a fresh
secret whenever it changes the URL.

## Pull

```
GET /account-events?after=<cursor>&limit=<1..200>
Authorization: Bearer <service token>
```

```json
{ "data": {
  "events": [ { "eventId": "…", "type": "account.deleted", "userId": "…", "username": "…",
                "occurredAt": "…", "retained": false, "token": "<signed token>" } ],
  "nextCursor": "<last eventId, or the input cursor when empty>"
} }
```

- Any application with a service token may call it; each sees only the events it
  was a recipient of.
- Events younger than 30 seconds are held back. Event ids are time-ordered, but a
  transaction that began earlier can commit later; the hold-back keeps a cursor
  from skipping it.
- `@oxy.so/core/server`: `oxy.accountEvents.list({ after, limit })`. Verify each entry's
  `token` before acting on it.

## Retention

Events are swept after 30 days (`ACCOUNT_EVENT_RETENTION_SECONDS`,
`db/expiry.ts`), deliveries with them. Thirty days is far past the push retry
window, so a relying party that reconciles even weekly cannot miss one; after
that the deleted account's id is dropped too.

## Federation signing keys outlive the account, on purpose

`DELETE /users/me` does **not** delete the account's ActivityPub key pair
(`federation_key_pairs`, keyed by `keyId`, with no foreign key to `users`). A
relying party that runs an ActivityPub actor for the person — Mention — must
still sign the actor `Delete` (and its posts' `Delete`s) through
`POST /federation/sign` after the account is gone, and peers verify that
signature against the key the actor published.

Any future purge of `federation_key_pairs` for deleted accounts must wait a
grace period measured in **days** after the deletion (at least the push retry
window plus the relying parties' own delivery retries), so every relying party
can still sign its actor `Delete`s. Purging with the account would leave the
deleted actor's posts federated forever.
