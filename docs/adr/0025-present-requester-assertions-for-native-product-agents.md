# ADR 0025 — A present requester reaches a native product agent through a one-use Oxy assertion, not through offline delegation

- Status: accepted
- Date: 2026-09-17
- Amended: 2026-09-20 — an entry point may also be proved by ATTESTATION (see
  "One entry point, two proofs")
- Scope: first-party product apps entering Alia through a native product agent (Homiio → Sindi first)

## Context

Homiio's Sindi chat reaches Alia as `Authorization: Bearer <Sindi service token>`
plus `X-Oxy-User-Id`. That header is offline delegation: `@oxy.so/core` answers it
with `GET /internal/service-acting-as/verify`, which requires an `app_grants` row
naming `acting-as:offline`, a consent-required scope. So a signed-in person typing
into Homiio's own chat box was asked to approve an OAuth consent screen before
Sindi could answer. That is wrong on its face — the person is present, using an
official Oxy app they signed into — and it is the "second authority for access Oxy
already owns" ADR 0018 rejects for native Alia.

Two things constrain the fix:

- **The human bearer never reaches Alia.** Homiio's backend holds the person's
  verified Oxy session on the incoming request, but forwarding it would let Alia
  (and every hop after it) replay a general Oxy session.
- **`acting-as:offline` is still the right gate for absent-user work.** Its whole
  argument (`services/serviceActingAs.service.ts`) is that platform trust is not
  user consent when *nobody is there*. That argument is unchanged; it simply does
  not describe a request the person is making right now.

## Decision

### Oxy mints a present-requester assertion

`POST /internal/native-agents/requester-assertions` (service token, `/internal`
router trust gates) takes `{ agentId, subjectToken }`, where `subjectToken` is the
requester's Oxy access token as the product backend received it. The token goes to
Oxy only — the issuer that can validate it — in the body, never a header or URL.

Oxy issues an assertion only when ALL hold, re-read live:

1. the calling `(applicationId, credentialId)` and `agentId` are one exact entry of
   `NATIVE_PRODUCT_AGENT_ENTRY_POINTS`, derived from the reviewed native-agent
   manifest (`config/nativeProductAgents.ts`). Being a trusted application is not
   enough; the service identity is pinned byte for byte — as the entry's
   credential id, or as the handle DERIVED from the IAM role that entry declares
   (see "One entry point, two proofs");
2. the row behind whichever proof was used is still live and trusted, and its
   live scope set includes `inference:invoke` — the credential
   (`resolveLiveAgencyCoordinator`: active app, usable service credential, active
   owner, no closure fence) or the binding (`resolveLiveAgencyWorkload`: the same
   app, trust, owner and fence checks, plus an unexpired
   `application_workload_identities` row whose scopes are decided by the same
   `workloadBindingScopes` the workload mint used);
3. `subjectToken` passes `sessionService.validateSession` — signature, expiry,
   live session row, managed-session operator authority, and the v2 claim binding;
4. that session is the shared first-party session (`applicationId` null) or is bound
   to the calling application. A session another application owns is refused, so a
   third-party OAuth bearer cannot be laundered into a first-party product's lane;
5. the requester account is `active`.

Every refusal answers the same `403 requester_assertion_refused`; the reason is
logged server-side only.

### What is signed

A compact JWS, `typ: OXY-REQUESTER+JWT`, `alg: EdDSA`, signed with the capability
ticket key and published at the existing `/capabilities/.well-known/jwks.json`. The
distinct `typ` keeps it unusable as a `CapabilityTicket` and vice versa.

```text
iss  https://api.oxy.so      aud  alia                    sub  requester account id
jti  uuid                    iat/exp  lifetime 120 s      sid  session id
azp  calling application     cid  calling service identity  agentId  exact native agent
```

`cid` names WHAT CALLED: the credential id on the credential path, and the
`wl_…` attestation handle on the workload path. It is not the entry point's
credential id restated — an assertion a workload asked for must not claim a
credential that did not call and whose liveness was never checked. It is also
the only value that works: every verifier of this claim, Oxy's own
`introspectRequesterAssertion` and `@oxy.so/core`'s `requesterAssertion.ts`
alike, compares `cid` against the PRESENTER's verified service-token
`credentialId`, which for an attested presenter is the handle.

### One entry point, two proofs

*(Amendment, 2026-09-20.)*

ADR 0026 lets a first-party service authenticate by attesting its ECS task role
instead of carrying a key pair, and a token minted that way carries the
attestation handle as its `credentialId` — never the credential's UUID, because
there is no credential. Matching an entry point on the UUID alone therefore made
this lane the one thing a product could not do without a key pair: Homiio
attesting matched nothing, got `unknown_entry_point`, and every Sindi chat turn
told a signed-in person to sign in.

An entry may now also declare a `workload` — the provider and the CANONICAL IAM
role ARN — and a caller matches when its `credentialId` equals either the pinned
credential id or `workloadAttestationHandle(subject)`. That is one identity with
two proofs, not two identities.

- **The role is declared, never the digest.** A role ARN is reviewable (it is on
  a task definition anyone can read) and the handle is computed from it by the
  same function the mint uses. A hard-coded `wl_…` is a magic constant a reviewer
  cannot check and an operator cannot reproduce.
- **The shape authorises nothing.** Only the derived handle matches. Another
  first-party service's real, valid handle is refused, as is any other
  `wl_`-shaped value.
- **Declaring a workload is a reviewed authority change**, exactly as adding a
  product is. The list does not read `application_workload_identities` — if it
  did, binding a role would silently hand it a product's entry point, and binding
  is a routine platform step performed on every deploy.
- **The binding does not replace the checks, it takes the credential's place in
  them.** It must name this same application, be unexpired, and still reach
  `inference:invoke`; the application must still be active and trusted and its
  owner still live. Deleting the row, expiring it, or dropping the scope ends the
  lane at the next mint or introspection, which is the immediacy revoking a
  credential has.

### How Alia accepts it

On `/v1/chat/completions` only, header `X-Oxy-Requester-Assertion` beside the
product's own service token (which stays the bearer, so inference is still billed
to the product per ADR 0007). Alia:

1. refuses the request if `X-Oxy-User-Id` is also present (two identity channels);
2. verifies the JWS locally against the JWKS: `typ`, `alg`, `kid`, signature, `iss`,
   `aud = alia`, `exp`, lifetime ≤ 300 s;
3. requires `azp`/`cid` to equal the VERIFIED inbound service token's app and
   credential, so an assertion is useless to any other presenter;
4. calls `POST /internal/native-agents/requester-assertions/introspect` with its own
   service token. Oxy re-verifies, re-runs checks 1–2 and 5, re-reads the session by
   `sid` bypassing the session cache (a signed-out or revoked session fails here), and
   atomically consumes `jti` (Redis `SET NX` for the remaining lifetime). Only the
   audience's application (Alia) may introspect. Replay store unavailable in
   production → inactive. Oxy unreachable → Alia refuses;
5. derives `req.user` from the introspected `sub` — never from a header — and admits
   only the agent named by `agentId`, and only when the agent is bound to that
   application.

### Why no consent screen

The effect is exactly the one the person asked for, in the product they are using,
at the moment they asked. The authority is their own current authority (ADR 0018),
proven by their live session and bounded to one agent, one audience, one use and
two minutes. There is nothing for a consent screen to add, and revocation needs no
grant: signing out, revoking the session or losing the account ends it at the next
introspection.

## Alternatives rejected

- **Auto-grant `acting-as:offline` to first-party apps.** Turns every official
  credential into an offline impersonation key for the whole user base — the exact
  blast radius `serviceActingAs.service.ts` exists to prevent.
- **Forward the user bearer to Alia.** A general, reusable Oxy session in a third
  process, and in Alia's background paths; refused by Homiio's own rules.
- **Reuse `CapabilityTicket`.** Tickets authorize one tool effect on an app resource
  under an execution authorization and delegation grant. Entering a chat is not such
  an effect; faking those claims would dilute the ticket contract.
- **A new credential scope instead of the manifest pin.** A scope admits any
  credential staff later grant it; the pin admits one reviewed triple, and adding a
  product is a reviewed manifest change.

## Consequences

- Product chat for a present user needs no consent anywhere. `acting-as:offline`
  remains the only lane for work with no present requester.
- Each chat turn costs one mint (product → Oxy) and one introspection (Alia → Oxy).
  The assertion is single-use, so products do not cache it.
- Adding a product is a manifest change plus that product's own backend adoption.
- A product on this lane can give up its key pair. Declaring its role here is the
  Oxy half; the product's own half is accepting both names for its one service
  identity wherever it pins `credentialId` (OxyHQ/Homiio#536 did this for Sindi).
- Oxy's replay protection depends on Redis in production and fails closed without it.
