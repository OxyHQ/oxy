# Runbook — rotating the Oxy→Relay edge signing key

> **PENDING ADR 0015.** The edge signing key is a decision being recorded in
> ADR 0015 (issue #972, the Oxy→Relay boundary), which had not landed on `main`
> when this file was written. **Nothing described here is implemented**, and this
> runbook is written against the scheme ADR 0015 states — signed edge requests
> with **multiple key ids so that rotation is additive** — so that the day a key
> exists is not the day the procedure is invented. **Reconcile this file against
> ADR 0015 when it merges**, and correct any name, path or step it contradicts:
> the ADR is the authority, this is not.

## What exists today, and what to do instead

**There is no data plane and no edge signing key.** `packages/api/src/services/relayClient.ts`
declares the SHAPE of the call the edge makes and nothing else: the router is
constructed with no client, every invoke resolves to
`DataPlaneNotConfiguredError`, and the edge answers a typed `service_unavailable`.
There is no repository, no deployment and no endpoint on the other side.

So today there is no key to rotate, and the containment levers for anything going
wrong at this boundary are the **rollout flags**, not key material:

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

**If the boundary is the problem and no key is involved, close the audience.** That
is available now, needs no key custody, and is verifiable through the readout.

## Trigger (once ADR 0015 is implemented)

- **A signing key is suspected compromised.** Anything holding Oxy's edge signing
  key can forge a request that Relay will execute as if Oxy authorised it, and
  after [ADR 0007](../adr/0007-canonical-request-attribution.md) the attribution
  in that request decides who is charged. Treat as the same severity class as the
  [service-token signing key](./service-token-signing-key-rotation.md).
- **Scheduled rotation.** The reason the scheme carries multiple key ids is that a
  scheduled rotation costs nothing: publish, cut over, retire. If rotation is ever
  expensive, something has diverged from ADR 0015 and that is the bug.
- **A Relay-side operator with the verification material leaves**, or the
  verification set was distributed further than intended.

## Procedure (the additive shape ADR 0015 states)

The order is the point. Each step is separately verifiable, and no step makes
anything weaker while it is in progress:

1. **Add the new key id to the set the verifier trusts, and do not sign with it.**
   Relay now accepts both `kid`s. Nothing is signed under the new one yet, so
   nothing has changed behaviourally — which is what makes this step safe to do at
   any time, including before an incident.
2. **Verify that Relay really has it** before signing anything with it. This is
   where a rotation goes wrong: signing with a `kid` the verifier does not know
   yet refuses every request, and the symptom (a valid signature rejected) reads
   like a signing bug rather than a distribution one.
3. **Start signing with the new key id.** Requests in flight signed under the old
   `kid` still verify, because the verifier selects by the `kid` the request names
   rather than trying keys in turn. There is no dual authority: one authoritative
   key set that happens to contain two keys.
4. **Retire the old key id** — remove it from the verifier's set — no sooner than
   the maximum lifetime of anything signed under it. For a request signature that
   is the signature's own validity window, not a token TTL, so bound it by the
   window ADR 0015 defines and never by a calendar guess.
5. Retirement is a **separate, verified change**, not a line deleted in the commit
   that added the new key.

## How to verify it took

- **After step 1:** the verifier's trusted set contains both key ids. Read it back
  from Relay's own configuration surface — not from the change that was supposed
  to write it. A write to a config store can exit 0 and change nothing.
- **After step 3:** a request Oxy signs now carries the NEW `kid` in its header,
  and Relay accepts it. Both halves: an accepted request whose header still names
  the old `kid` means the signer did not pick up the new key.
- **After step 4:** a request signed with the OLD key is now REFUSED. Until you
  have observed that refusal, the old key is still live regardless of what the
  configuration says — this is the negative control, and it is the only evidence
  that retirement took effect.
- **Throughout:** the edge's own refusal rate. A rotation that has broken
  verification presents as `service_unavailable` or an upstream auth failure on
  every request, which the edge reports with a `requestId` and no payload.

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
material, without a Relay-side change, and verifiable through
`GET /inference/admin/rollout`. Clear `INFERENCE_CHARGING_AUTHORIZED` first so no
spend is authorised during the window (rollout.md § Step 1 owns the ordering, and
the ordering exists because clearing the audience first can leave charging armed
against a surface nobody is watching).

**If Relay is unreachable and the signing key is compromised**, the edge cannot be
told to stop by Relay, but Oxy can stop signing: same lever as above. Oxy is the
only party that mints these signatures, so removing Oxy's ability to send is a
complete containment from this side — what it does not do is invalidate a
signature an attacker already holds, which is what makes step 4 (retirement at
Relay) the actual fix rather than the cleanup.

**Do not introduce a shared symmetric secret as an emergency measure.** In a
symmetric scheme verifying and minting are the same capability, so the key that
lets Relay READ Oxy's attribution is the key that lets it FORGE attribution — and
a forged `ownerAccountId` is indistinguishable from a real one at every point
after the mint. ADR 0012 argues this at length for service tokens and the argument
is identical here.
