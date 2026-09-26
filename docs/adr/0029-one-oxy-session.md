# ADR 0029 — One Oxy session: the dialog in every app, auth.oxy.so's window on the web

- Status: accepted; D1, D2 and D3 are implemented (the web account — username, passkey, recovery email — its recovery by email, its deletion with the passkey, and linking Commons from two devices; the browser bridge that shares one session across every Oxy web app); D4 is being built in follow-up changes
- Date: 2026-09-26
- Decided by: the owner (product direction), recorded here
- Changes: ADR 0028 D1b (Oxy apps went to auth.oxy.so in the same tab);
  ADR 0024 D3–D6 and D9 (every personal account created with a root), once D3
  below lands. Supersedes ADR 0003 (the browser hub), already deleted.
- Reverses, for passkey accounts only: "No email" in
  `docs/superpowers/specs/2026-09-15-one-identity-two-carriers-design.md`.

## Context

Signing in had too many paths for one account: a passkey run inside the dialog
on `*.oxy.so` and a trip to auth.oxy.so everywhere else, a browser hub behind
an unused flag, a web identity with a recovery phrase next to Commons', and no
shared session between Oxy apps on the web. The owner's direction: one system,
as simple for the person as "Sign in with Google".

Two browser rules shape it. A passkey belongs to one domain (RP ID `oxy.so`),
so mention.earth, alia.onl or willo.sh can never ask for it themselves — WebAuthn
Related Origin Requests admit five labels, and Oxy has more than a dozen apps.
And different domains share no cookie and no storage, so the only place a
browser's Oxy session can be shared from is one origin every app visits:
auth.oxy.so.

## Decision

### D1 — The dialog in every app; auth.oxy.so's window on the web

`@oxy.so/services` is the sign-in everywhere: every Oxy app starts signing in
and creating accounts from its own account dialog. auth.oxy.so renders the same
services screen on a page, and is the common point for third parties (OAuth),
MCP and the CLI.

- Native: the dialog is the whole screen (Commons, the QR, "Get Commons").
- Web, on every domain including `*.oxy.so`: sign-in happens IN the dialog.
  It is the split card — the Commons QR on the right (below `md`, "Continue
  with Oxy"), the passkey and "Create account" on the left. The passkey belongs
  to `oxy.so`, so that one step (and account creation) opens auth.oxy.so's
  window from the press (`useOxy().continueOnAuth(screen)`, `transport:
  'popup'`, `/authorize?screen=signin|signup|recover`,
  `response_mode=web_message`) and closes once it signs the app in. A blocked
  window falls back to the same page in this tab. Nothing opens on page load.
  (Amended 2026-09-26: the first cut moved the whole screen into that window;
  the owner's direction is that auth.oxy.so is only the intermediary.)
- No code decides by domain (`isOxyRpOrigin` no longer picks a route): the
  passkey runs only on auth.oxy.so.
- Third-party "Sign in with Oxy" is unchanged: a window by default, a redirect
  if the site chooses (`webAuthMode`).

### D2 — One browser session for every Oxy app

Signing in, signing out or switching account in one Oxy web app does it in all
of them in that browser, like Google. The browser's session is ONE DeviceSession
held by auth.oxy.so — the only origin every app can reach — and every official
app holds its own credential for it. Native already shares one DeviceSession
(Commons and the shared keychain).

How an app joins it (amended 2026-09-26, the owner's approved mechanism): the
FIRST time a person presses sign-in in an app on the web and the app holds no
device credential, a tiny window `auth.oxy.so/bridge` opens from that press,
next to the dialog. It has no UI and closes in well under a second: it proves
auth.oxy.so's device (or registers one), hands the app a one-use code to join
it, and the app redeems the code for its own credential. From then on the app
never opens it again. If the browser is already signed in, the app is signed in
at once and the dialog closes; otherwise the sign-in in the dialog (the Commons
QR, or the passkey in auth.oxy.so's window) carries the proof of that device, so
the account lands on it and every other app sees it.

The bridge's code is:

- **one-use** — spent by the first redemption, even one with a wrong verifier;
- **short** — about 60 seconds;
- **PKCE-bound** — to an S256 challenge whose verifier only the app's page holds;
- **official apps only** — `isTrustedApplication`; a third party never gets a
  credential for the browser's device and keeps its isolated one;
- **exact** — issued for one of the app's registered redirect URIs, matched
  exactly, and redeemed only from that URI's origin;
- **origin-checked in transit** — posted only to that redirect URI's origin
  (never `*`), and accepted by the app only from the auth origin, from the exact
  window it opened, with its own `state`.

Only auth.oxy.so (and loopback) may register a device or ask for a code. The
device id is always the server's. Nothing opens on page load, and a blocked or
failed bridge only means the app signs in on a device of its own. No cookie,
iframe, FedCM or `prompt=none` is involved (D4).

### D3 — Web accounts: username, passkey and a recovery email

On the web an account is a username, a passkey and a recovery email; there is
no web recovery phrase and no web identity carrier. Recovering sends a code to
that email and registers a new passkey. Commons stays the official, recommended
way — the person's own key and phrase — and linking Commons makes the account
self-custodied and deletes the recovery email.

### D4 — No cookies, no silent navigation

No origin holds a cookie, auth.oxy.so included; no third-party cookies, iframes,
FedCM or `prompt=none`. The SDK still never navigates the window on its own:
every window opens from a press.

## Consequences

- An app's dialog on the web is short — the header, "Continue with Oxy", "Create
  account" — and the full screen is auth.oxy.so's, in its window.
- The passkey ceremony and the browser's session live on one origin, so the
  holder policy of ADR 0028 D2 still applies to everything added there.
- A recovery email makes Oxy the party that decides who recovers a
  passkey-only account; Commons is how a person takes that away from Oxy.
