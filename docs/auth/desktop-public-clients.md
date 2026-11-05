# Desktop public clients

OxyOS uses the ordinary shared Oxy session through `OxyProvider`, and Alia's
product SDK through `/v1`. Its Linux Tauri WebKit shell serves the bundled app
at `tauri://localhost`. The public application seed registers this exact
transport origin in `redirectUris`; it declares no scopes, workload identity,
or `webOrigins`.

CORS permits the browser to read a response. It does not prove that the caller
is OxyOS, create a session, authorize another account, or convert an external
application's isolated session into a shared one. The origin is not loopback
under `isLoopbackOrigin`, and other custom schemes are not implicitly allowed.
The registry's existing exact-origin normalization preserves the scheme and
host instead of collapsing custom schemes to the URL object's opaque `null`.

App recognition remains separate. `POST /apps/assertions` refuses a web
assertion for this registration because no web-recognition origin exists.
There is no invented HTTPS origin, Android/iOS attestation, or desktop
assertion protocol. Ordinary Alia accepts the person's verified session
without an app assertion; an agent confined to a recognized application still
requires its valid assertion.

Alia's SDK uses `/v1` for chat and conversation operations. That public bearer
API already admits browser origins without cookies. Its restricted internal
`/alia/chat` route and shared `createOxyCors` helper are not expanded to accept
opaque custom schemes. The retired shell-specific stream parser must not be
used to bypass the SDK's route and session contract.

Deploy the seed before activating the shell. Run the existing seed dry-run
and apply with `ONLY_APPS=OxyOS`, read back the public credential, and configure
that real public client ID in the shell. Do not invent a client ID, create a
server credential, or treat the public identifier as a secret. Windows and
other Tauri targets require their actual origins to be reviewed separately;
this registration covers the Linux distribution only.

Tests cover the seed's public-client shape, the real registry's exact
`tauri://localhost` decision, rejection of unrelated custom schemes, and the
assertion endpoint's refusal of both a shared session's desktop recognition
claim and an isolated session's attempt to claim another application.
