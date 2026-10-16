# ADR 0045 — An Oxy app proves which app it is with an Oxy-signed app assertion

- Status: accepted
- Date: 2026-10-16
- Amends: ADR 0044 (its "A session says which application it belongs to" section)
- Companion: Alia ADR 0021
- Scope: how a request proves which Oxy application it comes from

## Context

ADR 0044 lets Oxy confine an application's own agent to that application, and
assumed the person's session names its application. It does not: ADR 0029 gives
every official app ONE shared device session with no client, and an app's
`clientId` is public (`resolveApplicationSessionLane`: names and origins confer
no trust). Nothing a request carries today proves which app sent it. The owner
decided on 2026-10-16 that this is solved properly, at the root.

## Decision

### The registry records how each app can be recognised

Each application's registry entry may declare, written only through the staff
application-administration lane:

- `webOrigins`: exact `https://` origins the app is served from;
- `android`: `{ packageName, signingCertSha256[] }`;
- `ios`: `{ teamId, bundleId }`.

### The app obtains an assertion from Oxy

`POST /apps/assertions` returns a short-lived (5 minutes), single-session JWS
`OXY-APP+JWT` signed by Oxy, with `sub` = person, `sid` = session,
`app` = application id, `platform`, `iat`/`exp`, `jti`. The person's own bearer
authenticates the call, and the app proves itself by platform:

- **web**: the browser's `Origin` header must be one of the app's `webOrigins`.
  A page cannot set `Origin`; a non-browser client that forges it gets nothing
  that its own session could not already do (see Consequences).
- **Android**: a Play Integrity token whose verdict names the app's
  `packageName`, a recognised signing certificate and a genuine install,
  verified server-side with Google.
- **iOS**: an App Attest assertion for the app's `teamId`/`bundleId`, verified
  against the key attested for that device.

The SDK (`@oxy.so/services`) obtains and refreshes it for the app; no app code
handles it.

### Services verify it

A service that needs to know the app (Alia, for ADR 0044) verifies the JWS
against Oxy's JWKS, checks `sub`/`sid` against the request's verified session
and `exp`, and reads `app`. It never reads an app identity from anything else.

## Alternatives rejected

- **The public `clientId`:** anyone can send it.
- **Per-app sessions for official apps:** reverses ADR 0029.
- **Hiding the agent instead of confining it:** a product convention, not a rule.

## Consequences

- ADR 0044's confinement is enforced against the app assertion, not the session.
- On the web, the guarantee is the browser's. A scripted client forging `Origin`
  can open a confined agent only as the person it already is, with their own
  data and credits — the confinement is a product boundary, and data authority
  stays where ADR 0042 puts it.
- Operator inputs: Google Play Integrity (a Google Cloud project with the Play
  Integrity API and the apps linked), Apple App Attest (team id and bundle ids),
  and each app's web origins, packages and certificates in the registry.

## Enforcement

- API tests: an assertion is issued only for a registered origin, package and
  certificate, or App Attest key; never for another app; bound to the session;
  expires; replay of a used Play Integrity or App Attest token is refused.
- Service verification tests: a wrong signature, session, subject or expired
  assertion reads as no app.
