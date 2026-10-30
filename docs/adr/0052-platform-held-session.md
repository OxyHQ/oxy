# ADR 0052 — The platform holds the Oxy session; applications get tokens for themselves from it

- Status: proposed (the owner's direction of 2026-10-30, recorded here for the
  owner's review); nothing is implemented
- Date: 2026-10-30
- Decided by: the owner (product direction); the mechanism below is proposed
- Changes: ADR 0029 D1 and D2 (on a platform that holds the session, the
  platform's account UI and the platform's one credential replace each app's
  dialog and each app's credential); ADR 0045's decision (two new proof lanes,
  `oxyos` and `astro`); ADR 0050 decisions 2 and 3 (an application may also
  come from a verified platform token, and terms may accept it)
- Builds on: ADR 0004 (one runtime), ADR 0049 (no scopes between own apps),
  OxyOS ADR 0013 (launch records), OxyOS ADR 0015 (the platform supplies, the
  application declares) and OxyOS ADR 0020 decisions 3 and 6, which leave this
  decision to the SDK
- Scope: how an Oxy application gets a bearer on a platform that holds the
  person's Oxy session — OxyOS and Astro — and what stays as it is on phones
  and in plain browsers

## Context

Every Oxy app runs its own sign-in runtime today: `OxyProvider` persists
`{ deviceId, deviceSecret }`, cold-boots from it, mirrors the device through
`SessionClient`, opens the bridge on the web and renders the dialog. That
credential is the device-wide restore secret
([tokens-and-credentials.md](../auth/tokens-and-credentials.md)): it mints a
bearer for every account on the device, for as long as the device lives, and it
reaches `/session/device/*` (switch, sign out, add, the background credential).

Two platforms now hold the session themselves:

- **OxyOS.** `oxyos-accountd`, a root system service, holds each enrolled
  account's device credential and nobody else does (OxyOS ADR 0020 decision 3).
  Applications are known by the session's launch records (OxyOS ADR 0013
  decision 3). Until this ADR, OxyOS applications get no Oxy token at all
  (OxyOS ADR 0020 decision 6).
- **Astro**, Oxy's browser. Its chrome is a Bloom app with its own
  `OxyProvider` session (`apps/browser/src/oxy/OxyRoot.tsx`, branch
  `engine/linux`). Web content gets nothing from it: an Oxy web app in an Astro
  tab runs its own SDK, opens the bridge, and keeps a second device credential
  in the page's `localStorage`, on a different device from the chrome's — the
  person signs in to Astro and again to every Oxy site in it.

What the server can give a holder is one bearer. `POST /session/device/token`
returns the session row's stored access token (`sessionService.getAccessToken`
hands back `session.accessToken` unless it is near expiry), so every holder of
one device receives the identical JWT. A shared device session has
`client_id` NULL, and `checkAccessTokenBinding` refuses any `azp` that is not
the row's (`client_mismatch`), so no token on it can name an application. The
access token lives 15 minutes; the session slides 7 days on each mint; the
client has no refresh token (a refresh is another mint with the device secret).
`OxyServices.http` already takes a bearer from outside
(`setAccessTokenProvider`, synchronous) and delegates refresh
(`setAuthRefreshHandler`, asynchronous); `createLinkedClient` is built on both.
ADR 0004's `platformAdapter.{web,native}` split is not built.

ADR 0045 rejected per-app sessions for official apps because they reverse ADR
0029. The issue #937 end state (a BFF/session gateway giving each official app
its own session) was the other answer on file.

## Decision

### 1. A host session in the SDK

**A runtime that holds the session registers a session host; `OxyProvider`
uses it.** The application does not choose: as OxyOS ADR 0015 decision 1 puts
it, the platform supplies and the application never asks which platform it is
on. The same build signs in by itself in a plain browser and is hosted in
Astro and on OxyOS. `sessionMode` keeps its two values: `'account'` is hosted
when a host is registered; `'identity'` (Commons) is never hosted.

The contract lives in `@oxy.so/core` under its own subpath (`@oxy.so/core/host`,
no React, no React Native, no optional peer), versioned by a `contract` number
the host declares:

```ts
interface OxySessionHost {
  readonly contract: 1;
  readonly platform: 'oxyos' | 'astro';
  snapshot(): OxyHostSnapshot;
  subscribe(listener: () => void): () => void;
  getAccessToken(request: { reason: 'boot' | 'preflight' | 'response-401' }):
    Promise<{ accessToken: string; expiresAt: string } | null>;
  request(action: 'sign_in' | 'switch_account' | 'sign_out' | 'manage_account'): Promise<void>;
}

interface OxyHostSnapshot {
  status: 'signed_in' | 'signed_out' | 'unavailable';
  revision: number;                       // bumps on every account change
  account: { id: string; handle: string; displayName?: string; avatar?: string } | null;
  online: boolean;
}
```

The runtime registers it before the application's code runs (the OxyOS Bloom
host natively; Astro in the page, decision 3). An SDK that finds a host with a
contract it does not know runs **signed out**, never its own sign-in: a host
being present means the platform forbids a second credential.

**What host mode wires.** The runtime (ADR 0004) keeps its snapshot and hooks;
its session source is the host instead of the device:

- `OxyServices.http.setAccessTokenProvider` returns the host's last token from
  memory (the seam is synchronous); `setAuthRefreshHandler` calls
  `host.getAccessToken` with the seam's own reason. Linked clients
  (`createLinkedClient`) follow unchanged.
- A snapshot whose `revision` changes is one context transition: the SDK drops
  the token and bumps the session epoch, awaits a token for the new account,
  then publishes the account — ADR 0002's token-before-notify order.
- `user`, `isAuthenticated` and the account come from the snapshot;
  `canUsePrivateApi` is true only while a token is held (decision 4).

**What host mode skips.** The auth-state store (nothing is persisted: no
`deviceId`, no `deviceSecret`, no warm token), every cold-boot lane, the OAuth
return lane, the identity pin, `SessionClient` and its mutations, the device
directory and switcher, `setDeviceCredentialProvider`, the bridge, and the
dialog's sign-in screens.

**What still works.** Every API namespace, `createLinkedClient`, app
assertions (decision 2.7) and the user socket. The socket authenticates with
the app token and joins `user:<id>` only (decision 2.4): notifications and the
supervision signal keep arriving; `session_state` does not, because device
state is the platform's.

**Sign-in, switch and sign-out go to the platform.** `useAuth().signIn()`,
`openAccountDialog()`, the switcher and `logout()` call `host.request(...)`
and change nothing themselves. The platform shows its own UI — the SDK's
dialog, run by the platform — and the result reaches the app as a snapshot.
`logout()` in an app never ends the platform's session silently: the platform
decides whether to ask. `logoutAll`, device management and the account graph's
writes are the platform's Settings, not an application's.

### 2. A server mint for an application's token

**2.1 The platform credential.** A holder credential becomes a platform
credential when it is issued to a sign-in that names an application whose
registry entry declares `platformHost: 'oxyos' | 'astro'` — written only
through the staff application-administration lane, on a `first_party`
application. `device_credentials` gains `platform` and
`platform_application_id` (nullable; `pre` migration). A platform credential is
not evicted by the 32-holder cap. It is never issued to a browser page: the
bridge's join and every request carrying a registered web `Origin` are refused
it. On OxyOS it is the device credential `oxyos-accountd` already holds (OxyOS
ADR 0020 decision 4's setup asks for it); Astro obtains one for its own
session (decision 5).

**2.2 The mint.** `POST /session/device/app-token`, public like
`/session/device/token` (no bearer, possession is the proof), answering only
requests with no web `Origin`:

- in: `{ deviceId, deviceSecret, clientId, attestation, accountId? }`, where
  `attestation` is `{ platform: 'oxyos', desktopEntryId }`,
  `{ platform: 'astro', origin }`, or `{ platform, self: true }` for the
  platform's own application (`platform_application_id`, which needs no
  recognition in step 4);
- out: `{ accessToken, expiresAt, applicationId, accountId }`, `expiresAt`
  being the token's own `exp`.

It mints only when, in this order, each check reading live rows:

1. the secret proves a platform credential of that device (the same lockout
   scope as `/session/device/token`: a wrong secret counts toward it);
2. the credential's `platform` equals the attestation's;
3. `clientId` names a live `public` credential of an active application that
   is `isTrustedApplication` (ADR 0049's first-party); a third-party
   application gets nothing here and keeps OAuth's isolated session;
4. that application is recognised for the platform by its registry entry:
   `oxyos.desktopEntryIds` (new, staff-written, beside ADR 0045's fields)
   contains the `desktopEntryId`, or `webOrigins` contains the `origin`
   exactly. auth.oxy.so's application is never minted for: it is the identity
   carrier and keeps its own device;
5. the device has a live session for the active account (or for `accountId`,
   which pins as `/session/device/token` does and refuses as
   `account_not_on_device`).

A miss is one generic refusal per step's existing code; nothing names an
account, and no step takes an identifier a person typed.

**2.3 The token.** A fresh v2 access token of the **shared session** — the same
`sub`, `act`, `sid`, `device_session_id` and `device_context_id` as the
device's token, so it lives and dies with that session — plus:

- `azp`: the application's public client id;
- `host`: `{ platform, credential }`, the platform credential's id;
- `aud`: `oxy-api`, unchanged. Own apps call one another across the ecosystem
  (ADR 0049); an audience of one backend would refuse them. `azp` is who asks,
  not who may receive;
- life: **5 minutes**, a fresh `jti`, never stored on the session row (its
  `access_token` stays the device's own); no `deviceId` claim.

It carries no `scope`, and no grant row is written: an application is not
given permission by this, it is named (ADR 0049).

**2.4 Verification.** `checkAccessTokenBinding` accepts an `azp` on a session
whose `client_id` is NULL only together with `host`, and then requires that
`host.credential` is a live platform credential of the token's device session
and that `azp` names a live public credential of an active trusted
application. Everything else about the row is checked as today. A token with
`host`:

- is refused by every `/session/device/*` route (`403
  app_token_device_access_denied`, as third-party tokens are): no directory,
  no switch, no sign-out, no mint, no background credential;
- joins no `device:<id>` room;
- is answered by `GET /session/validate-header/:id` with its
  `applicationId` and `platform`.

**2.5 Revocation.** An application token is dead when any of these is: its
session (sign-out from anywhere, ADR 0029 D2), its platform credential (OxyOS
ADR 0020 decision 5's Remove, Oxy's device list, sign-out-all), or its
application's trust (read live, as `isTrustedApplication` is). Ending a
platform credential goes through the one choke point of
[tokens-and-credentials.md](../auth/tokens-and-credentials.md) and is
announced, so an `OxyServer` cache drops the entries minted under it. There is
no per-application revocation a person manages: ADR 0049 has no app grants.

**2.6 Rate limits and audit.**

- The route has the mint's IP limiter (`hashedIpKey`), 120 mints per 15
  minutes per platform credential, and 12 per 15 minutes per credential and
  application (a 5-minute token needs three).
- Each mint is logged with the platform, the platform credential id, the
  application id and the device id — never the account, the secret or an IP.
- Every request then carries `azp` and `host` on `req.oxyToken`, so usage,
  inference attribution and logs name the application and the platform that
  vouched for it.

**2.7 What it amends, and why ADR 0045's rejection still holds.**

- **ADR 0029 D1** ("every Oxy app starts signing in … from its own account
  dialog"): on a host, the platform's account UI. It is still the services
  dialog, so `@oxy.so/services` remains the sign-in everywhere.
- **ADR 0029 D2** ("every official app holds its own credential for it"): on a
  host, the platform is the one holder and applications hold no credential.
  Signing in, switching and signing out stay one shared act; phones and plain
  browsers are unchanged.
- **ADR 0045** gains `platform: 'oxyos' | 'astro'` for
  `POST /apps/assertions`, whose proof is the bearer itself: a token with
  `host` gets an assertion for its `azp` application and its `host.platform`
  only. Services still read the app only from the assertion.
- **ADR 0050 decision 2** ("the application comes from the session row … never
  from a claim"): also from a host token's `azp`, which 2.4 has checked against
  the registry and the platform credential.
- **ADR 0050 decision 3**: `sharedSessionAttribution` becomes a set,
  `'public_client_id' | 'platform'`, so terms accept host tokens by review. A
  `oxy_session:<client id>:` presentation with a host token must equal its
  `azp`. Plain-browser sessions keep the public client id.

ADR 0045 rejected **per-app sessions**: one session row per app, each signed
in, switched and signed out alone. An application token is not one: it is a
5-minute view of the ONE shared session, the same `sid`, revoked with it. ADR
0029 is not reversed, and the rejection stands. The issue #937 BFF stays the
possible end state for plain browsers; a platform is a client-side holder, not
a gateway.

**2.8 The security reasoning.** The server cannot prove which process asks. It
believes the platform's attestation for one reason: **the platform already
holds the device credential, so believing it gains the platform nothing.** It
could mint the device's unnamed token, which every own API accepts. What the
mint adds is the opposite: a smaller credential for the application — no
device secret, no device management, five minutes, one application's name.

What a liar gains is the name. A process that signs in naming OxyOS's public
client id gets a platform credential for its own account and can mint tokens
named for any own app, for that person only. The confined-agent check (ADR
0044) reads that name through the assertion, so the forger opens app X's
confined agent as themselves, with their own data and credits. That is the
same bound ADR 0045 accepts for a forged web `Origin`, and the same as ADR
0050's for spend. The assertion's `platform` says which kind of vouching it
was, so a service that later needs more can refuse `oxyos` and `astro`.

The gain is concrete. On OxyOS an application holds nothing it can keep. In
Astro an XSS on an Oxy site reads no device secret from `localStorage` (there
is none), only what the page could ask for while it runs.

### 3. What the platforms implement

**The SDK host contract** (decision 1). Both platforms implement
`OxySessionHost`: a token cached per application and refreshed about a minute
before its `exp`, the snapshot, and the four requests, each shown as the
platform's own UI.

**OxyOS.**

- **`oxyos-accountd`** obtains a platform credential at setup (OxyOS ADR 0020
  decision 4) and mints application tokens (2.2) from it. It serves them on a
  socket, identifying each peer with `SO_PEERPIDFD`. It answers a peer only
  when:
  - its uid is the Unix user of the account asking (OxyOS ADR 0020
    decision 1);
  - its pidfd matches a launch registration.

  Anything else — a process the session did not launch, another user, a child
  of a launched process — gets no token. It pushes snapshot changes: signed
  out, account removed, profile changed, online or offline. If it is down,
  applications have no token (OxyOS ADR 0020 decision 7).
- **`oxyos-session`** registers each launch with `oxyos-accountd`:
  `(pidfd, desktopEntryId)`, from its launcher, at the same moment as the
  launch record. `oxyos-accountd` accepts registrations only from the logind
  session's own `oxyos-session` process, verified by its pidfd and executable.
- **The Bloom host** exposes the socket to JavaScript as an `OxySessionHost`
  and registers it before the bundle runs, as it registers Bloom's platform
  adapter (OxyOS ADR 0015 decision 1).
- **Its UI.** `sign_in` shows the login screen's re-authentication when the
  credential stopped working. `switch_account` shows the login screen (OxyOS
  ADR 0020 decision 5). `sign_out` and `manage_account` open Settings.
- **The kernel.** The session runs with Yama `ptrace_scope` ≥ 1, so a launched
  application cannot attach to `oxyos-session` or a sibling and take its
  token. Until applications are sandboxed (#35, #36) that is the whole of the
  isolation between them.

**Astro.**

- Its own session uses a platform credential (`platformHost: 'astro'` on
  Astro's application).
- **Verified Oxy web apps.** Astro injects the host into a main frame only
  when:
  - the frame's committed origin — read in the browser process, never from
    the page — is exactly one of an own application's `webOrigins`, from the
    registry's public list, refreshed;
  - the frame is over `https`;
  - the window is not private.

  No iframe or worker gets it, and no third-party site does: they keep OAuth.
  The server re-checks the origin at the mint.
- The origin sent to the mint is the one Astro read. A token is delivered only
  to the document that asked, while its origin is still that origin.
- `request()` needs transient user activation (ADR 0029 D4: every window
  opens from a press) and opens Astro's own account dialog. One sign-in in
  Astro signs in every hosted Oxy site; a switch there reaches each one as a
  snapshot.

### 4. Offline

On OxyOS the person signs in offline (OxyOS ADR 0020 decision 2), and their
applications open with no network:

- **The snapshot works offline.** `oxyos-accountd` keeps the account's id,
  handle, name and picture from its last online read, so the SDK reports the
  person as `signed_in`, `online: false`. An application shows what it cached
  itself, keyed by that account id: no other account's data shows.
- **No private API offline.** `getAccessToken` returns null, `tokenStatus` is
  `missing` and `canUsePrivateApi` false. Nothing is minted offline and no
  token is made longer for offline use. A token minted before the network went
  stays valid only to its `exp`, five minutes at most.
- **Reconnecting.** The first private request after it triggers the refresh
  handler, and the host mints. A mint the server refuses (the session revoked
  or deleted meanwhile) is OxyOS ADR 0020 decision 2's revocation: the platform
  signs the person out, and every application sees `signed_out`.
- **Past the session's 7-day idle window.** The row expires on the server, and
  the next mint answers `no_active_session`. The platform then re-establishes
  the session at the next online sign-in, through the password check it
  already makes (`POST /auth/signin/password` with the device proof). An
  account with an authenticator is asked for the code then.

Astro is a browser: offline, hosted pages have the same null token and their
own caches.

### 5. Migration and versions

Each step deploys before the next starts. Packages are versioned; nothing here
is published by hand (Release packages publishes a merged bump).

0. **Prerequisite fix (api).** `POST /session/device/token` returns, as
   `expiresAt`, the session row's sliding expiry (`session.expiresAt`, up to 7
   days) where `deviceTokenMintResponseSchema` documents the access token's.
   `warm-token-plant` trusts it, so a cold boot can plant an expired token and
   heal only on the first 401. The mint returns the JWT's `exp`; no contract
   change. A host's token cache (decision 3) depends on it.
1. **`@oxy.so/contracts` (minor).** The mint's request and response, the
   `host` claim, the assertion platforms `oxyos` and `astro`, the registry
   fields `platformHost` and `oxyos.desktopEntryIds`, and
   `sharedSessionAttribution` as a set.
2. **api.**
   - The `pre` migration on `device_credentials`.
   - The registry fields in the staff lane.
   - The platform-credential issuance.
   - `/session/device/app-token`.
   - Verification (2.4), the `/session/device/*` refusal and the socket rule.
   - The assertion lanes and the revocation announcement.
   - ADR 0050's attribution.
3. **`@oxy.so/core` (minor), then `@oxy.so/services` (minor),** the latter's
   core range raised to it.
   - Core: `@oxy.so/core/host`.
   - Services: the provider's host mode.

   Additive: an app picks it up by upgrading and changes no code; with no host
   registered, nothing changes.
4. **OxyOS.**
   - `oxyos-accountd`'s platform credential and socket.
   - The launch registration.
   - The Bloom host's binding.
   - Registry rows for each application it ships.
   - Shipping only application bundles built with services ≥ step 3. Until
     sandboxing this is review, not enforcement.

   This closes OxyOS ADR 0020 decision 6's "until then".
5. **Astro.**
   - The platform credential for its session.
   - Its own Kaana calls on a token minted for itself, named by `azp` instead
     of `oxy_session:` (its terms gain `'platform'`).
   - The host in verified origins.
6. **Docs.** [tokens-and-credentials.md](../auth/tokens-and-credentials.md)
   ("`azp` present only on an application's own session"),
   [SESSION-ARCHITECTURE.md](../SESSION-ARCHITECTURE.md) and
   [desktop-public-clients.md](../auth/desktop-public-clients.md), whose Tauri
   WebKit shell OxyOS has retired.

**Phones and plain browsers.** Unchanged by this ADR:

- Phones keep the shared keychain and Android's `OxyDeviceSession` host, which
  hand siblings the device secret. Apps prove themselves with ADR 0045's Play
  Integrity and App Attest.
- Plain browsers keep the bridge (ADR 0029 D2) and tokens without `azp`.

## Alternatives rejected

- **Hand applications the device credential** (today's phones): an
  application could then mint for every account on the device and manage it,
  for as long as the device lives. OxyOS ADR 0020 decision 6 forbids it.
- **Hand applications the device's own token:** no application name, so ADR
  0050 needs the public-client-id presentation. And ADR 0044's confinement
  needs an assertion the platform cannot obtain for another app.
- **Per-app sessions** (ADR 0045's rejection, the BFF of issue #937): each app
  signs in, switches and signs out on its own, which reverses ADR 0029.
- **An app-chosen `sessionMode: 'host'`:** the application would have to know
  which platform it is on, and one build could not serve a plain browser and a
  host (OxyOS ADR 0015).
- **The application's own attestation on desktops** (ADR 0050's option a):
  Linux and Windows have none. The platform is the only party that knows which
  process asks.
- **An audience per application:** own apps call one another's backends and
  Kaana (ADR 0049); a token for one would be refused by the rest.

## Consequences

- On OxyOS and in Astro a person signs in once, to the platform, and every own
  application is signed in. On OxyOS no application holds a credential that
  outlives five minutes.
- `azp` on a host token is as strong as the platform that vouched for it, and
  says which one (`host.platform`). On OxyOS, until applications are sandboxed,
  it names cooperating processes of one Unix user; it is not a wall between
  them.
- The mint is new load: one request per running application every four
  minutes or so, instead of one shared mint.
- An application bundle on OxyOS built with an older SDK still contains its own
  sign-in; only review keeps it off the image until sandboxing.

## Enforcement (when implemented)

- **API tests.** A mint:
  - is issued only to a platform credential of the attested kind;
  - only for a trusted, active application recognised by its desktop entry
    id or exact origin;
  - never for auth.oxy.so's application or a third party;
  - never to a holder credential that is not a platform's, or to a request
    with a web `Origin`.

  A host token is refused by every `/session/device/*` route and joins no
  device room. It dies with its session, its platform credential and its
  application's trust. A token with `azp` and no `host` on a shared session is
  `client_mismatch`.
- **Assertion tests.** A host token gets an assertion for its own application
  and platform only.
- **Kaana grant tests.** A host token is attributed to its `azp` only under
  terms that accept `'platform'`.
- **SDK tests.** With a host registered:
  - no store write, no cold boot, no bridge, no `/session/device/*` call;
  - a revision change drops the token before the new account is published;
  - an unknown contract runs signed out;
  - `signIn`, switch and `logout` only call `request`.
- **OxyOS scenarios.**
  - A launched application gets a token named for its desktop entry.
  - A process the session did not launch, and one of another user, get
    nothing.
  - Offline, the snapshot is signed in and the token null.

## Open questions for the owner

1. The token's life: 5 minutes (proposed) or the access token's 15.
2. Whether a platform credential may be bound to hardware later: a TPM key on
   OxyOS, or App Attest where macOS allows it. Astro on Linux and Windows has
   nothing to bind it to.
3. Whether helper processes of a launched OxyOS application (children), and
   service workers in Astro, should get their application's token. Proposed:
   no.
4. Whether auth.oxy.so and third-party "Sign in with Oxy" inside Astro should
   use Astro's session, so a person signs in once in Astro for OAuth too.
   Proposed: no, for now.
5. Phones: whether Android's `OxyDeviceSession` host becomes a token broker.
   It would identify callers by their Binder uid's package and certificate, and
   siblings would stop receiving the secret. iOS has no such broker.
6. Plain browsers: whether a web app's own mint should name it by its `Origin`
   (attribution only, since it still holds the secret).
7. The 7-day idle window against a machine that stays offline longer: whether
   a re-established session at the next online sign-in (decision 4) is enough,
   or a platform credential's session should idle longer.
