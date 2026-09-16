# 0023 — Development is a credential, not an exception in the origin check

- Status: proposed
- Scope: Oxy API origin/consent decisions, `application_credentials`, Console, the SDK's development story

## Context

Oxy trusts exactly three kinds of browser origin (`config/allowedOrigins.ts`):
loopback — unconditionally, in every environment — the origins derived from
active first-party/internal/official applications' `redirect_uris`
(`config/dynamicOriginRegistry.ts`), and the `OXY_EXTRA_ALLOWED_ORIGINS` escape
hatch. `utils/oauthRedirect.ts` then matches a `redirect_uri` byte for byte in
constant time. Both are deliberate and neither should get looser.

What neither covers is the ordinary act of building an app against Oxy from a
device that is not the machine running the dev server: a phone on the same
Wi-Fi, a second laptop, a tablet, an Expo web build opened from another desk.
`localhost` is not reachable from there, so the origin is `http://192.168.x.y:PORT`
and every credentialed call is refused by CORS before the person sees anything.

Today that leaves three unattractive moves, all of which have been taken at least
once in this codebase or around it:

- **Register the dev origin on a production application.** It widens that
  application's trusted-origin set for everybody, forever, and it is invisible
  once merged into the registry snapshot. We created an "Oxy Dev (LAN)"
  application for exactly this and deleted it again: an Application that is not a
  product is a lie in the Console, and the Console is the control plane
  (ADR 0005).
- **Loosen the origin predicate** — private-range IPs, port wildcards, a
  `NODE_ENV` branch. `isLoopbackOrigin` trusts only the developer's own machine;
  an RFC1918 allowance trusts *any other machine on any network a user is on*,
  which is the CSRF/token-leak boundary `allowedOrigins.ts` exists to hold. The
  SDK rules also forbid gating trust on `NODE_ENV`.
- **Build private infrastructure** — per-developer DNS plus a TLS proxy so the
  dev box gets a real hostname. It works, it is a day of setup per developer, and
  it does nothing for the third-party developers who consume `@oxy.so/sdk`.

The missing concept is already half-present in the schema. `application_credentials.environment`
has been `development | staging | production` since the table was written, and the
machine lane enforces it (`middleware/machineCredential.ts` refuses an
`environment_mismatch`). For `public` credentials — the ones that drive sign-in —
the column is recorded and then read by nothing.

## Decision

**A development origin is a property of a CREDENTIAL, and a development
credential is a strictly weaker principal.** The application keeps one production
identity; development gets its own, bounded, revocable key.

**The credential carries its own origins.** A credential with
`environment = 'development'` declares `origins` (and its own redirect URIs) on
the credential row. Production credentials keep deriving everything from the
application's `redirect_uris`; nothing about the existing path changes, and the
trusted-origin snapshot never gains a development origin.

**Matching stays exact.** Development origins are compared the way production
ones are — exact, constant-time, no wildcards, no port ranges, no CIDR. The
difference is scope of blast radius, not looseness of comparison.

**A development credential never reaches the credentialed lane.**
`getCorsDecision` answers `{ allow: true, credentials: false }` for its origins,
the way third-party origins are answered today. It is a development key; it does
not get the CSRF-sensitive lane that `console.oxy.so` gets.

**Consent is always shown.** `isTrustedApplication` auto-approves for
first-party, internal and official applications. A request authenticated with a
development credential is exempted from that: the person approves, every time,
on a screen that names the unverified origin. An unverified origin asking for a
trusted app's session is exactly the case the anti-phishing screen is for.

**It expires, and it is bounded.** `expires_at` is required and capped
(90 days). Privileged scopes are refused outright (`isPrivilegedScope` already
gates them at credential creation), scopes still intersect the application's,
and sessions minted through it are short-lived. Creation, rotation and
revocation already write `application_credential_audit_events`.

**The Console creates it.** "Add a development client" on the application, with
its origins, its expiry and a visible countdown — plus a list a person can audit
and revoke in one click. The SDK documents it as the answer to "how do I test on
my phone".

## Consequences

- The recurring need has a supported answer, for Oxy's own apps and for every
  third-party consumer of the SDK, without anyone inventing infrastructure.
- `allowedOrigins.ts` and `oauthRedirect.ts` keep their current shape. No
  environment branch enters a trust decision, and loopback stays the only
  unconditional origin.
- A leaked development key is bounded three ways: it cannot use the credentialed
  lane, it cannot skip consent, and it dies on its expiry date.
- `environment` becomes load-bearing for `public` credentials, so credential
  resolution reads it on the origin and consent paths.
- New: an `origins` column on `application_credentials`, a Console surface, and
  a security review — this is the one place where a key may be used from an
  origin Oxy has not verified, and it must be reviewed as such.
- Until it ships, the honest workaround is a tunnel that makes the dev server
  loopback on the testing device (`ssh -L`). It is limited, and it does not
  pretend to be anything else.

## Alternatives rejected

**Trust RFC1918 origins the way loopback is trusted.** Loopback is one machine —
the developer's own. A private range is every other device on every network an
Oxy user ever joins; a hostile device on a café or home LAN would gain the
credentialed lane against production. The gain is convenience for one developer;
the cost is a boundary that protects every user.

**Wildcards or port ranges in `redirect_uri` matching.** The matcher is byte-exact
and constant-time on purpose: it is the last thing standing between a stolen
authorization code and an attacker's endpoint. Pattern syntax there buys a
developer some typing and gives an attacker a parser.

**Register development origins on the production application.** What "Oxy Dev
(LAN)" did. It widens the real application's trusted origins, it is
indistinguishable in the registry from a production origin, and it puts
non-products in the Console.

**Per-developer DNS plus a TLS reverse proxy.** Real infrastructure to work
around a missing product feature. It also fails the third-party case, which is
the one that matters most.

**Leave it at tunnels.** Correct, and it is the interim answer, but it cannot be
the permanent one: it does not work on a phone browser, and telling SDK consumers
to build an SSH tunnel is not an answer.
