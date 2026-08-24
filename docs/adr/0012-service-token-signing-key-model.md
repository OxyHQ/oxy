# ADR 0012 — Service tokens move to asymmetric signing with a published JWKS; the shared HMAC secret is retired

- Status: accepted. Sub-decision (1), key custody, is DECIDED — an Ed25519 private key in SSM; see "Sub-decision (1): decided" below. Sub-decision (2), the cutover schedule and the cross-repository release ordering, is still open and blocks only the RETIREMENT of the old key, not the new one's arrival.
- Date: 2026-08-16
- Issue: #972 (workstream 2.2), #987 (the documentation/key divergence this decides the fix for)

## Context

A service token is what a verifier outside `oxy-api` holds when it decides
whether to serve a request and, after ADR 0007, **which account to charge for
it**. Today that decision rests on a symmetric key.

- **The mint signs HS256 with `ACCESS_TOKEN_SECRET`**
  (`packages/api/src/routes/auth.ts:3684-3693`), with `iss: 'oxy-auth'` and
  `aud: 'oxy-api'`, and a one-hour lifetime (`SERVICE_TOKEN_EXPIRY`,
  `:3481`).
- **`ACCESS_TOKEN_SECRET` is not a service-token key.** It is the key that signs
  every user access token (`packages/api/src/utils/sessionUtils.ts:90`,
  `generateSessionTokens` — the only mint site for user tokens), and it is the
  key the media-token key is derived from
  (`packages/api/src/utils/mediaToken.ts:109`). It is the highest-value secret
  the platform has.
- **Verification requires the same secret.** The API verifies in-process
  (`packages/api/src/middleware/serviceToken.ts:105`). An external verifier
  would pass it to the SDK as `oxy.auth({ jwtSecret })`, which recomputes the
  HMAC by hand (`packages/core/src/mixins/OxyServices.utility.ts`,
  `verifyServiceTokenSignature`).
- **The SDK's documentation described a key that does not exist.** Until the
  change that adds this ADR, the `jwtSecret` note and four `@example` blocks in
  `OxyServices.utility.ts` told an integrator to pass
  `process.env.SERVICE_TOKEN_SECRET`, "distinct from `ACCESS_TOKEN_SECRET`". The
  name appears nowhere else in the repository, in any workflow, or in any task
  definition. That divergence is #987; the documentation is corrected in this
  change, and #987 tracks the key fix itself.

### The hazard is LATENT, not live — and that sizes the urgency

Measured against the live AWS account (`us-west-2`, profile `oxy`) on
2026-08-16 by the team lead, independently of the work in this change: across
every ACTIVE ECS task-definition family, the only families injecting
`ACCESS_TOKEN_SECRET` are `oxy-oxy-api` itself and its one-shot derivatives
(`oxy-pg-migrate`, `oxy-pg-backfill`, `oxy-api-accounts-migration`). `oxy-alia`,
`oxy-allo`, `gwj-backend` and the rest hold none. The scan carries a positive
control — it did find holders — so those zeros are absence rather than a blind
scan.

**No external service verifies service tokens locally today, because none of
them has the key. Nothing is exposed right now.** What exists is a documented
configuration that, if followed, would require distributing the user-token
signing key across a service boundary; the documentation is what would cause it.

That distinction is load-bearing in both directions. Stated as a live exposure
this would be false, and a false urgency gets a decision argued with instead of
read. Stated as merely theoretical it would be under-weighted: a latent hazard
of this shape waits for somebody's unrelated integration work to make it
reachable, and at that moment it presents as normal operation — a service that
starts verifying locally, works perfectly, and has quietly been handed the
user-token signing key. "Unreachable today" is precisely what lets that survive
review.

### Why a dedicated symmetric key is not sufficient either

Three earlier decisions bear on the destination, independently of #987:

- **ADR 0006** says the data plane stores immutable references to Oxy ids and
  cannot mutate Oxy's customer state. A data plane holding a symmetric
  verification key can mint a token asserting any customer relationship it likes.
- **ADR 0007** makes `ownerAccountId` the financially responsible principal, and
  a verified claim rather than a lookup. The claim's whole value is that a
  verifier need not consult Oxy — which means nothing downstream re-checks it.
- **ADR 0009** keys reservation and settlement on `accountId`.

Composed: in ANY symmetric scheme, verifying and minting are the same
capability, so the key that lets a verifier READ attribution is the key that
lets it FORGE attribution, and a forged `ownerAccountId` is indistinguishable
from a real one at every point after the mint. That is a spend-forgery primitive
handed to each new verifier, and this epic adds verifiers. A shared symmetric
secret also cannot be rotated incrementally — every holder must change at the
same instant, so in practice it never is, and a suspected compromise has no
cheap response.

## The three options

**Option 1 — a real dedicated `SERVICE_TOKEN_SECRET`.** Mint and verify service
tokens under their own HS256 key; the documentation becomes true. Genuine
improvement: a compromised verifier can no longer mint USER access tokens, and
the blast radius of the documented configuration shrinks from "the whole
platform" to "service tokens". Does **not** fix the property that matters — every
verifier can still mint a service token naming any `ownerAccountId`, which after
ADR 0007 is spend-attribution forgery — and inherits the flag-day rotation
problem.

**Option 2 — asymmetric signing with a published JWKS. RECOMMENDED.** No shared
secret crosses a boundary at all: verifiers hold public keys. Fixes both the
#987 divergence and the forge-attribution property, and makes rotation additive
rather than a flag day.

**Option 3 — truthful documentation alone.** Say what the code does, and state
that local verification requires the user-token signing key and is therefore not
appropriate outside the API's own trust boundary. Cheapest, and it is what the
change carrying this ADR actually ships as an immediate step. It leaves the
hazard in place and only stops it being invited — which is worth something, but
it is a stopgap, not the fix.

## Decision

**Option 2. Oxy service tokens are signed asymmetrically and verified against a
published JWKS. The shared-secret scheme is retired, not kept as a fallback.
Option 3 ships now as documentation; option 1 is not taken, because it pays a
key-rotation cutover for a property option 2 supersedes.**

Concretely, the target state:

- `oxy-api` signs service tokens with a private key it alone holds, using
  **EdDSA (Ed25519)**, with a `kid` in the JOSE header. Ed25519 rather than
  ES256 because signing and verification are constant-time by construction and
  the implementation surface is smaller; `alg` is pinned by the verifier and
  never read from the token.
- `oxy-api` publishes the corresponding public keys at
  **`https://api.oxy.so/.well-known/jwks.json`** — unauthenticated, cacheable,
  and containing public keys only.
- Verifiers (`@oxyhq/core`'s `oxy.auth()` / `oxy.serviceAuth()`, and the
  inference data plane) fetch and cache the JWKS, select by `kid`, and pin
  `iss`, `aud` and `alg`. A token whose `kid` is unknown is refused; the verifier
  refetches at most on a bounded schedule, so an unknown `kid` can never become a
  fetch amplifier.
- **No verifier ever holds a key that can mint.** `jwtSecret` leaves the SDK's
  middleware options when the migration lands.
- **`ACCESS_TOKEN_SECRET` stops being a service-token key entirely.** It does not
  become `SERVICE_TOKEN_SECRET`; there is no symmetric service-token key in the
  target state.

**None of this is implemented in the PR that adds this ADR.** That PR extends
the claim set, hardens verification within the existing scheme, and corrects the
documentation. Changing key material is a separate change, for the reasons in
the rollout section.

## Rollout

**Options 1 and 2 both invalidate every service token minted under the old key.**
This is the part most likely to be got wrong later, so it is stated plainly: at
the instant a verifier stops accepting the old key, every token minted before the
cutover is refused. Tokens live one hour and `getServiceToken()` refreshes only
within 60s of expiry, so the exposure is a rolling ~59 minutes of rejected
service-to-service calls unless verifiers accept both keys across the window.

**The cutover therefore needs a dual-accept window — but the two options mean
different things by it, and the difference is why option 2 is cheaper here:**

- **Under option 2 the overlap is not dual authority.** A JWKS is ONE
  authoritative key set that happens to contain more than one key, indexed by
  `kid`; the verifier selects deterministically by the `kid` the token names, and
  never "tries the other one". Publishing the new public key, then signing with
  the new `kid`, then retiring the old key no sooner than one maximum token
  lifetime after the last token signed with it, is ordinary additive rotation —
  no flag day, no simultaneous restart, and nothing is weaker during the window.
- **Under option 1 the overlap IS two secrets, both accepted.** There is no `kid`
  to disambiguate an HS256 token, so a verifier in the window must try the new
  secret and then the old one. For that period every verifier holds two live
  minting keys and a compromise of either forges tokens — genuinely weaker while
  it lasts, and exactly the dual-authority shape this repository refuses
  elsewhere. It has to be time-boxed by something that disarms itself, not by
  intention.

Either way the window must be bounded by the maximum token lifetime, not by a
calendar guess, and the retirement of the old key is a separate, verified step —
not a line deleted in the same commit that adds the new one.

## Sub-decision (1): decided — an Ed25519 private key in SSM

**The owner chose the SSM option over KMS.** Recorded here rather than left to
the implementation, because it is the choice that sets the blast radius of an
`oxy-api` container compromise.

The reasoning, in the owner's terms: **operational consistency.** Every other
secret this deployment holds arrives the same way — a GitHub repository secret
synced to SSM, injected into the task definition — and a signing key that
travels a different path is a second mechanism to get right, to rotate, and to
remember exists. KMS would have bought exfiltration resistance, and it was
weighed against that; the answer was that a bespoke custody path for one key is
not worth the operational surface it adds at this size.

**What is accepted along with it:** a container compromise yields the
service-token MINT key, and an attacker holding it can mint a service token
naming any application. That is a real cost and it is not waved away — it is
accepted because the comparison is not against perfection but against today,
where the same compromise yields `ACCESS_TOKEN_SECRET` and therefore the ability
to mint any USER's access token as well. Moving from "forge any user session" to
"forge a service principal" is the large improvement, and KMS would have been a
smaller further step on top of it.

Concretely:

- Parameter `/oxy/oxy-api/SERVICE_TOKEN_PRIVATE_KEY`, a `SecureString`, holding
  a PKCS#8 PEM Ed25519 private key.
- `alg` is `EdDSA` (Ed25519), as the decision section specifies. This is the
  reason KMS was a real alternative rather than a drop-in: KMS offers no Ed25519
  signing, so taking it would ALSO have meant switching to ES256. Choosing SSM
  keeps the algorithm the decision section named.
- The public half is published at `/.well-known/jwks.json` and is not a secret.
- Rotation stays additive per the rollout section: publish the new public key,
  then sign with the new `kid`, then retire the old no sooner than one maximum
  token lifetime after the last token signed with it.

Sub-decision (2) is untouched by this. The mechanism is built so the cutover is
a separate, verifiable step, and the old scheme is not retired in the same
change that adds the new one.

## What this ADR does not decide, and why it cannot

Two sub-decisions were the owner's, not an agent's, because both are about
production key custody and a production rollout window. **(1) has since been
answered — see "Sub-decision (1): decided" above; the alternatives are kept here
because a decision without the option it beat is a decision nobody can revisit.
(2) is still open.**

1. ~~**Where the private key lives.**~~ **DECIDED: SSM.** Two viable shapes, and
   they were not equally costly:
   - *An Ed25519 private key in SSM* (`/oxy/oxy-api/SERVICE_TOKEN_PRIVATE_KEY`),
     injected like every other secret. Cheapest; consistent with how every other
     secret in this deployment is handled; the key exists in the task's
     environment, so a container compromise still yields the mint key — but only
     the SERVICE-token mint key, which is already a large improvement over the
     documented configuration's blast radius.
   - *AWS KMS asymmetric signing* (`SIGN_VERIFY`, `ECC_NIST_P256` — KMS does not
     offer Ed25519 for signing). The private key never exists in the process, so
     a container compromise buys signing ORACLE access for as long as the
     compromise lasts rather than a key that outlives it. Costs a network call
     per mint (mitigable: service-token mints are rate-limited to 10 per 5
     minutes per caller), a `kid`-to-KMS-key-id map, and a switch from Ed25519 to
     ES256.

   This was a real trade — operational simplicity against key-exfiltration
   resistance — and the answer depended on how the owner weighs a container
   compromise, which is a judgement about the deployment, not about the code.
   **The owner chose SSM, for operational consistency, accepting that a
   container compromise yields the service-token mint key.**

2. **When the cutover runs, and how the window is bounded.** STILL OPEN. The mechanics are
   settled above; what is not settled is the schedule and who is told. Under
   option 2 the window is cheap but still needs every verifier on a JWKS-capable
   `@oxyhq/core` before the old key retires, which is a release-ordering
   commitment across repositories.

To decide (1) I would need: whether the owner treats an `oxy-api` container
compromise as in-scope for this threat model, and whether a KMS call in the mint
path is acceptable given the mint is already rate-limited. To decide (2) I would
need: the acceptable maintenance window for first-party service-to-service
traffic, and the list of external (non-Oxy-operated) verifiers — the ECS scan
above says there are none today inside the Oxy account, but that is not where a
third-party integrator would appear.

## Alternatives rejected

**Keep HS256 with `ACCESS_TOKEN_SECRET` and truthful documentation (option 3
alone).** Ships in this change as an immediate correction and is kept as the
interim state, but rejected as the destination: it leaves local verification
possible only by distributing the user-token signing key, so the first
integrator who needs it has no safe answer.

**Introduce a dedicated `SERVICE_TOKEN_SECRET` (option 1).** Rejected as the
destination for the reasons above — it does not remove the forge-attribution
property, and it spends a full key cutover, with the weaker of the two
dual-accept windows, on a step option 2 supersedes.

**Verify service tokens by calling back to Oxy (an introspection endpoint).**
Correct, and the reason the claim set exists is to avoid it: a per-request round
trip on the inference hot path, and an availability coupling that makes an Oxy
blip a data-plane outage. Rejected for the request path. It stays the right shape
for revocation questions that a short-lived token cannot answer, which is a
different question from signature verification.

**Sign with the OAuth `id_token` machinery instead.** There is no OIDC signing
key here to reuse; the OAuth token endpoint issues the same
`ACCESS_TOKEN_SECRET`-signed access tokens. Nothing is saved.

## Consequences

- A new public endpoint (`/.well-known/jwks.json`) becomes part of the API's
  availability surface. It must be cacheable and must not depend on the
  database, or a database outage becomes an authentication outage for every
  verifier that has not warmed its cache.
- `@oxyhq/core`'s service-token verification stops being a self-contained HMAC
  comparison and gains a network dependency with a cache. Its failure modes
  change: an unreachable JWKS must fail CLOSED (refuse) and must not fall back to
  a locally configured key, or the fallback becomes the attack.
- The SDK's `jwtSecret` option is removed rather than deprecated. Every consumer
  passing it must change, which is exactly the signal wanted — a consumer still
  passing a secret is a consumer still holding one.
- Until the migration lands, **`ACCESS_TOKEN_SECRET` would become a
  service-to-service credential the moment anyone verified locally**. Today no
  service outside `oxy-api` and its one-shot derivatives holds it, and the
  documentation now says why it must stay that way rather than inviting the
  opposite. #987 tracks closing it properly.
- Nothing about the CLAIM set changes with the key model. `appId`,
  `credentialId`, `ownerAccountId`, `environment` and the effective scopes are
  the same claims before and after; only what proves them changes. That
  independence is deliberate, so the attribution work in workstream 2.2 is not
  blocked on the key decision.
