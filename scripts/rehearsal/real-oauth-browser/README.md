# Real local OAuth browser fixture (I11)

This prepares the full actual Oxy API router and Socket.IO server, PostgreSQL17,
the real auth frontend and two registered third-party relying parties. It uses
candidate workspace packages, not a published registry release. Root operates
Chromium; no browser or Android identity is created by the launcher.

From the worktree root after frozen install and package builds:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -u scripts/rehearsal/start-real-oauth-browser.py
```

The output identifies a mode0600 manifest containing disposable account IDs,
registered public client IDs and the public fixture-only password. API17960,
IdP17961, RP-A17962 and RP-B17963 are all on127.0.0.1. The launcher accepts no
connection overrides, creates and validates its own PostgreSQL5589 process,
applies normal migrations fresh and again, and scrubs environment variables
and disables Bun dotenv loading in every phase. API explicit dotenv loading
runs only from an empty owned directory. Interrupt parent or its group for
ordered teardown; API and frontend children own separate groups. A forced child
stop is recorded separately. Database is stopped after child cleanup.

The API seeds accounts, passwords through actual scrypt service, one admin
organization membership and public application registration. It does not mint
a session, create a consent, replace middleware or fabricate API responses.
Bootstrap ecosystem seeds, workers and reconciliation loops are not started.
The full actual server routes, parsers, JWT/session middleware, rate limiters,
CORS/security/error handlers and authenticated sockets remain in place.
Fetch calls outside loopback are rejected; this is not an assertion that all
transitive Node transports are instrumented. The browser must reject unexpected
remote network requests too. No actual AWS/provider configuration is loaded.

Planned browser acceptance: fresh profile with zero cookies; explicit button on
RP-A; actual dialog password sign-in at IdP; real OAuth consent and PKCE exchange;
RP-B explicit sign-in and separate consent; unrelated account/subject negatives;
SDK account selector, isolated self logout and consent revocation readback. Use
SDK buttons/dialogs and existing APIs: never assign tokens or runtime state from
the browser driver. Record requests/statuses without token or device-secret data.

These third-party RPs prove isolated OAuth lifecycle, not WEB04 shared device
state across first-party holders. A separate first-party two-origin scenario is
required for switch/logout propagation. Registry consumer repetition and native
OAuth/SSO remain pending. The Android17check fixture only verified provider slot
storage/signature isolation and is not this acceptance.

WEB04 candidate preparation uses two additional registered trusted applications
at `http://127.0.0.1:17972` and `http://127.0.0.1:17973`. The reviewed registrar
accepts only the fixed `webFirst` and `webSecond` lanes, validates the already-owned
fixture database and its personal owner, and creates public application metadata
only. It creates no session, device credential or consent. Native clients retain
their original callback and registrations. The two RPs use this same public
`OxyProvider`, account dialog, sign-out and fresh `cache.clear()` / `users.me()`
probe; no application-local session coordination is added.

After registration, start only those two RPs, preserving the running API/IdP,
database and native Metros:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -u scripts/rehearsal/start-first-party-browser.py /absolute/owned/.integration-evidence/oauth1519-namespace/manifest.json
```

Root browser sequence: use a fresh Chromium profile with both origins in live
tabs and reject unexpected remote requests; explicitly sign in at the first RP
through the real SDK dialog. Verify its fresh API subject and the second holder's
canonical SDK adoption of that device session. Switch to the fixture organization
through the second RP's SDK account dialog; bring the first RP to the foreground
and verify both UI and fresh API subject become the organization. Sign out that
account and verify the remaining personal principal, then sign out the remaining
account and verify both holders are signed out and fresh profile reads are denied.
Record cookies on every participating origin, SQL session/device bindings and
status-only network observations. Never inject credentials to make holder adoption
pass; if SDK requires an explicit public button/restore action, record that exact
behavior and assess it against WEB04. Browser acceptance has not run at preparation.

Preparation failures retained in evidence: CommonJS top-level-await type errors;
Vite optimizer collision between origins; initial RP bundler missing Expo web
exports. Corrected configuration reuses the actual IdP's maintained RN-Web
plugins, with independent RP caches and a different entry/output only.
