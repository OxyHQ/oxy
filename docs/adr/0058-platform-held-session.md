# ADR 0058 — The platform holds the Oxy session; applications get tokens for themselves from it

- Status: accepted (2026-11-06). The server half is implemented: step 0, step 1
  (`@oxy.so/contracts` 6.13.0) and step 2 (oxy-api: migrations 0236–0238, the
  platform credential, `POST /session/device/app-token`, verification, the
  `oxyos` and `astro` assertion lanes, ADR 0050's attribution set), with the
  registry rows of step 4 in the canonical seed. Step 3's host (decision 1) is
  in `@oxy.so/core` 7.34.0 and `@oxy.so/services` 14.11.0 (#2199). Step 4
  (OxyOS) is being built against the contracts below; step 5 (Astro) has not
  started.
- Date: 2026-10-30; accepted 2026-11-06; amended 2026-11-08 (R6, the QR
  approval issues the platform credential; R7, a QR redemption repeats with
  its key; R8, a platform confirms the credentials it receives); 2026-11-09
  (R9, the QR's redemption tells its window; R10, the snapshot carries the
  account's languages)
- Decided by: the owner (product direction, 2026-10-30). The open questions
  were resolved, and the mechanism refined, under the owner's delegation on
  2026-11-06 (see "Resolved questions" and "Refinements made in accepting it")
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
  account: {
    id: string;
    handle: string;
    displayName?: string;
    avatar?: string;
    languages?: string[];                 // R10
  } | null;
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
- The language (ADR 0022) comes from the snapshot's `account.languages` when
  it carries them, from the first render (R10).

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
through the staff application-administration lane (or the canonical seed), on
an Oxy (trusted) application. `device_credentials` gains `platform` and
`platform_application_id` (nullable; `pre` migration). A platform credential is
not evicted by the 32-holder cap. It is never issued to a browser page: the
bridge's join and every request carrying a web `Origin` are refused it. On
OxyOS it is the device credential `oxyos-accountd` holds (OxyOS ADR 0020
decision 4's setup obtains it, R1 below); Astro obtains one for its own session
(decision 5). How the sign-in names the platform, what promotion retires, and
the one-session rule are R1.

**2.2 The mint.** `POST /session/device/app-token`, public like
`/session/device/token` (no bearer, possession is the proof), answering only
requests with no web `Origin`:

- in: `{ deviceId, deviceSecret, accountId?, clientId?, attestation }`, where
  `attestation` is `{ platform: 'oxyos', desktopEntryId }`,
  `{ platform: 'astro', origin, clientId }`, or `{ platform, self: true }` for
  the platform's own application (`platform_application_id`, which needs no
  recognition in step 4 beyond still declaring that platform). `clientId` is
  optional (R2);
- out: `{ data: { accessToken, expiresAt, applicationId, accountId } }`, the
  `data` envelope of every `/session/device/*` answer, `expiresAt` being the
  token's own `exp`.

It mints only when, in this order, each check reading live rows:

1. the secret proves a platform credential of that device (the same lockout
   scope as `/session/device/token`: a wrong secret counts toward it);
2. the credential's `platform` equals the attestation's;
3. the attestation names an application: the registry's
   `oxyosDesktopEntryIds` (new, staff-written, beside ADR 0045's fields; the
   `application_oxyos_entries` table, one id naming one application) holds the
   `desktopEntryId`, or the `webOrigins` of the application whose `clientId`
   the Astro attestation names contain the `origin` exactly, or `self`;
4. that application is active and `isTrustedApplication` (ADR 0049's
   first-party) with a live `public` credential — the one `clientId` names,
   when given, or its production client; a third-party application gets
   nothing here and keeps OAuth's isolated session. auth.oxy.so's application
   (the one declaring auth.oxy.so's origin) is never minted for: it is the
   identity carrier and keeps its own device;
5. the device has a live session for the active account (or for `accountId`,
   which pins as `/session/device/token` does and refuses as
   `account_not_on_device`).

A miss is one refusal per step, reusing the existing codes: step 1
`invalid_device_secret` (an ordinary holder's secret too); steps 2 to 4 the one
generic `application_not_recognised`; step 5 `no_active_session` or
`account_not_on_device`; a web `Origin` `browser_not_allowed`; a malformed body
`invalid_request` (`@oxy.so/contracts` `DEVICE_APP_TOKEN_ERROR_CODES`). Nothing
names an account, and no step takes an identifier a person typed.

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
  `azp`. Plain-browser sessions keep the public client id. Implemented; no
  relationship's terms accept `'platform'` yet (Astro's are
  `['public_client_id']` until step 5 reviews them).

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
  handle, name, picture and languages from its last online read, so the SDK reports the
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

## Refinements made in accepting it (2026-11-06)

Each is binding; the platforms' implementations code against them.

**R1. How the platform credential is issued (2.1).** The sign-in that names the
platform is the platform service's own: its password sign-in, or, since
2026-11-08, its redemption of the QR approval the setup client just claimed
(R6). Never the setup client's own sign-in. `POST /auth/signin/password`, and
`POST /auth/signin/second-factor`
completing it, accept an optional `platformClient: { platform, clientId }`.

- It is honoured only when the request carries no browser context (`Origin` or
  `Sec-Fetch-Site`) and `clientId` is a usable public client id of an active
  trusted application whose registry entry declares `platformHost` equal to
  `platform`. Anything else is refused with the ordinary invalid-request answer
  (the 400 `validate` gives a body that is not the contract's) BEFORE any
  account lookup, lockout reservation or password work. It depends on nothing
  the person typed, so a known and an unknown identifier get the same answer
  and the same work, and neither counts toward a lockout
  (`services/platformClient.service.ts`).
- When honoured, the holder credential issued is a platform credential
  (`platform`, `platform_application_id`).
- **Promotion retires the proof.** When the sign-in carries a valid device
  proof, the proving credential's row is deleted in the same transaction that
  creates the platform credential (`issuePlatformCredential`). The secret the
  setup client's JavaScript saw dies; the only live secret is the one the
  platform service alone received. A platform signing in again with its
  platform credential rotates it the same way.
  The setup client's credential may come from any of the SDK's ways in: the
  email's code or link, a password, or the Commons QR approved on a phone (a
  claim, `POST /auth/session/claim`, issues the claiming device's holder
  credential like any other sign-in). Whichever it was, the platform's
  password sign-in then proves it and retires it (2026-11-07); a QR claim's
  credential is redeemed without any password instead (R6, 2026-11-08).
- **One session per account.** A platform sign-in never reuses a session
  (`freshSession`): the new session replaces the account's session on the
  device (`addAccount` deactivates the one it displaces, through the one
  revocation choke point, announced), so whatever the setup client was handed
  dies with it, and repeated online password checks never accumulate sessions
  or holders.
- The second-factor challenge stores the platform client
  (`signin_second_factor_challenges.platform`, `platform_client_id`); the
  completing request must name the same one, or none for a challenge that named
  none, checked before the code is counted.
- A platform credential is never evicted by the 32-holder cap and never issued
  through the bridge.

**R2. The mint's application comes from the attestation (2.2).** On OxyOS the
server resolves the application from the desktop entry id (unique across
applications, like a web origin), so the mint's `clientId` is optional; when
given it must name the same application. `self: true` mints for the
credential's `platform_application_id` (OxyOS itself: Settings, the shell; the
contract accepts it for Astro's chrome too). No web `Origin` is accepted at all.
Rate limits as 2.6: the hashed-IP limiter, 120 mints per 15 minutes per platform
credential and 12 per credential and application; a wrong secret counts toward
`/session/device/token`'s lockout.

**R3. The registry.** `application_recognition.platform_host`
(`'oxyos' | 'astro'`, NULL otherwise) and the table
`application_oxyos_entries (desktop_entry_id primary key, application_id)`,
with `desktop_entry_id ~ '^[a-z0-9]+([.][a-z0-9-]+)+$'`. Written by the staff
lane (`PUT /applications/:appId/recognition`: `platformHost` and
`oxyosDesktopEntryIds`, each left unchanged when a write omits it; a platform
host only on an Oxy application) and by the canonical seed
(`seedOxyApplicationsSpecs.ts` `platformHost`, `oxyosDesktopEntryIds`, added
never removed, as `webOrigins`). The seed rows: OxyOS `platformHost: 'oxyos'`,
its retired Tauri redirect `tauri://localhost` removed (the seed's new
`retiredRedirectUris`); Dropsea `so.oxy.dropsea`, Atlas `so.oxy.atlas`, Allo
`so.oxy.allo`, Oxy Inbox `so.oxy.inbox`. Production rows change only through the
seed workflow or the staff lane, after the migration deploys. ADR 0059
(proposed) asks for ONE OxyOS identity per application; this table allows
several but every seeded application declares one, and ADR 0059 decision 1 may
narrow it.

**R4. Revocation and removal use existing routes.** The platform service ends a
device by minting the device's own token with the platform credential
(`POST /session/device/token`, `accountId` pinned: a platform credential still
mints it) and calling `POST /session/device/signout` `{ all: true }` with it.
It detects a revocation by that mint answering `no_active_session` or
`invalid_device_secret`.

Every path that deletes a platform credential (promotion, sign-out-all, a device
ended with nobody signed in) also ends the sessions its tokens were minted for,
or the session is replaced by the sign-in that retired it (R1), so the
announcement 2.5 asks for rides the existing per-session revocation feed; the
credential itself is re-read on every request (2.4).

**Other facts of the implementation.** Step 0's fix is in the device mint lane
(`resolveTokenForSession`: `/session/device/token`, `/background-token` and the
activation's token answer the JWT's `exp`); the sign-in responses keep their
`expiresAt`. `GET /session/validate-header/:id` answers an application token
with `host: { applicationId, platform }`. The holder evidence route
(`/session/device/context-evidence-v1`) answers an application token
`unsupported_bearer`, its own contract's refusal. Outside `/session/device/*`,
every route that ends, lists, renames or creates sessions or devices refuses an
application token with the same `app_token_device_access_denied`
(`refuseApplicationToken`: session listing and sign-out, `/devices`, the
managed-account switch, approving a sign-in elsewhere, OAuth and MCP
authorization, MCP grant revocation), and so do the account-level writes behind
`requireFirstPartyDeviceAccess` (sign-in methods, linking, keys, families,
deletion): signing out and managing the account are the platform's (decision 1).

**The platform's own Settings is the account UI on a host (2026-11-06).**
Decision 1 gives the account graph's writes to the platform's Settings, and
Settings is the platform's own application: its token is a `self` application
token, whose `azp` is the platform credential's `platform_application_id`
(`req.oxyToken.host.self`). As a Mac's System Settings changes the Apple
Account's password, a `self` token may make the account's own security writes
behind `requireFirstPartyDeviceAccess`, through `requireAccountSecurityAccess`:
reauth, the password (set, change, remove), the authenticator (enrol, confirm,
disable, backup codes), the email change and the sign-in methods. Each keeps
its reauth freshness rule unchanged, and a write that signs out the account's
other sessions keeps the acting session, which for a `self` token is the
platform's own (the session its `sid` names), so the machine stays signed in and
every application token minted from it survives. Everything else stays refused
for every application token, `self` included: account deletion, Commons and auth
linking, agent keys, organization identity keys, identity proofs, families, and
all session and device management. Another application's token is refused on
the security writes too. On OxyOS a password changed this way reaches the
machine's verifier through OxyOS ADR 0020's online check: at the next unlock
with the new password the local check fails, Oxy accepts it, and the verifier
is replaced. `checkAccessTokenBinding`
refuses `host` (`host_not_accepted`) unless its caller re-checks it live
(`validateSession` and the realtime-recipient proofs do,
`hostTokenAuthority.service.ts`), so a lane written before this ADR cannot
believe an application token by accident.

**R6. The QR approval issues the platform credential (amended 2026-11-08, by
the owner).** Oxy signs a person in on a new device by approval, not by a
secret typed into it: the device shows a QR, an identity the person already
holds (Commons' key, or a signed-in session) approves it, and the device claims
the approved request. That is the authentication, and an account may have no
password at all (a Commons account has none by design). So a QR sign-in on a
platform is entirely passwordless, and R1's password sign-in cannot be the only
way the platform service gets its credential: it is the way for a password
sign-in, and this is the way for a QR sign-in, for every account, whether or
not it has a password.

`POST /session/device/platform`, public like `/session/device/token` (no
bearer; the proof is the credential):

- in: `{ device: { deviceId, deviceSecret }, platformClient: { platform,
  clientId } }`;
- out: the password sign-in's answer (`LoginResult`), its `deviceSecret` the
  platform credential.

`platformClient` is resolved first, exactly as on the password sign-in (no
browser context, an active trusted application declaring that `platformHost`),
and an unhonoured one is the ordinary 400 before anything is looked up. The
proof is the holder credential a device-sign-in claim issued; the claim records
it on the request it answers (`auth_sessions.claimed_credential_id`, migrations
0246–0247). It is redeemable only when, in one transaction holding the device's
row lock, every one of these holds on live rows:

1. the secret proves a live ordinary holder credential of that device;
2. it is the credential a claim recorded, the request a `device_sign_in`,
   `consumed` less than ten minutes ago;
3. the request was started by the application `platformClient` names, so a
   proof another client claimed (another platform, another app) is not
   redeemable by this one;
4. the approved account is still signed in on the device (a live device
   context), and is a personal, active account.

The proof is deleted in that transaction: spent once, so a replay or a racing
second redemption finds nothing. Every proof that is not redeemable is the same
401 `invalid_grant`, whichever check failed, so the route says nothing about
which devices, credentials or accounts exist. What is issued is exactly what
the password sign-in issues (`mintSignInSession` with the platform client): a
fresh session replacing the setup client's, and a platform credential with its
rotation and revocation; revoking the device or the account revokes it. If
issuing fails after the proof is spent, the redemption fails closed and the
setup starts again with a new QR (unless it was keyed: R7).

Budgets: per hashed IP (20 in 15 minutes); per device id as sent, counted
whether or not it exists (5 in 15 minutes); per account, asked once the proof
is known to sign it in and before it is spent (10 in 15 minutes). Each
redemption is logged with the account, the device id's prefix, the platform
and the application, never a secret; the session's sign-in is recorded as
every sign-in is.

**R7. A QR redemption repeats with its key (amended 2026-11-08, by the
owner).** R6 spends the proof once, and the platform cannot always finish its
own side in the same breath. On the owner's ThinkPad (2026-11-08) OxyOS's
`oxyos-accountd` redeemed a QR's proof, then could not make the account's user
(a home directory it could not write), undid it, and ended the platform
credential it had just been issued; the person's retry was refused, because
the proof was spent, and the QR had to be scanned again. An answer lost on the
way (the redemption committed, the connection dropped) would end the same way.
The rule: **a QR is never scanned twice for a transient failure.** The
platform orders its own setup so that what can fail locally fails before it
redeems (OxyOS ADR 0020), and keeps a credential it was issued while it
retries; what is left is a redemption whose answer never arrived, or whose
issuing failed after the proof was spent. For those, a redemption may be
repeated, without weakening R6 for anyone who holds only the proof.

- in: R6's body and, optionally, `redemptionKey`: at least 256 random bits,
  base64url, 43 to 128 characters (`@oxy.so/contracts` 6.22.0,
  `redemptionKeySchema`). The platform SERVICE chooses it for one setup and
  never shows it to its setup client: the client's JavaScript saw the proof,
  never the key.
- The first redemption still deletes the proof's credential (the setup client
  holds nothing that works afterwards, and no credential lookup changes). The
  redemption is recorded on the claim instead (`auth_sessions`, migrations
  0248–0249): the proof's hash, the device it was redeemed on, the key's hash
  (none when no key was sent), the attempt number and the platform credential
  the latest attempt issued.
- A later request with the same proof AND the same key, on the same device,
  for the same application, within the claim's ORIGINAL ten minutes, the
  account still signed in there and active, is a repetition: it re-issues,
  exactly as the first redemption did (a fresh session replacing the account's,
  one session for the account), and revokes the platform credential the
  previous attempt issued, whose answer may have been lost.
- Only the latest attempt issues. Each redemption (first or repeated) numbers
  itself on the claim under the device's row lock; issuing checks, under the
  same lock, that its attempt is still the latest, so an earlier request still
  in flight issues nothing (it fails as an issuing failure, 500: its caller has
  already repeated it). At most one platform credential from a redemption is
  ever live.
- Everything else is R6's one refusal, 401 `invalid_grant`: a spent proof
  without a key, with another key, from a redemption that sent no key, outside
  the window, for another client or device. So whoever saw only the proof (the
  setup client, or anyone who read it there) gains nothing, and nobody learns
  whether a key exists. A proof stolen BEFORE the first redemption can be
  front-run exactly as under R6; the key does not change that.
- Budgets are R6's and count every attempt, repetitions included (per device id
  5, per account 10, per hashed IP 20, in 15 minutes): a platform retries a
  transient failure a few times, with backoff, and an `invalid_grant` on a
  repetition means the person signs in again (R8 changes these budgets).

**R8. A platform confirms the credentials it receives (amended 2026-11-08, by
the owner).** R7 left two ways for a setup to fail that a retry cannot mend.
First, a platform credential whose answer was lost, by every route that issues
one, stayed live with nobody holding it: every repetition after it failed and
the setup was abandoned, or a password route's answer (the setup's, or the
online check's rotation) never arrived, so the account stayed signed in on a
device nothing held. A lost rotation answer was worse: Oxy had already deleted
the credential the machine still held, so the machine was signed out. Second,
a 429 on the redemption ended the setup: R6's budgets counted every attempt,
proven or not, over fifteen minutes, longer than the QR's ten.

- **Opt-in.** `platformClient` takes `confirms: true` (`@oxy.so/contracts`
  6.23.0), on all three routes that name it (`POST /auth/signin/password`,
  `/auth/signin/second-factor`, `/session/device/platform`). A platform that
  sends it confirms what it receives; one that does not is served exactly as
  before R8, so platforms deployed before it keep working. Once every deployed
  platform confirms, `confirms` becomes required (deferred: it waits for the
  OxyOS builds that confirm to replace those that do not).
- **Pending.** For a platform that confirms, the platform credential is issued
  PENDING (`device_credentials.pending_until`, migrations 0250–0252): until
  the claim's window ends (its `consumed_at` plus ten minutes) on the
  device-proof route, or ten minutes after the sign-in on the password and
  second-factor routes. A pending credential proves nothing and mints nothing:
  every lookup excludes it (`/token`, `/app-token`, the device state, the
  holder evidence, the join code, host-token verification, the credential
  count of third-party revocation); its only use is its confirmation. The
  credential the sign-in's device proof presented is NOT deleted when it is
  issued but recorded as the one it replaces (`replaces_credential_id`): the
  setup client's credential on the password route, or the machine's own
  platform credential on a rotation. So a lost answer leaves the old
  credential working, never a new one nobody holds. The device-proof route
  still spends its proof when it redeems (R6, R7): its credential replaces
  nothing.
- **`POST /session/device/platform/confirm`** `{ deviceId, deviceSecret }`:
  public, as `/token` is, with no bearer. The credential itself is the proof.
  In one transaction holding the device's row lock, a pending, unexpired
  platform credential of that device is confirmed (`pending_until` cleared)
  and the credential it replaces is deleted. It answers 200
  `{ confirmed: true }`. A credential already confirmed gets the same 200
  (idempotent: a platform whose confirmation answer was lost confirms again).
  Every other proof (unknown, expired, an ordinary holder's, another device's)
  gets one identical 401 `invalid_grant`.
- **Expiry.** An expired pending credential is absent to every lookup, as it
  was never issued. A sweep (`sweepUnconfirmedPlatformCredentials`, every
  minute) deletes it. If the device is then left with nothing holding it, the
  sweep signs the device out (`signout`, every account). Nothing holding it
  means no confirmed or ordinary credential, no pending one still in its
  window, and no live background secret. So an account is not left signed in
  on a device whose setup never finished. No platform ever has to "redeem to
  revoke".
- **What is listed.** A credential is never listed anywhere a person sees
  their devices: device and session lists show devices and sessions. The
  device and the session a redemption touches existed since the QR's claim
  (the setup client's sign-in), as they did before R8. What R8 adds is that a
  device whose setup never confirms stops being signed in once its window
  ends, instead of staying listed until its sessions idle out.
- **Repetitions (R7) unchanged.** A keyed repetition still revokes the
  credential the previous attempt issued, pending or confirmed. A claim's
  proof has at most ten redemptions, the first included; after that it is
  the same 401.
- **Budgets against guessing, never against a proof.** Each window is now the
  QR's own ten minutes, so no Retry-After outlasts a claim (each is at most
  600 s). Each rate per minute is at least as strict as before:
  - per hashed IP: 13 refusals in ten minutes, against 20 in fifteen (1.3 a
    minute against 1.33);
  - per device id: 3 in ten minutes, against 5 in fifteen (0.3 against 0.33);
  - per account: 6 first redemptions in ten minutes, against 10 in fifteen
    (0.6 against 0.67).

  A request that proves something is not a guess:
  - the IP limiter counts refusals only;
  - a redemption whose proof was real gives back its device-id attempt (one
    attempt, never the whole count, so a guesser's failures still lock
    whatever proven requests come between them);
  - a repetition whose proof and key match a recorded redemption (two 256-bit
    secrets, hash lookups only) is budgeted by neither device id nor account,
    so a device id locked by guesses still answers the platform that holds
    them.

  Every other request is counted before any proof is looked up, exactly as
  before. Guesses therefore lock at the same count or sooner, a locked device
  id still refuses every wrong secret, and the confirmation route has the same
  budgets (per hashed IP and per device id, refusals only, ten minutes).
  OxyOS waits out a 429 that fits in the QR's window and signs in again
  otherwise.
- **The password route too.** Confirming applies to the password and
  second-factor routes as to the device-proof route, for the same reason. A
  lost answer there orphans a platform credential the same way, and a lost
  rotation answer used to sign the machine out. One rule for every route that
  issues a platform credential.

**R9. The QR's redemption tells its window (amended 2026-11-09, by the
owner).** R8 left the platform to guess when the QR's ten minutes end: OxyOS
counted them from its own setup's start, later than the claim, so a wait it
allowed could outlast the real window, and one it refused could have fitted.
The server knows the end (the claim's `consumed_at` + ten minutes), so it says
it, wherever the answer concerns a proof it knows:

- **What it says.** `POST /session/device/platform`'s 200 carries
  `redemptionWindow: { expiresAt, expiresInSeconds }`, the claim's end, and,
  to a platform that confirms (R8), `confirmWindow` in the same shape, when
  the pending credential it issued must be confirmed by (today the same end:
  the credential is pending until the claim's window ends). A keyed
  repetition's 200 says the same end, counted down. The 429 of the account's
  budget, asked once the proof is known to sign that account in and before it
  is spent, carries `redemptionWindow` beside its `Retry-After`
  (`@oxy.so/contracts` 6.24.0, `devicePlatformWindowsSchema`).
- **What it never says.** A refusal of a proof that is not redeemable stays
  the one identical 401: nothing in it tells proofs apart. The 429s of the
  device id's and the IP's budgets, asked before any proof is looked at, carry
  no window either, since there is no proof known to them to tell.
- **How it is counted.** `expiresInSeconds` is the server's own count, in
  whole seconds, at the moment it answers. A platform measures it against its
  own monotonic clock from when the answer arrives, less a margin for the way
  back, so neither machine's clock setting matters; `expiresAt` is for logs and
  people.
- **The claim's answer** (`POST /auth/session/claim`, the SDK's) does not carry
  it: the setup client that claims never redeems, and the platform service
  that redeems never sees the claim's answer. Telling the client a deadline it
  has no use for would only be another field to keep right.
- **What a platform does with it** (OxyOS, ADR 0020's amendment): it makes no
  window decision before an answer has told it one (the first redemption just
  tries; a 429 without a window is waited out, its `Retry-After` at most
  600 s); once told, it waits for a 429 only if the wait ends before the
  window does, and otherwise asks the person to sign in again; it stops
  retrying a confirmation at `confirmWindow`'s end, though it may still ask
  once more, since a credential already confirmed is confirmed whatever the
  hour.

**R10. The snapshot carries the account's languages (amended 2026-11-09).**
An application that passes `OxyProvider`'s `language` (ADR 0022) paints
nothing until the account's language is known. Under the order of decision 1
that meant the boot token (a mint over the network, since a token lives five
minutes) and then a `GET /users/me` for the account's languages: on OxyOS,
Dropsea's local file list waited 1.4 to 9 s for them on a slow link, and stayed
blank while either could not be reached. The platform already reads that
profile online and keeps it for offline use, so it says the languages:

- **What it says.** `account.languages`, the account's locales, primary first,
  as the platform last read its profile; optional, contract 1 unchanged (a
  host that omits it keeps the old behaviour).
- **What the SDK does with them.** The language an app speaks is the
  snapshot's from the first render, offline too: `isAccountLanguageKnown` is
  true, and the language bridge waits for neither the token nor the profile
  read. Signed out, or `unavailable`, the guest or device language is likewise
  known at once. The account itself is still published only with its token,
  in decision 1's order; it carries the snapshot's languages until the app's
  own profile read (ADR 0022's read of the owner's preferences) replaces them,
  which a later snapshot does not undo.
- **What the platform does.** OxyOS's `oxyos-accountd` keeps the languages
  `/users/me` answers with the account's profile and puts them in every
  snapshot.

## Enforcement

- **API tests** (`routes/__tests__/platformAppTokens.db.test.ts`,
  `utils/__tests__/accessTokenV2.test.ts`). A mint:
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
  A platform sign-in issues a platform credential, deletes the proof's row and
  leaves one session for the account however often it repeats;
  `routes/__tests__/devicePlatform.db.test.ts` redeems a claimed QR end to end
  (create, approve on a phone, claim, redeem, mint an application's token) and
  refuses a replay, all but one of concurrent redemptions, another platform
  client's or a non-platform application's proof, a stale claim, an account
  signed out of the device or no longer active, a revoked credential, a
  browser, and a wrong secret, an unknown device and a password sign-in's
  credential, those three with one identical answer; an unhonoured
  `platformClient` is refused identically for known and unknown identifiers
  with no lockout reservation or password work; the second factor completes
  only with the same platform client. The same file repeats a keyed redemption
  (R7): the repetition re-issues and the first answer's credential no longer
  mints, one session for the account; a repetition without the key, with
  another, of a redemption that sent none, or outside the window is the same
  refusal as an unknown proof; a redemption whose issuing failed is completed
  by its key; a superseded attempt issues nothing, and concurrent keyed
  redemptions leave exactly one live platform credential. For a platform that
  confirms (R8), the same file shows:
  - the QR's credential is issued pending until the claim's window ends, and
    neither `/token`, `/app-token` nor the device-state lookups take it until
    it is confirmed;
  - the confirmation is idempotent, takes its body strictly and answers
    everything else with one refusal;
  - an expired pending credential is refused, swept, and its device signed
    out, while a device something still holds is not;
  - a repetition revokes the previous attempt's pending credential;
  - the password route keeps the credential it presented until the new one is
    confirmed, and a lost rotation answer leaves the machine's credential
    working;
  - a platform that does not confirm is served as before.
  The windows (R9): a 200 carries `redemptionWindow` (and `confirmWindow` to a
  platform that confirms) whose end is the claim's and whose seconds count
  down across a repetition; the account budget's 429 carries
  `redemptionWindow` and leaves the proof unspent; a proof that is not
  redeemable, spent or unknown, gets the same 401 body with no window.

  The budgets lock guesses at three per device id, let a keyed repetition
  through a device id locked by guesses (still refusing a wrong secret, with
  a Retry-After of at most 600 s), give a proven redemption's attempt back,
  cap a claim at ten redemptions, and count refused confirmations.
  `services/__tests__/loginLockout.service.test.ts` gives back one attempt,
  never more; `__tests__/scheduledSweeps.test.ts` shows the sweep scheduled.
- **Assertion tests.** A host token gets an assertion for its own application
  and platform only (the same file).
- **Kaana grant tests.** A host token is attributed to its `azp` only under
  terms that accept `'platform'` (`routes/__tests__/internalKaanaGrants.test.ts`).
- **SDK tests.** With a host registered:
  - no store write, no cold boot, no bridge, no `/session/device/*` call;
  - a revision change drops the token before the new account is published;
  - the snapshot's languages are the app's language before the token (R10);
  - an unknown contract runs signed out;
  - `signIn`, switch and `logout` only call `request`.
- **OxyOS scenarios.**
  - A launched application gets a token named for its desktop entry.
  - A process the session did not launch, and one of another user, get
    nothing.
  - Offline, the snapshot is signed in and the token null.

## Resolved questions (2026-11-06, under the owner's delegation)

1. The token's life: **5 minutes**.
2. Binding a platform credential to hardware (a TPM key on OxyOS, App Attest
   where macOS allows it): not now; a later ADR.
3. Helper processes of a launched OxyOS application (children), and service
   workers in Astro: **no token**.
4. auth.oxy.so and third-party "Sign in with Oxy" inside Astro: not Astro's
   session, for now.
5. Android's `OxyDeviceSession` as a token broker: out of scope here.
6. Plain browsers naming a web app by its `Origin` at its own mint: no.
7. The 7-day idle window against a machine that stays offline longer: the
   session re-established at the next online sign-in (decision 4) is enough.
