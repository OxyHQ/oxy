# Runbook — rotating the Oxy→Kaana edge signing key

> **ADR 0015 has landed and the scheme is implemented.** This file was written
> against the scheme the ADR *stated*, before it merged; it has since been
> reconciled against what actually shipped, and the concrete names, paths and
> bounds below are the implementation's own. [ADR
> 0015](../adr/0015-oxy-kaana-envelope-signing.md) remains the authority for
> *why*; this file is the authority for *how*.

## What exists today

**The scheme is implemented; no key is configured in any deployment yet.** Those
are two different facts and the difference decides what you do:

- `packages/api/src/services/httpKaanaClient.ts` signs each inference envelope
  with Ed25519 and forwards it to `POST <KAANA_BASE_URL>/internal/v1/inference`.
  `packages/api/src/config/kaanaDataPlane.ts` resolves the key.
- The data plane exists — [`OxyHQ/Kaana`](https://github.com/OxyHQ/Kaana), a
  public Go repository — and holds only PUBLIC keys, so it cannot construct an
  envelope it would itself accept.
- **A deployment that has not set all three of `KAANA_BASE_URL`,
  `KAANA_EDGE_SIGNING_KEY_ID` and `KAANA_EDGE_SIGNING_PRIVATE_KEY` has no data
  plane**: every invoke resolves to `DataPlaneNotConfiguredError` and the edge
  answers a typed `service_unavailable`. That is every deployment today, so
  **there is currently no key to rotate** — but the procedure below is real, not
  hypothetical, and applies the moment one is set.
- **All three or none.** A partial configuration resolves to the same
  no-data-plane state and is reported once at `error` level as
  `inference.kaana.config_unreadable`, naming the variable and never its value.
  It never forwards unsigned.

If the boundary is the problem and no key is yet configured, the containment
levers are the **rollout flags**, not key material:

| Flag | Default | Effect |
|---|---|---|
| `INFERENCE_EDGE_AUDIENCE` | closed | who may reach the public inference edge at all |
| `INFERENCE_MACHINE_CREDENTIAL_AUTH` | off | whether an `oxy_sk_…` key authenticates the edge |
| `INFERENCE_CHARGING_AUTHORIZED` | unauthorized | whether spend may be charged |
| `INFERENCE_CATALOGUE_AUDIENCE` | internal | who may read the catalogue |

Every default is the state that does nothing, deliberately: a flag you can arm by
forgetting a variable looks like a control while defaulting to the dangerous side.
`GET /inference/admin/rollout` (staff-gated) is the readout of all four **with the
reason for each state**, and it never returns a raw value. The ordering when
stopping the flow — clear `INFERENCE_CHARGING_AUTHORIZED` before
`INFERENCE_EDGE_AUDIENCE` — and the full rollback procedure are in
[docs/inference/rollout.md](../inference/rollout.md).

**If the boundary is the problem, close the audience.** That is available now,
needs no key custody, and is verifiable through the readout.

## Where the key material lives

| | Value | Secret? |
|---|---|---|
| Oxy | `KAANA_EDGE_SIGNING_PRIVATE_KEY` — Ed25519 private key, PEM or base64-of-PEM | **yes**, SSM `/oxy/oxy-api/KAANA_EDGE_SIGNING_PRIVATE_KEY` |
| Oxy | `KAANA_EDGE_SIGNING_KEY_ID` — the `kid` the signature names | no; it is in every request header |
| Oxy | `KAANA_BASE_URL` | no; it names a deployment |
| Kaana | `KAANA_EDGE_PUBLIC_KEYS` — `kid:base64,kid:base64,…` | no; a public key is not a secret |

Generate a pair with `openssl genpkey -algorithm ed25519`. Oxy holds the private
half and never logs or serializes it — it is kept as a Node `KeyObject`, so an
accidental interpolation yields `[object Object]` rather than a PEM.

**The first key pair exists. It is not wired into the deploy, and that is
deliberate — see the ordering hazard below.**

| | Value |
|---|---|
| `kid` | `oxy-edge-2026-08-17` |
| public half, as Kaana's `KAANA_EDGE_PUBLIC_KEYS` entry | `oxy-edge-2026-08-17:jQBxDX3B/Z0ULOHPbQz3gfFinKpl7Qv5MVBTfRYSd34=` |
| private half | GitHub Actions repo secret `KAANA_EDGE_SIGNING_PRIVATE_KEY`, set 2026-08-17. Not in this repository, not in any file. |

Generated with `openssl genpkey -algorithm ed25519`, and verified before storage
by signing Kaana's exact signing input — `oxy-kaana-envelope:v1\n<kid>\n<unix
millis>\n<lowercase hex sha256 of the body>` — and verifying the signature with
the public half **rebuilt from the base64 above**, so the value in this table is
demonstrably the one that matches the stored private key rather than a
transcription of it. Negative control: the same signature over a body with one
byte appended does not verify. The local private half was shredded once the
secret was stored.

**Do not add it to the deploy on its own.** `resolveKaanaDataPlane` treats all
three variables as all-or-nothing: with none set it returns `absent` and is
silent, which is today's behaviour on every deployment. With only the private key
injected it returns `unreadable(KAANA_BASE_URL)` and logs
`inference.kaana.config_unreadable` at **error** level on every boot — a
production error line asserting the configuration is broken when nothing is
broken. That is how a log people should read becomes a log people skip. So the
private key stays available-but-unwired until there is a `KAANA_BASE_URL` to set
beside it, and all three land together.

**When that moment comes**, adding it means editing BOTH hand-maintained
allowlists in `.github/workflows/deploy-aws.yml` — the `SYNC_<NAME>` env block
and the `API_SECRETS` list — in the same change;
`scripts/check-deploy-secrets-sync.mjs` fails the build if the two disagree. A
name in one list and not the other syncs nothing, silently, and surfaces later as
`ResourceInitializationError: unable to pull secrets` at task launch.

**Oxy prints the PUBLIC half at startup**, once, as
`inference.kaana.configured` with `baseUrl`, `keyId` and `publicKey` — the
base64 of the raw 32 bytes, exactly the second half of the `kid:base64` entry
Kaana takes. That log line is how you obtain the value to give Kaana, and it is
the read-back for step 2 below. It is safe by construction: a public key is not a
secret, and Kaana's own `edgeauth` package says so in as many words.

## Trigger

- **A signing key is suspected compromised.** Anything holding Oxy's edge signing
  key can forge a request that Kaana will execute as if Oxy authorised it, and
  after [ADR 0007](../adr/0007-canonical-request-attribution.md) the attribution
  in that request decides who is charged. Treat as the same severity class as the
  [service-token signing key](./service-token-signing-key-rotation.md).
- **Scheduled rotation.** The reason the scheme carries multiple key ids is that a
  scheduled rotation costs nothing: publish, cut over, retire. If rotation is ever
  expensive, something has diverged from ADR 0015 and that is the bug.
- **A Kaana-side operator with the verification material leaves**, or the
  verification set was distributed further than intended. Note this is a
  *hygiene* trigger, not an exposure one: what Kaana holds is a public key, and
  losing control of a public key forges nothing. Rotate anyway if the departure
  suggests the private half may also have been reachable.

## Procedure — the additive shape ADR 0015 decides

The order is the point. Each step is separately verifiable, and no step makes
anything weaker while it is in progress:

0. **Generate the new pair** (`openssl genpkey -algorithm ed25519`) and choose a
   new key id. Give it a dated name — `oxy-edge-2026-09` — so a request header
   says when its key was minted. It must contain **no colon, comma, whitespace or
   line break**: Kaana parses its key set as `kid:base64,kid:base64`, so a key id
   carrying either separator is one Kaana could never be configured with. Oxy
   refuses such a value at resolution rather than emitting a signature nothing can
   verify.
1. **Add the new PUBLIC key to `KAANA_EDGE_PUBLIC_KEYS`, keeping the old entry,
   and do not sign with it.** Kaana's key set is a map from key id to public key
   and more than one entry is the normal state during a rotation. Nothing is
   signed under the new one yet, so nothing has changed behaviourally — which is
   what makes this step safe to do at any time, including before an incident.
2. **Verify that Kaana really has it** before signing anything with it. This is
   where a rotation goes wrong: signing with a `kid` the verifier does not know
   yet refuses every request, and the symptom (a valid signature rejected) reads
   like a signing bug rather than a distribution one. Kaana exposes
   `edgeauth.Verifier.KeyIDs()` precisely so an operator can confirm which keys a
   RUNNING process trusts without being shown key material — read the running
   process, not the change that was supposed to configure it.
3. **Start signing with the new key id**: set `KAANA_EDGE_SIGNING_KEY_ID` and
   `KAANA_EDGE_SIGNING_PRIVATE_KEY` together and restart. They are read ONCE, at
   router construction, not per request — so a key change takes effect on restart
   and only on restart. That is deliberate: Kaana must be told the matching public
   key out of band, so a key picked up without a restart would be a key Kaana has
   never heard of.

   Requests in flight signed under the old `kid` still verify, because the
   verifier selects by the `kid` the request names rather than trying keys in
   turn. There is no dual authority: one authoritative key set that happens to
   contain two keys.
4. **Retire the old key id** — remove its entry from `KAANA_EDGE_PUBLIC_KEYS` —
   no sooner than the maximum lifetime of anything signed under it. **For this
   scheme that is the signature's own skew window: 5 minutes**, both directions,
   which is the only replay bound ADR 0015 defines (Kaana keeps no nonce cache;
   the edge owns idempotency and reservation). It is NOT a token TTL and NOT a
   calendar guess — five minutes after the last request signed with the old key,
   no signature under it can still be inside its window.
5. Retirement is a **separate, verified change**, not a line deleted in the commit
   that added the new key.

**Never remove the last entry.** Kaana refuses to start with an empty key set
rather than starting and rejecting everything, because a total outage that presents
as a wave of authentication failures is expensive to place — but do not rely on
that to catch a mistake you can avoid by ordering the steps as above.

## How to verify it took

- **After step 1:** the verifier's trusted set contains both key ids. Read it back
  from Kaana's own configuration surface — not from the change that was supposed
  to write it. A write to a config store can exit 0 and change nothing.
- **After step 3:** Oxy's restart logs `inference.kaana.configured` with the NEW
  `keyId` and the NEW `publicKey` — compare that `publicKey` against the entry you
  added to `KAANA_EDGE_PUBLIC_KEYS` in step 1, character for character. Both
  halves matter: an accepted request whose header still names the old `kid` means
  the signer did not pick up the new key, and a `configured` line naming the new
  `kid` with an unexpected `publicKey` means the two variables were set from
  different pairs — which verifies nowhere and is the mistake this read-back
  exists to catch.
- **After step 4:** a request signed with the OLD key is now REFUSED. Until you
  have observed that refusal, the old key is still live regardless of what the
  configuration says — this is the negative control, and it is the only evidence
  that retirement took effect.
- **Throughout:** the edge's own refusal rate. A rotation that has broken
  verification presents to the CUSTOMER as `internal_error`, not
  `authentication_failed` — deliberately: a `4xx` from Kaana means Oxy's own
  signature or envelope was refused, and telling a customer `authentication_failed`
  would point them at their own API key for a fault in Oxy's signing key. The real
  upstream status is in the log as `inference.kaana.rejected_envelope`, with
  `status`, the upstream `code`, and Kaana's own request id so the two sides' logs
  join. That event going from zero to every-request IS the signal.

## Rollback

**Steps 1–3 roll back cleanly**: re-sign with the old `kid`, which the verifier
still trusts because you have not retired it yet. That is the entire reason the
retirement is a separate step, and it is why step 4 is the one to be slow about.

**After step 4 there is no rollback** — the verifier no longer trusts the old key,
and anything still signing with it fails. Recovery is re-adding the old key id,
which means treating a retired key as live again; if it was retired because it was
compromised, do not.

## Break-glass

**Close the audience.** `INFERENCE_EDGE_AUDIENCE` gates the edge itself, so
clearing it stops Oxy issuing signed requests at all — without touching key
material, without a Kaana-side change, and verifiable through
`GET /inference/admin/rollout`. Clear `INFERENCE_CHARGING_AUTHORIZED` first so no
spend is authorised during the window (rollout.md § Step 1 owns the ordering, and
the ordering exists because clearing the audience first can leave charging armed
against a surface nobody is watching).

**If Kaana is unreachable and the signing key is compromised**, the edge cannot be
told to stop by Kaana, but Oxy can stop signing: same lever as above. Oxy is the
only party that mints these signatures, so removing Oxy's ability to send is a
complete containment from this side — what it does not do is invalidate a
signature an attacker already holds, which is what makes step 4 (retirement at
Kaana) the actual fix rather than the cleanup.

**Do not introduce a shared symmetric secret as an emergency measure.** In a
symmetric scheme verifying and minting are the same capability, so the key that
lets Kaana READ Oxy's attribution is the key that lets it FORGE attribution — and
a forged `ownerAccountId` is indistinguishable from a real one at every point
after the mint. ADR 0012 argues this at length for service tokens and the argument
is identical here.
