# ADR 0015 — The Oxy → data plane envelope is signed with Ed25519 over the exact body; the data plane holds public keys only

- Status: accepted
- Date: 2026-08-17
- Issue: #972 (workstream 4, workstream 13)
- Extends: ADR 0006 (the Oxy/Relay boundary), ADR 0012 (asymmetric service-token
  signing), ADR 0010 (the public edge and its envelope)

## Context

ADR 0006 gives the data plane one job: execute an already-authorized instruction.
Everything a customer could be told "no" about — the credential, the scopes, the
account, the spend — is decided at the Oxy edge, and the envelope that arrives at
the data plane is the record of those decisions. Concretely,
`inferenceRequestSchema.attribution.principal.billing.accountId` names the
account that will be charged for whatever the request consumes.

So the data plane executes on the strength of what the envelope says, and the
envelope says who pays. **How the data plane knows an envelope came from Oxy was
never decided.** The published contract specifies the SHAPES the two exchange and
is silent on authentication of the sender; ADR 0010 says the edge "forwards a
signed/versioned internal envelope" and does not say signed how.

The gap became live rather than theoretical when the data plane shipped.
`OxyHQ/Relay` implements a scheme in one file, `internal/edgeauth/edgeauth.go`,
and says so in its own header: *"This is Relay's proposal for a decision Oxy has
not made. It is stated here, in one file, so it is cheap to replace if Oxy decides
otherwise."* This ADR is Oxy making it.

### Why the choice is not a matter of taste

ADR 0012 retired the shared HMAC secret for service tokens on one argument: **in
any symmetric scheme, verifying and minting are the same capability.** The key
that lets a verifier READ an attribution is the key that lets it FORGE one, and
after ADR 0007 a forged `ownerAccountId` is indistinguishable from a real one at
every point after the mint — it is a spend-forgery primitive handed to each new
verifier.

Applied to this hop the reasoning is identical and the stakes are higher, because
the data plane is not merely a verifier:

- It **executes** requests, so an envelope it could mint is inference it could
  run against any Oxy account's balance.
- It **reports the usage a customer is charged from**, so it would hold both
  halves of a fabricated charge: the instruction and the meter reading.
- It is a **separately deployed service in a separate repository**, so its
  configuration, its logs, its task definition and its operators are a second
  blast radius. A symmetric secret's exposure surface is every place that
  configuration has ever been.

There is also an operational half. A shared symmetric secret cannot be rotated
incrementally: every holder must change at the same instant, so in practice it is
never rotated, and a suspected compromise has no cheap response. The edge is on
the customer-facing request path; a flag-day key change there is an outage.

## The three options

**Option 1 — a shared secret in a header (bearer or HMAC).** Cheapest to
implement and the default thing to reach for. Rejected on the ADR 0012 argument
above: the data plane could mint an envelope naming any account as the payer, and
nothing downstream re-checks it. A bearer token is strictly worse than an HMAC
(it is replayable indefinitely and covers no bytes), and an HMAC is still a mint
key.

**Option 2 — mutual TLS.** Genuinely strong, and the private key never crosses
the boundary. Rejected as the mechanism here for two reasons rather than one.
Operationally, mTLS terminates where TLS terminates: `oxy-api` and the data plane
both sit behind AWS load balancers that terminate TLS, so the property would have
to be re-established at the mesh or the ALB, in Terraform, and would be invisible
to and untestable from either service's own test suite. Semantically, mTLS
authenticates a CONNECTION, not a MESSAGE — it says "this socket is Oxy's" and
says nothing about which bytes travelled on it, so a proxy, a retry layer or a
mesh sidecar between the two is inside the trust boundary by construction. The
thing that must be authenticated is the envelope.

**Option 3 — an asymmetric signature over the exact request body. RECOMMENDED.**
Oxy holds a private key; the data plane holds public keys and can therefore
verify an envelope and not construct one. The signature covers the body, so it
survives every proxy hop and authenticates the message rather than the channel.
Rotation is additive because a signature names its own key id.

## Decision

**Option 3. The Oxy edge signs each inference envelope with Ed25519 over a
domain-separated hash of the exact serialized body. The data plane is configured
with PUBLIC keys only and holds no key that can mint an envelope.**

### The scheme

Three request headers, namespaced rather than generic so that a proxy which
strips or rewrites `Authorization` cannot affect them:

```text
X-Oxy-Relay-Key-Id       the signing key's id
X-Oxy-Relay-Timestamp    unix milliseconds, when the edge signed
X-Oxy-Relay-Signature    v1=<base64 Ed25519 signature>
```

signed over exactly these four lines, `\n` separated, with **no trailing
newline**:

```text
oxy-relay-envelope:v1
<key id>
<unix milliseconds>
<lowercase hex sha256 of the exact request body>
```

Four properties, each load-bearing:

- **The domain separator** (`oxy-relay-envelope:v1`) means a signature minted for
  any other Oxy purpose cannot be replayed as an inference envelope, and vice
  versa. It carries its own version, so the framing can change without a header
  changing.
- **The body hash** means the signature covers the envelope rather than merely
  accompanying it. The bytes hashed must be the bytes sent and the bytes parsed:
  a verifier that re-encodes between checking and parsing authenticates something
  other than what it executes, which is the classic way a signature check becomes
  decorative.
- **The key id is inside the signed material**, not only in a header, so an
  attacker cannot re-label a valid signature as coming from a different key.
- **The timestamp is inside it too**, which is what makes the replay window a
  property of the signature rather than of a header a proxy could rewrite.

Ed25519 rather than ES256 or RSA: signing and verification are constant-time by
construction, the implementation surface is small, both sides have it in their
standard library (Node's `crypto`, Go's `crypto/ed25519`), and it is the same
algorithm ADR 0012 chose for service tokens — one curve for the platform's
signing rather than two.

### Key management

- **Oxy holds the private key.** It reaches `oxy-api` as
  `RELAY_EDGE_SIGNING_PRIVATE_KEY`, an Ed25519 private key in PEM or
  base64-of-PEM form, alongside `RELAY_EDGE_SIGNING_KEY_ID` and `RELAY_BASE_URL`.
  It is a secret and belongs in SSM at
  `/oxy/oxy-api/RELAY_EDGE_SIGNING_PRIVATE_KEY`, which means adding it to BOTH
  hand-maintained allowlists in `.github/workflows/deploy-aws.yml` — the
  `SYNC_<NAME>` env block and the `API_SECRETS` list — at the moment a data-plane
  deployment first needs it. `scripts/check-deploy-secrets-sync.mjs` guards that
  the two agree. The other two variables name a deployment rather than a
  credential and belong in the task definition's plain environment.
- **The data plane holds public keys**, as `kid:base64,kid:base64`. Public keys
  are not secrets and may appear in a task definition, a workflow file or a log.
  `oxy-api` logs the derived public key once at startup for exactly this reason:
  confirming that both sides hold the same pair is otherwise a guess, and the
  alternative — printing the private key — is the thing being avoided.
- **All three variables or none.** A partial configuration resolves to "this
  deployment has no data plane" and is reported at `error` level, because the
  alternative is a deployment that forwards unsigned envelopes and answers every
  request with a refusal that looks like a data-plane outage.

### Rotation

**A key id is what makes rotation additive.** The order is:

1. generate a new pair and give the data plane the new PUBLIC key **in addition
   to** the current one — its key set is a map from key id to public key, and
   more than one entry is the normal state during a rotation;
2. switch `oxy-api` to the new private key and key id;
3. retire the old public key no sooner than one maximum signature skew after the
   last envelope signed with it.

Nothing is weaker during the window, and this is not dual authority: the verifier
selects deterministically by the key id the signature names and never "tries the
other one". No flag day, no simultaneous restart. Contrast ADR 0012's option 1,
where an HS256 token carries no key id and an overlap means every verifier holds
two live minting keys — the shape this repository refuses.

**A verifier configured with an empty key set must refuse to start**, rather than
starting and rejecting everything: a total outage that presents as a wave of
authentication failures is expensive to place.

### The replay bound

**Five minutes of clock skew, in both directions, and no nonce cache.** A
captured envelope can therefore be replayed inside that window, and that is
accepted for one specific reason: **the edge owns idempotency and reservation.** A
replayed envelope names a `requestId` and, when the customer sent one, an
`Idempotency-Key`; both are already bound to a reservation at the edge, so a
replay spends against a hold that has already been taken and settled rather than
creating a second charge. The data plane would execute it — that is real, and it
is upstream cost Oxy would absorb — but it cannot produce a second customer
charge, and it cannot name an account the original envelope did not.

Both directions of the skew are bounded, not just the past: a FUTURE timestamp is
not harmless, because it would extend a captured envelope's replay window by
however far ahead it was stamped.

**A nonce cache is deliberately not added.** It would need to be shared across
every data-plane instance to mean anything, which makes a per-request write to a
shared store a dependency of the inference hot path — and its failure mode is
refusing legitimate traffic. The property it would buy is one the edge already
provides where it matters (no duplicate charge), so it would be paid for on every
request to strengthen a guarantee that is not the customer's exposure.

## Alternatives rejected

**A shared secret (option 1).** Rejected on ADR 0012's argument: verifying and
minting would be the same capability, and after ADR 0007 that is spend-attribution
forgery by a service that also reports the meter reading.

**Mutual TLS as the mechanism (option 2).** Rejected because it authenticates a
connection rather than a message, and because at Oxy it would live in load-balancer
configuration where neither service's tests can reach it. Not rejected as a
LAYER: mTLS or a private-network path underneath this signature is complementary
and this ADR neither requires nor forbids it.

**Reusing the service-token JWT (ADR 0012's mechanism) for this hop.** The
obvious economy, and wrong in one specific way: a service token authenticates a
CALLER and carries claims, but it does not cover the request body. An attacker
holding a captured token could send any envelope with it, including one naming a
different payer. The thing that must be authenticated here is the bytes.

**Signing a canonicalized JSON form rather than the exact bytes.** Rejected. A
canonicalization is a second serializer that both sides must implement
identically, and any disagreement is a signature that verifies over material
neither side actually processed. Hashing the exact bytes has no such failure mode,
at the cost that the sender must send precisely what it hashed — which is a local
property, checkable in one function.

**Making the signature optional, or allowing an unauthenticated local mode.**
Rejected in both repositories, for the same reason stated in the data plane's own
configuration code: a bypass that exists is a bypass that ships.

## Consequences

- **The edge gains a signing key on its hot path.** An Ed25519 signature over a
  32-byte hash is microseconds and needs no network call, so this is not a latency
  concern; but it IS a new failure mode, and an unusable key must fail closed at
  configuration time rather than per request. `config/relayDataPlane.ts` refuses a
  key of the wrong algorithm at resolution, so an RSA key pasted into the variable
  is caught at startup rather than by the data plane on every request.
- **A `4xx` from the data plane is never the customer's fault.** Everything it
  refuses at this layer — an unsigned or badly signed envelope, an unrecognised
  `schemaVersion`, an over-large body, a missing `requestId` — is something Oxy
  built or failed to sign. The edge therefore maps such a refusal to
  `internal_error` and keeps the upstream status in the log; surfacing the data
  plane's own `authentication_failed` would point a customer at their own API key
  for a fault in Oxy's signing key.
- **The private key must never be logged or serialized.** It is held as a Node
  `KeyObject` rather than a string, so an accidental interpolation yields
  `[object Object]` rather than a PEM, and no log line in the forwarding path
  takes the key, the signature or the envelope.
- **The two implementations must be verified against each other, not against
  themselves.** A test that signs and verifies with the same helper proves only
  that the helper is self-consistent. Oxy's suite therefore stands up a stub data
  plane that verifies the signature with a public key it holds, and asserts that a
  TAMPERED body is REJECTED — without that negative control, a broken signature
  would be indistinguishable from a working one.
- **Ed25519 is now used for two things** (service tokens under ADR 0012, and this
  hop) with different keys and different domain separators. That is deliberate:
  one algorithm, and a domain separator per purpose, so a signature for one can
  never be presented for the other.
- **This does not authenticate the data plane to Oxy.** The edge trusts the TLS
  server certificate of the URL it was configured with, and nothing more. That is
  sufficient for what the response carries — units, events and a route, all of
  which the edge validates against the request it admitted — and a usage report
  that answers a different `requestId` or names a model the edge did not admit is
  already refused. Signing the response as well would be the symmetric decision to
  this one and is left open rather than assumed: it becomes worth taking if the
  data plane's response ever carries something the edge cannot check for itself.
