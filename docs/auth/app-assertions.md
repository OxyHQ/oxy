# App assertions: which Oxy app a request comes from

[ADR 0045](../adr/0045-app-assertions.md). Every official app shares one device
session ([ADR 0029](../adr/0029-one-oxy-session.md)) and an app's `clientId` is
public, so nothing a request carries on its own says which app sent it. An app
proves itself to Oxy by platform, and Oxy signs a short-lived assertion that a
service verifies. It is what an agent confined to its application
([ADR 0044](../adr/0044-application-confined-agents.md)) is enforced against.

## The registry

Each application may declare how it is recognised. Written only by Oxy staff,
through the application administration lane, on the same terms as the
application's agents (`requireStaff` + `app:update`):

| Route | Who | |
|---|---|---|
| `GET /applications/:appId/recognition` | `app:read` | the declaration; an application nobody declared declares nothing |
| `PUT /applications/:appId/recognition` | staff + `app:update` | replace the whole declaration (`ApplicationRecognitionWrite`) |
| `DELETE /applications/:appId/recognition` | staff + `app:update` | the application can no longer assert any platform |

```json
{
  "webOrigins": ["https://mention.earth"],
  "android": { "packageName": "earth.mention.app", "signingCertSha256": ["<64 lowercase hex>"] },
  "ios": { "teamId": "ABCDE12345", "bundleId": "earth.mention.app" }
}
```

- `webOrigins`: exact `https://` origins, as a browser sends them in `Origin`
  (no path, no trailing slash, no default port).
- `signingCertSha256`: the SHA-256 of each certificate Play reports for the app
  (the Play Console's app-signing key, and the upload key if builds signed with
  it are distributed), `keytool`'s digest lowercased without colons.
- Tables: `application_recognition` (one row per application) and
  `application_web_origins` (one row per origin). An origin, an Android package
  and an iOS team + bundle can each belong to one application only; a write that
  reuses one is refused (409).

## The exchange

Every call takes the person's own bearer and answers for that person and
session only. A refusal is `{ error: <APP_ASSERTION_ERROR_CODES>, message }`.

| Route | |
|---|---|
| `POST /apps/assertions/challenge` | `{ applicationId, platform: 'android' }` or `{ applicationId, platform: 'ios', purpose: 'assertion' \| 'attest_key' }` → `{ challenge, requestHash, expiresAt, cloudProjectNumber? }` |
| `POST /apps/attest-keys` | `{ applicationId, keyId, challenge, attestation }` → 201 `{ keyId }` |
| `POST /apps/assertions` | `{ applicationId, platform: 'web' }`, `{ …, platform: 'android', proof: { challenge, integrityToken } }` or `{ …, platform: 'ios', proof: { challenge, keyId, assertion } }` → `{ assertion, applicationId, platform, expiresAt }` |

A challenge lives two minutes and is single-use: it is minted for one person,
session, application, platform and purpose, stored only as its SHA-256
(`app_assertion_challenges`, swept by `db/expiry.ts`), and burned by one
conditional `UPDATE` BEFORE the proof is verified, so a refused proof cannot be
retried and a used Play Integrity token or App Attest assertion cannot be
replayed. The device binds it through `requestHash` =
`base64url(SHA-256("oxy-app-assertion/v1\n" + applicationId + "\n" + platform + "\n" + purpose + "\n" + sessionId + "\n" + challenge))`.

What each platform proves:

- **web** — the request's `Origin` is one of the application's `webOrigins`. A
  page cannot set `Origin`; a scripted client that forges it gets an assertion
  for its own session, with its own data and credits, and nothing more.
- **android** — the app requests a Play Integrity (standard) token for the
  challenge's `requestHash`, for `cloudProjectNumber`. Oxy decodes it with Google
  (`decodeIntegrityToken`, as the configured service account) for the registered
  package and accepts it only when the verdict names that package as requesting
  and recognised package, `appRecognitionVerdict: PLAY_RECOGNIZED`, at least one
  registered signing certificate, the `requestHash`, and a request time inside
  the challenge's life. Device integrity is not judged (see ADR 0045,
  Consequences).
- **ios** — once per install, the app generates an App Attest key and has Apple
  attest it over an `attest_key` challenge; Oxy verifies the attestation against
  Apple's App Attestation Root CA (pinned in `config/appAttest.ts`), the nonce,
  the key id, `rpIdHash` = `SHA-256(<teamId>.<bundleId>)`, a zero counter, the
  environment (`APP_ATTEST_ENVIRONMENTS`, `production` by default) and the
  credential id, and stores the public key and counter (`app_attest_keys`; a key
  unused for 180 days is swept). Each assertion is then an App Attest assertion
  over an `assertion` challenge's `requestHash`, verified with that key, for the
  registered app id, with a counter that moves strictly forward (a conditional
  `UPDATE`, so two racing assertions cannot both pass).

Refusals: `application_unavailable` (no active application), `session_other_application`
(the bearer's session is another application's own), `platform_not_registered`,
`origin_not_registered`, `challenge_invalid`, `integrity_refused`,
`attest_key_unknown` (the SDK then attests a new key), `attest_key_exists` (409),
`attestation_invalid`, `assertion_invalid` — 403 unless noted — and
`integrity_unconfigured`, `integrity_unavailable`, `signing_unavailable` (503).

## The assertion

A JWS with header `{ alg: EdDSA, typ: OXY-APP+JWT, kid }`, signed with the
capability-ticket key and published beside it at
`/capabilities/.well-known/jwks.json` (the same key and JWKS as capability
tickets and requester assertions). Claims, all required, nothing else:

| Claim | |
|---|---|
| `iss` | Oxy's API origin (`OXY_API_URL`, `https://api.oxy.so` in production) |
| `aud` | `oxy-apps` |
| `sub` | the person (the account the session acts as) |
| `sid` | the session |
| `app` | the application id |
| `platform` | `web` \| `android` \| `ios` |
| `iat`, `exp` | `exp - iat` = 300 |
| `jti` | a UUID |

It is not single-use: it may be presented to any service for its five minutes,
and only by the session it names.

## In the app: `@oxy.so/services`

`OxyProvider` obtains the assertion for the signed-in session and refreshes it
a minute before it expires; a session change drops it at once. The app writes no
code. On the web it calls `POST /apps/assertions` from the page, so `Origin` is
the browser's; on iOS and Android it uses `@expo/app-integrity` (a peer of
`@oxy.so/services`, loaded lazily, so a binary without it simply has no
assertion). The application id comes from the provider's `clientId`
(`apps.getPublic`), and the iOS key id is kept in the provider's storage.

```ts
const { status, assertion, getAppAssertionHeaders } = useAppAssertion();
await fetch(url, { headers: { ...(await getAppAssertionHeaders()), authorization } });
```

`status` is `idle`, `pending`, `ready`, `unavailable` (Oxy refused or was
unreachable; a refusal that cannot change for the session is not retried, any
other failure is retried with a backoff) or `unsupported` (no `clientId`, no
native module, no App Attest on this device).

## In a service: `@oxy.so/core/server`

```ts
import { readAppAssertionHeader, verifyAppAssertion } from '@oxy.so/core/server';

const app = await verifyAppAssertion(readAppAssertionHeader(req), {
  session: { userId: req.userId, sessionId: req.sessionId },
});
// { applicationId, platform } — or null: no header, a wrong signature, issuer,
// audience or type, another person's or another session's assertion, expired,
// or a JWKS that cannot be read. Never read an app identity from anything else.
```

`issuer` defaults to `https://api.oxy.so` and `jwksUrl` to the issuer's
`/capabilities/.well-known/jwks.json`, fetched and cached per process.

## Operator inputs

Nothing works on a platform until these exist; none has a default.

- **Google Play Integrity**: a Google Cloud project with the Play Integrity API
  enabled and each Android app linked to it in the Play Console; a service
  account of that project with a JSON key. `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER`
  (plain task-definition environment) and `PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY`
  (SSM SecureString `/oxy/oxy-api/PLAY_INTEGRITY_SERVICE_ACCOUNT_KEY`, bound in the
  task definition by oxy-infra). Unset, Android assertions are refused with
  `integrity_unconfigured`.
- **Apple App Attest**: each iOS app's team id and bundle id in the registry,
  and the App Attest capability (`com.apple.developer.devicecheck.appattest-environment`)
  on the app. `APP_ATTEST_ENVIRONMENTS=production,development` only where
  development builds should be recognised.
- **Each app's registry entry**: web origins, Android package and signing
  certificate digests, iOS team and bundle, written by staff through
  `PUT /applications/:appId/recognition`.
