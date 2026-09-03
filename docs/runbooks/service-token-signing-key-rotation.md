# Runbook — rotating the token signing keys (`ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, and the service-token key)

The one rotation on this list with a **platform-wide, user-visible cost**, and the
one where getting the order wrong cannot be rolled back cheaply. Read the whole
file before starting.

## What production is signed with before the asymmetric bindings are enabled

| Token | Lifetime | Signed with | Where |
|---|---|---|---|
| User access token | 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`) | `ACCESS_TOKEN_SECRET`, HS256 | `packages/api/src/utils/sessionUtils.ts` |
| Refresh token | up to 7 days | `REFRESH_TOKEN_SECRET`, HS256 | same |
| **Service token** | 1 hour (`SERVICE_TOKEN_EXPIRY`) | **`ACCESS_TOKEN_SECRET`**, HS256, `iss: oxy-auth`, `aud: oxy-api` | `packages/api/src/routes/auth.ts` |

**The service token shares the user-token signing key.** That is the state
[ADR 0012](../adr/0012-service-token-signing-key-model.md) exists to end, and it
is why this is one runbook rather than two: there is currently no separate
service-token key to rotate.

ADR 0012's source implementation now supports Ed25519 signing, a `kid` in the
header, public keys at `https://api.oxy.so/.well-known/jwks.json`, and external
verification without a mint-capable secret. It does not become active merely by
merging source: the bindings below must be provisioned and the release order
completed. With all three bindings absent the API retains the existing HS256
mint as a bounded transition; a partial binding set fails boot.

## Exact SSM and task-definition bindings required

Do not generate values in a deploy workflow and never copy
`ACCESS_TOKEN_SECRET` to a consumer. Provision these exact parameters out of
band, then bind them only into the `oxy-api` task:

| SSM parameter | Type | Container environment name | Contents |
|---|---|---|---|
| `/oxy/oxy-api/SERVICE_TOKEN_PRIVATE_KEY` | `SecureString` | `SERVICE_TOKEN_PRIVATE_KEY` | PKCS#8 PEM Ed25519 private key; oxy-api only |
| `/oxy/oxy-api/SERVICE_TOKEN_SIGNING_KEY_ID` | `String` | `SERVICE_TOKEN_SIGNING_KEY_ID` | exact URL-safe `kid` for the active private key |
| `/oxy/oxy-api/SERVICE_TOKEN_PUBLIC_JWKS` | `String` | `SERVICE_TOKEN_PUBLIC_JWKS` | public-only JSON JWKS for additional old/next rotation keys; omit the active `kid` because it is derived from the private key |

The endpoint composes the active public key with that additional public-only
set. It refuses duplicate `kid`s, private `d` material, malformed Ed25519 keys
and partial signing configuration. No downstream task receives any of these
bindings: it fetches the public endpoint through `@oxyhq/core`.

## What a rotation actually costs

`ACCESS_TOKEN_SECRET` is a single symmetric secret with no `kid`, so at the
instant the running task starts using a new value:

- **Every outstanding user access token is refused.** Up to 15 minutes' worth.
- **Every outstanding service token is refused.** Up to 1 hour's worth. `@oxyhq/core`'s
  `getServiceToken()` refreshes only within 60 seconds of expiry, so a
  service-to-service caller can hold a token for ~59 more minutes and every call
  it makes fails 401 until it refreshes.
- **Users are NOT signed out, and this is the part most likely to be got wrong in
  either direction.** The session authority is `DeviceSession`, which stores
  `sha256(deviceSecret)` in PostgreSQL and does not involve the JWT key at all. A
  client whose access token is refused re-mints one from its own
  `{deviceId, deviceSecret}` at `POST /session/device/token`. So the user-visible
  effect is a burst of 401s followed by an automatic re-mint — not a logout, and
  not a re-authentication. What WOULD sign everyone out is destroying device
  sessions, which this rotation does not do.
- **Sockets drop.** `utils/socketAuth.ts` verifies the bearer with the same
  secret; connected sockets are refused on their next authentication and
  reconnect after the client re-mints.

There is no dual-accept window available, because an HS256 token carries no `kid`
to select a key by. A verifier can only try one secret and then the other, which
means holding two live minting keys at once — the dual-authority shape this
repository refuses elsewhere. **Do not build one for this.** Take the burst.

## Trigger

- **`ACCESS_TOKEN_SECRET` or `REFRESH_TOKEN_SECRET` was exposed.** The known
  instance: `packages/api/.env` was committed with live values in it. Anyone with
  a copy can mint a user access token for any account, and — because the service
  token shares the key — a service token asserting any `ownerAccountId`, which
  after [ADR 0007](../adr/0007-canonical-request-attribution.md) is spend
  attribution. Treat as the most severe credential incident on this list.
- **A verifier outside `oxy-api` was given the secret.** ADR 0012 records that no
  external service holds it today, verified against the ACTIVE ECS task-definition
  families with a positive control (the scan did find holders — `oxy-oxy-api` and
  its one-shot derivatives — so the zeros elsewhere are absence, not a blind
  scan). If that changes, rotate and remove it from the other side.
- **Scheduled.** Nothing forces it and the cost is real; prefer landing ADR 0012's
  asymmetric scheme, after which rotation is additive and cheap.

## How a platform secret actually reaches production

Know this chain before rotating anything, because every step is a place a rotation
silently does not take effect:

1. The value lives as a **GitHub repository secret**.
2. `.github/workflows/deploy-aws.yml` writes it to **SSM** with
   `aws ssm put-parameter --type SecureString --overwrite`, at
   `/oxy/oxy-api/<NAME>` (or `/oxy/_shared/<NAME>` for the shared set).
3. **ECS injects it at TASK LAUNCH** from the task definition's `secrets` block.

Three consequences:

- A secret changed in GitHub reaches production only on the **next deploy**, and
  only if the deploy's sync step runs.
- The sync loop iterates two **hand-maintained allow-lists** (`SHARED_SECRETS` and
  `API_SECRETS` plus a matching `SYNC_<NAME>` env entry). A name missing from
  either is written nowhere, the deploy is green, and the failure surfaces later as
  `ResourceInitializationError: unable to pull secrets`.
  `scripts/check-deploy-secrets-sync.mjs` is the gate that catches that on a pull
  request — `ACCESS_TOKEN_SECRET` and `REFRESH_TOKEN_SECRET` are both in
  `API_SECRETS` today.
- **A running task keeps the OLD value until it is replaced.** Rotation is not
  complete when SSM changes; it is complete when every task has been relaunched.
- **Never set a GitHub secret to a placeholder**, not even briefly. The sync
  overwrites SSM with whatever it finds, and a placeholder crash-loops the service
  — the deploy workflow skips empty and `-` values as defence in depth, but a
  plausible-looking placeholder is written.

## Procedure

```bash
# 1. Generate. 64 bytes of base64 is well past the 32-character production floor
#    that `config/env.ts` enforces (and it refuses known placeholders outright).
openssl rand -base64 64
```

2. **Set the GitHub repository secret** to the new value — through the GitHub UI
   or `gh secret set ACCESS_TOKEN_SECRET`. Then **read it back**: a `gh` write can
   exit 0 and change nothing. `gh secret list` shows the `updatedAt` timestamp,
   which is the only readable evidence (the value never is). If the timestamp did
   not move, the write did not happen.

3. **Deploy**, so the sync step writes SSM and a new task definition revision
   launches with the new value. Do not hand-edit SSM as the primary path: the next
   deploy's sync overwrites it from the GitHub secret, so a hand-edit that is not
   mirrored in GitHub is reverted at a time nobody is watching.

4. **Announce the burst** if anything outside Oxy calls the API with a service
   token. Their calls fail 401 for up to one token lifetime.

## How to verify it took

In order, because each step can pass while the next fails:

1. **The GitHub secret changed** — `gh secret list` shows a new `updatedAt`.
2. **SSM holds the new value.** Compare the parameter's `LastModifiedDate`
   against your deploy; the value itself should be compared by digest, not
   printed. `oxy-infra`'s runbooks own the exact commands, and reading a
   SecureString requires the decrypt permission.
3. **The RUNNING task is using it.** This is the step that is actually load-bearing
   and the one most often skipped: a green deploy proves a revision was registered,
   not that the service is running it. `register-task-definition` does not
   repoint a service, and a `desired_count` bump launches the revision the service
   is CONFIGURED with, never the newest. Confirm through ECS that the PRIMARY
   deployment has `rolloutState: COMPLETED` on the revision you expect — see
   `oxy-infra`.
4. **Behaviourally:** a token minted BEFORE the cutover is now refused (401), and
   a freshly minted one is accepted. Both halves are needed. If the old token
   still works, the running tasks still hold the old secret; if the new one is
   refused too, the deployed value is not what you think it is.
5. **The error rate returns to baseline within one hour** — one service-token
   lifetime. A 401 rate that stays elevated past that is a caller that is not
   refreshing, not the rotation settling.

## Rollback

**Putting the old value back works, and it re-validates the tokens signed under
it.** That is the whole rollback, and it is only correct when the rotation was
scheduled maintenance. For a compromise, rolling back re-arms the attacker's copy
— accept the elevated 401s instead and fix the caller.

The window is not symmetric: after a rollback, tokens minted under the NEW secret
during the intervening period are refused. Keep the gap short.

**There is no partial rollback.** One secret, no `kid`, no per-audience key.

## Break-glass

**The secret is compromised and you cannot deploy.** Rotating the signing key is
not the only way to invalidate access; the device-session layer is independent of
it and reachable through the API:

- Revoke the affected **device sessions** — that is the authority, and it does not
  care what the JWT key is. A revoked device session cannot mint another access
  token even with the leaked secret, because minting requires the stored
  `sha256(deviceSecret)` to match.
- Suspend or archive the affected **account**;
  `accountService.resolveEffectiveAccess` resolves a suspended or archived account
  to nothing, which stops a forged token from being useful for that account.
- Neither of these helps against a forged **service token** asserting an arbitrary
  `ownerAccountId`, which is the reason ADR 0012 exists. If that is the exposure,
  the signing key rotation is not optional and the deploy is the path.

**A deploy is failing and the secret is already changed in GitHub.** The running
tasks still hold the old value and the service is HEALTHY — the desync is not an
outage. Do not force a task restart to "apply" the new secret while the deploy is
broken: a task launching against a half-synced SSM set fails to start, and a
deploy render carries forward every secret it is not told to replace, so a
partially applied change can propagate further than intended. Fix the deploy, then
rotate.

**You do not know whether the running tasks hold the old or new value.** Do not
guess from the deploy log. Mint a token and observe: a token minted now, verified
now, tells you which secret the process is holding. That behavioural check is the
only one that cannot be wrong.

## Additive Ed25519 rotation after the bindings are active

Rotation stops being an event and becomes additive, because a JWKS is one
authoritative key set indexed by `kid`:

1. Publish the new public key in the JWKS — verifiers now know both `kid`s. Nothing
   is signed with the new key yet and nothing is weaker.
2. Start signing with the new `kid`. Tokens under the old `kid` keep verifying
   because their key is still published; a verifier selects deterministically by
   the `kid` the token names and never "tries the other one".
3. Retire the old key **no sooner than one maximum token lifetime after the last
   token signed with it** — a separate, verified step, not a line deleted in the
   commit that added the new key.

Bound the window by the token lifetime, never by a calendar guess. And note the
precedent for making such a window enforceable rather than merely true:
`ACCESS_TOKEN_V1_WINDOW=closed` (`utils/sessionUtils.ts`) is how the v1 access
token window was closed — a flag that refuses the old shape once the last one has
expired, so the guarantee holds for every request instead of for every request
that happens to carry a new enough token.

The private key lives in the SSM `SecureString` named above, per ADR 0012. Do
not delete the old public key until both the one-hour maximum service-token
lifetime and every verifier's five-minute JWKS cache window have elapsed from
the last token signed with that `kid`.
