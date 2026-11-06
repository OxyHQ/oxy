# Desktop public clients

OxyOS holds the person's Oxy session itself (ADR 0058). Its root service
`oxyos-accountd` is the one holder of each enrolled account's credential, and
the applications OxyOS launches hold none: they get five-minute tokens named for
themselves from it, through the session host the OxyOS Bloom host registers for
`OxyProvider`.

## The OxyOS registration

The canonical seed (`seedOxyApplicationsSpecs.ts`) registers `OxyOS` as a
`first_party` application with a public client and:

- `platformHost: 'oxyos'`: a password sign-in naming this public client id as
  `platformClient` (`POST /auth/signin/password`, completed by
  `POST /auth/signin/second-factor`), with no web `Origin`, gets a PLATFORM
  credential, and retires the device proof it presented;
- no redirect URI, no `webOrigins`, no scopes, no workload identity. The login
  screen signs in with the SDK's own dialog over native HTTP, with no web
  origin, so there is nothing to redirect to. The `tauri://localhost` transport
  origin of the retired Tauri WebKit shell is removed by the seed
  (`retiredRedirectUris`).

OxyOS's own Settings and shell mint as the platform's application
(`attestation: { platform: 'oxyos', self: true }`). Every other application it
ships is named by its desktop entry id, declared on that application's registry
entry (`oxyosDesktopEntryIds`): `so.oxy.dropsea` (Dropsea), `so.oxy.atlas`
(Atlas), `so.oxy.allo` (Allo), `so.oxy.inbox` (Oxy Inbox). An application
OxyOS ships needs its entry id there before its token can be minted; an id names
one application only, and only an Oxy (trusted) application is minted for.

## What OxyOS configures

`oxyos-accountd` takes OxyOS's public client id as `OXYOS_OXY_CLIENT_ID` (and the
API as `OXYOS_OXY_API`). The id is public, not a secret: read it back from the
seed workflow's `OXY_APP_MAPPING_JSON` (a dry run of `ONLY_APPS=OxyOS` prints it
once it exists). Do not invent a client id, create a server credential, or treat
the public identifier as a secret.

## What the registration does not do

CORS permits a browser to read a response; it proves nothing here, and OxyOS
needs none. A platform credential is never issued to a request carrying a web
`Origin` or `Sec-Fetch-Site`, and `POST /session/device/app-token` answers such a
request `browser_not_allowed`. The platform cannot prove to Oxy which process
asks; Oxy believes its attestation because the platform already holds the
device credential, and the application's token is strictly less (ADR 0058 2.8).

App recognition: an application token proves its own application on the
`oxyos` lane of `POST /apps/assertions` (the bearer is the proof), so an agent
confined to that application accepts it. The device's own token proves no
application there.

Windows, macOS and other desktop targets are not covered: Astro registers
`platformHost: 'astro'` when its step of ADR 0058 lands, and any other desktop
client is reviewed on its own.

Tests: `routes/__tests__/platformAppTokens.db.test.ts` (the platform sign-in,
the mint, its refusals, verification and revocation, the `oxyos` assertion lane),
`scripts/__tests__/seedOxyApplicationsSpecs.test.ts` (the OxyOS registration
and the desktop entry ids).
