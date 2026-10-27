# ADR 0050 — A person's own session as a kaana.ai credential (`product_session`)

- Status: accepted (2026-10-27, option b of decision 3; the owner's approval was
  relayed to OxyHQ/oxy#2006 and is confirmed on its review)
- Date: 2026-10-27
- Implements: Kaana ADR 0002 phase 2.2 («sesiones de usuario como `product_session`»)
- Builds on: ADR 0007 (attribution), ADR 0029 (one Oxy session), ADR 0045 (app assertions)
- Scope: one-shot inference that an app with no backend asks for with the signed-in person's session

## Context

Astro (application `c08f19e22ae6e86eb1d50361`, `first_party`) is a desktop
browser with no backend. Its one-shot features (name a tab group and pick its
emoji, shorten a pinned tab's title, propose a download's filename, summarise
a YouTube transcript) are single small requests at the `instant` level: by
[request-routing.md](../inference/request-routing.md) they go app → Oxy →
Kaana, and the only credential the app holds is the person's Oxy session.

Neither surface accepts one. The old edge (`api.oxy.so/v1`) and the grant API
(`/internal/kaana/v1/authorizations`, behind `kaana.ai/v1`) both authenticate
through `authenticateInferenceBearer`, which knows the machine lane and service
tokens only: a session token is `service_not_service`, refused. The grant
contract, `kaana_grants.lane` and `EdgePrincipal` already name
`product_session`; [kaana-grants.md](../inference/kaana-grants.md) listed it as
"not yet".

## Decision

### 1. The lane lives on the grant API only

`product_session` is admitted by `POST /internal/kaana/v1/authorizations`, so a
client calls `https://kaana.ai/v1/responses` with the session as its bearer.
The old edge keeps refusing sessions.

- Kaana ADR 0002 puts the lane in phase 2 of the grant API, and its phase 5
  deletes the old edge, `@oxy.so/core/inference` and `createInferenceClient`
  with it. A lane added there would be deleted with the surface, and every
  client written against it rewritten.
- Kaana already forwards any bearer verbatim (`internal/publicapi/credential.go`)
  and never stores, logs or interprets it. No Kaana change is needed.
- The cost: the person's access token (audience `oxy-api`, 15 minutes) now
  reaches Kaana, a first-party service. Kaana ADR 0002 decision 6 accepted
  exactly this (`new Kaana({ credential: () => oxy.getAccessToken() })`).

### 2. What the lane proves, and from where

- The session is verified by the one verification every Oxy route uses
  (`sessionService.validateSession`): signature, expiry, a live row, the
  managed-account and supervision checks, and every v2 claim (`sid`, subject,
  actor, `azp`, device context) against the row. A supervised account is
  refused, as on every other lane.
- **The application comes from the session row** (`sessions.application_id`
  and the live public credential `sessions.client_id` names), never from a
  claim; for a session whose row names none, only as decision 3 says. The payer is that application's owner, read
  live; there is no fallback to the person (ADR 0007).
- The person is the session's subject account. It is the grant's `userId` and
  the usage row's `delegated_user_id`, attribution only. `X-Oxy-User-Id` may be
  omitted; one naming anyone else is refused.
- A session may ask for a grant only: no catalogue or receipt read, because a
  receipt is the credential's and every person of the app shares it.
- **Only reviewed terms admit it.** An application is served on this lane only
  under a relationship in `config/inferenceEconomicPolicy.ts` that names the
  `product_session` lane, its operations and a per-person daily bound. Without
  one the grant is `permission_denied` and nothing is charged: a person's
  session never spends its application's owner's money on terms nobody
  reviewed.

### 3. How a SHARED session names its application: the public client id (option b)

ADR 0029 gives every official app ONE device session with no client:
`sessions.application_id` is NULL, and `@oxy.so/services` puts every
`first_party` application on that device lane
(`classifyApplicationSessionLane`). Only an external OAuth client gets an
application-bound session. ADR 0045 solved the same question for app
confinement with an Oxy-signed app assertion, but it has no desktop protocol.

The options were:

- **(a) A desktop app assertion.** Extend ADR 0045 with a desktop platform and
  carry the `OXY-APP+JWT` through Kaana. macOS may offer App Attest; Windows and
  Linux offer nothing comparable.
- **(b) The public client id, bounded by the terms.** Chosen.
- **(c) An application-bound session for Astro.** Reverses ADR 0029 for one app;
  ADR 0045 rejected it.

**Decided: (b)** (owner's approval of 2026-10-27, relayed to OxyHQ/oxy#2006 and
confirmed on its review). A shared session is attributed to the application
whose registered public client id the caller presents beside it, when:

- the id names a live `public` credential of an active application, read from
  its row (never a name);
- that application's reviewed terms are a `product_session` relationship that
  says so (`sharedSessionAttribution: 'public_client_id'`) and carry a
  per-person daily bound; the operation must be one the terms name.

Anything else is `permission_denied`. An application-bound session still
resolves from its row; a client id presented beside it must be the row's.

The public id proves nothing: anyone with an Oxy session can present it. ADR
0045 rejected it for confinement; for spend the bound is the terms' per-person
and per-application caps, which is also the whole bound under (a), since a
person can lift their own token out of their own desktop app.

**How it is presented.** Kaana forwards the caller's bearer verbatim and
nothing else of its credentials, so the id travels inside the bearer:

```text
Authorization: Bearer oxy_session:<public client id>:<access token>
```

A bare access token is still accepted for an application-bound session.
### 4. Astro's terms (`astro-kaana-session`)

`internal_metered`, like Mention's text features: Astro's owner pays, no hold,
capacity is the bound.

| Term | Value |
|---|---|
| Operations | `responses` only |
| Target | the `instant` level only (anything else `policy_violation`) |
| Input | at most 8 000 estimated tokens |
| Output | the request's own `maxOutputTokens`, required, at most 512 |
| Price | at most USD 0.004 a request (the dearest instant line quotes USD 0.00368 at full size) |
| Per person | 200 requests a UTC day |
| Per application | 10 000 requests a UTC day, 16 in flight (Console may change both) |

Astro presents its public client id beside its shared session (decision 3).
The policy version is `oxy-inference-economics/2026-10-27.2`.

## Consequences

- A person's session is a kaana.ai credential for the applications the policy
  names, and for nothing else.
- Per-person capacity is new: `claimMeteredAdmission` counts the day's rows of
  the relationship for the attributed user under the same advisory lock.
- Inbox's in-process `product_session` principal on the old edge is unchanged;
  its migration to the grant API (Kaana ADR 0002 phase 4) would need its own
  reviewed terms with `sharedSessionAttribution`.

## Enforcement

- `routes/__tests__/internalKaanaGrants.test.ts` (the `product_session`
  block): granted for an application-bound session under the terms, payer the
  owner, `userId` the session's person; refused for a header naming someone
  else, a model or other level, a missing or larger output limit, a larger
  input, another operation, an application without terms (nothing recorded),
  the shared device session presented alone, a revoked or forged session, and
  any read. A shared session presented with the stand-in's public client id is
  granted to it; with an unknown, revoked or termless application's id, or a
  malformed presentation, refused; a person past the daily bound is
  `quota_exceeded` while another is admitted; an application-bound session
  still resolves from its row and refuses another client id beside it.
- `services/__tests__/inferenceMeteredUsage.service.test.ts`: the per-person
  daily bound, apart from the application's, and no admission without a person.
- `config/__tests__/inferenceEconomicPolicy.test.ts`: the terms, that every
  `product_session` relationship names its operations, a first-party class and
  a per-person bound, and that only Astro's accepts a shared session.
