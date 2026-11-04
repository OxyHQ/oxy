# Credentials: what authenticates what

Own Oxy products and external integrations have different authority. The
[platform contract](../auth/first-party-platform-access.md) and ADR 0049 govern
this distinction; an official app name never upgrades a customer credential.

| Lane | Authentication | Authority |
|---|---|---|
| Own backend | Temporary workload credentials, live registered binding and short-lived service token | Scope-less first-party service; account, resource, environment and business rules still apply |
| Own signed-in app | Shared Oxy session | The actual requester and effective account; no app consent |
| External machine key | `oxy_sk_…` bearer | Live credential/app ceilings, explicit scopes and billing limits |
| External service credential | Public client id plus secret exchanged for a service token | External authority, even under an official application |
| Public OAuth client id | `oxy_dk_…` identifier | No bearer authority by itself |

Status and deployed evidence: [status.md](./status.md) and the
[migration ledger](../architecture/first-party-integration-migration.md).

## 1. Own workload and external service tokens

Own services construct `OxyServer` with the shared temporary AWS credential
provider and consume the product SDK factory or `createServiceClient`. They do
not provision app scopes or fall back to an API key. The issuer verifies the
active workload binding, application and environment; the recipient verifies
its exact audience and live authority. Personal resource operations additionally
carry shared requester proof (session, task or derived context), never an
unverified account header. Inference billing attribution is a distinct contract.

External client credentials remain a separate service-token lane with bounded
scopes and live revocation. They cannot become own authority through branding.

See [the SDK examples](./sdk.md), [service tokens](../SERVICE_TOKENS.md), and
[attribution](./attribution.md) for the wire and payer contracts. Neither a valid
token nor a readable catalogue proves that a generation has executed.

---

## 2. Machine API keys (`oxy_sk_…`)

One bearer string a standard OpenAI-style SDK can send with no token exchange in
front of it. It exists so that external developers will not have to implement a
client-credentials handshake when the public edge ships.

### Where it is accepted

The middleware that resolves an `oxy_sk_…` token —
`packages/api/src/middleware/machineCredential.ts` — is mounted on **the public
inference edge** and nowhere else: `POST /v1/responses`,
`POST /v1/chat/completions` and `GET /v1/generations/:id`, together with its
per-credential and per-application limiters.

That is where it was always going to be mounted, and the wait was not
bureaucratic. Before the edge existed, the nearest plausible endpoint was the
Alia proxy, and mounting it there would have been wrong for a reason a rate limit
cannot fix: that route forwards the caller's body to Alia on one shared upstream
key, and `max_tokens` is the caller's to choose — so a cap of N requests per
window bounds requests and never cost, on a single shared budget with no
per-account attribution. The edge reserves the maximum a request could cost
before anything is forwarded ([billing.md](./billing.md)), which is what makes
the credential safe to accept at all.

The credential authenticates only this lane; it does not prove the audience is
open, the requested model is published or canonical Kaana is configured. Read the
live rollout state and run the signed end-to-end check in
[sdk.md](./sdk.md#verify-the-deployed-path) before claiming reachability.

Catalogue reads (`GET /v1/models`) accept the credential too, and resolve to the
PUBLIC audience — the same one an anonymous caller gets. A machine key is not a
service token, so it does not widen what you can see.

### The format

```text
oxy_sk_<16 hex id>_<64 hex secret>
        └── public ──┘ └─ 256 CSPRNG bits ─┘
```

- The prefix (`oxy_sk_` + the id) is stored as `token_prefix`, is unique, and is
  **public**: it identifies the row and authorises nothing. It is what Console
  shows you after creation and what an audit event names.
- The secret half is never stored. What is stored is the SHA-256 of the **whole
  token**, so a digest copied onto another row verifies against nothing.

### Creating one — the token is shown exactly once

```typescript
const { credential, token } = await oxy.apps.credentials.create(applicationId, {
  name: 'ci-runner',
  type: 'machine',
  environment: 'production',       // development | staging | production
  scopes: ['inference:invoke'],    // REQUIRED for a machine credential
  expiresInSeconds: 30 * 24 * 3600, // optional; 60s .. 730 days
});

// `token` is the full oxy_sk_… string. This is the only time it exists
// anywhere outside the caller's own memory.
// `credential.tokenPrefix` is the public half, safe to store and display.
```

Notes that bite:

- **`scopes` is required.** A machine credential must NAME its authority; unlike
  the service-token mint there is no fallback to the application's full set.
  Requested scopes are intersected with the application's granted scopes, so a
  credential can never exceed its app.
- **`secret` is `null` on a machine credential and `token` is absent on every
  other type.** They are two fields rather than one precisely so a surface that
  renders "the secret" cannot print an API key under the wrong label.
- **`expiresInSeconds` is `machine`-only.** On other credential types
  `expires_at` means the rotation grace deadline; the server rejects the field
  rather than ignoring it.
- Console never re-renders the token after creation, and neither can the API —
  there is nothing to render.

### Rotation, and why its grace window is opt-in

```typescript
// Instant cutover: the old token stops working the moment this returns.
await oxy.apps.credentials.rotate(applicationId, credentialId);

// Zero-downtime: the old token keeps working for one hour.
await oxy.apps.credentials.rotate(applicationId, credentialId, { graceSeconds: 3600 });
```

An OAuth/service credential is *always* retired with the platform's fixed
seven-day grace. A machine credential's grace is **opt-in**, bounded to 1 second
– 30 days, and this asymmetry is deliberate: the common reason to rotate an API
key is that it leaked, and a default grace would keep the leaked key alive for a
week. Preserving a window "where explicitly configured" is a real distinction, so
naming it is what asks for it.

The response carries `rotatedFrom` (the superseded credential id) and
`graceExpiresAt` — `null` when no window was configured, because there is then
no deadline to report.

### Revocation

```typescript
await oxy.apps.credentials.revoke(applicationId, credentialId);
```

Immediate, with no window. The row itself is never deleted: it is the audit link
between a rotated secret and the one it replaced, so it must outlive its own
deadline.

### Audit trail

Every `created`, `rotated`, `revoked` and `validation_failed` event is recorded
for two years. A refusal's reason is written to the trail
(`secret_mismatch`, `not_usable`, `environment_mismatch`,
`application_inactive`, `scope_missing`) and **never returned to the caller** —
every ineligible caller gets the same status and the same message, so a failed
secret teaches nothing about whether a real credential exists or which check
refused.

### Limits

60 requests/minute per credential and 300 requests/minute per application across
all of its machine credentials, plus one edge-wide budget of 600/minute keyed on
the credential id. All three bound REQUESTS, never cost.

Cost is bounded by something else now that the ledger is on the request path:
every invoke reserves the maximum it could spend before anything is forwarded,
and a spending limit or an insufficient balance refuses it at the edge. That is
what a rate limit was standing in for; these numbers are no longer the only thing
between a leaked key and a bill. Raising them is a decision to make against
measured traffic.

---

## 3. `oxy_dk_…` is a public client id, not a bearer

An `ApplicationCredential.publicKey` is the OAuth `client_id`. It identifies an
application publicly and **authorises nothing on its own**. Any example that
sends one as `Authorization: Bearer oxy_dk_…` is wrong.

It is presented *beside* a secret, never as one:

| Flow | How the id travels | How the secret travels |
|---|---|---|
| OAuth authorization code | `client_id` query parameter | `client_secret` in the token-exchange form body |
| Service-token mint | `apiKey` field | `apiSecret` field |
| Public/PKCE client | `client_id` only | there is no secret |

This is structural rather than a check someone could forget. The machine bearer
lane resolves only `token_prefix`, a column no OAuth client id is ever written
to, and its parser refuses anything not shaped like `oxy_sk_…`. A bare
`oxy_dk_…` presented as a bearer cannot resolve — it is not a rule, it is a
column it is not in.

Full detail on the two-lane credential model:
`packages/api/src/db/schema/applicationCredentials.ts`.

---

## External inference scopes

These scopes apply to external credentials, not own workloads or shared own
sessions. Domain staff/operator checks remain independent. The inference family
(`packages/api/src/utils/applicationScopes.ts`):

| Scope | Grants | Self-grantable? | Checked where |
|---|---|---|---|
| `inference:invoke` | spend the OWNING ACCOUNT's balance on a request | yes | the edge, before anything is resolved or reserved |
| `inference:usage:read` | read the app's own usage and receipts | yes | `GET /v1/generations/:id`, and the reporting API's application lane |
| `inference:routing:read` | read routing/profile descriptors | yes | `/inference/routing-policies` |
| `inference:providers:read` | read provider descriptors | yes | `/inference/provider-connections` |
| `inference:routing:write` | change routing policy | **staff only** | `/inference/routing-policies` |
| `inference:providers:write` | manage provider/BYOK connections | **staff only** | `/inference/provider-connections` |
| `inference:models:read` | read the model catalogue | yes | **nowhere** |

**`inference:models:read` is checked by nothing.** The catalogue is
audience-scoped by application type rather than by scope: an anonymous caller, a
user bearer and an ordinary application's service token all resolve to the public
audience, and only a staff-controlled first-party/internal/system application
sees `platform_internal` routes. So
holding this scope grants nothing that is checked, and not holding it costs
nothing — the same shape `chat:completions` had before it was removed for
exactly that reason. Recorded here rather than quietly documented as if it
gated something.

The four reads plus `invoke` are non-privileged because each is bounded to the
app's own tenant, and a delegated end-user identity is never the billing
principal — so an application can only ever spend the balance of the account that
owns it. The two writes change what other people's requests do, and are
staff-granted.

`chat:completions` and `models:read` no longer exist. See
[migration.md](./migration.md).
