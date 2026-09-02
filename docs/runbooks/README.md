# Runbooks

Rotation and break-glass procedures for the credential classes **Oxy itself
issues**. One file per credential, and each one states the same five things
because the fifth is the one nobody writes down:

1. **The trigger** — what makes you run this, including the difference between a
   scheduled rotation and a suspected compromise, which are not the same
   procedure.
2. **The procedure** — the exact calls, in order.
3. **How to verify it took.** A write can silently no-op: a `PATCH` against the
   wrong id returns 200 with no row changed, and an SSM parameter written to a
   path nothing reads is indistinguishable from one that was never written. Every
   procedure here ends by reading the field back, and says what the read must
   show.
4. **The rollback**, or an explicit statement that there is none — some of these
   are one-way and it is better to know before starting.
5. **The break-glass path** — what to do when the normal path is unavailable,
   which is when a rotation is most likely to be needed.

## What lives here and what does not

| Credential | Owner | Where |
|---|---|---|
| Application credential secret (`oxy_dk_…` + secret) | Oxy | [application-credential-rotation.md](./application-credential-rotation.md) |
| Machine API key (`oxy_sk_…`) | Oxy | [machine-credential-rotation.md](./machine-credential-rotation.md) |
| A customer's BYOK provider credential | the customer, held in managed secret storage | [byok-provider-connection-rotation.md](./byok-provider-connection-rotation.md) |
| Service-token signing key, and `ACCESS_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET` | Oxy | [service-token-signing-key-rotation.md](./service-token-signing-key-rotation.md) |
| The Oxy→Kaana edge signing key | Oxy | [kaana-edge-signing-key-rotation.md](./kaana-edge-signing-key-rotation.md) |
| AWS access keys, RDS credentials, the ECS task role, the ALB certificate, KMS keys | infra | **`~/Oxy/oxy-infra`**, `docs/runbooks/` there |
| `ALIA_API_KEY` — the shared upstream key the Alia proxy forwards on | **Alia**, not Oxy | no runbook here, deliberately — see below |

**`ALIA_API_KEY` gets no rotation procedure in this repository, because Oxy cannot
perform one.** It is issued inside the Alia product; Oxy holds a copy in SSM and
forwards it. There is no grace window and no key id to resolve by, so the
"two sides overlap" property below does not apply and cannot be made to — Alia
issuing a new value and Oxy's SSM parameter changing are two events with no
mechanism tying them together. Writing a procedure that reads as Oxy's would be
inventing an authority Oxy does not have.

What *is* worth writing down, and is the only part this repository can answer, is
**who stops working when that value changes**. Five consumers, all server-side:

- three proxy routes, every one of them behind `requireFirstPartyInferenceCaller`
  since #972 workstream 2.3 — `POST /alia/chat/completions`, `POST /v1/voice/token`,
  `POST /v1/voice/transcribe` (`packages/api/src/routes/alia.ts`);
- two internal services that call Alia directly and are not customer-reachable —
  `packages/api/src/services/aiLabeling.service.ts` and
  `packages/api/src/services/cardExtraction.service.ts`.

All five read `process.env.ALIA_API_KEY` at module load, so a changed value takes
effect on the next task launch and not before. The routes fail loudly (`500`,
`ALIA_API_KEY not configured on server`) when it is absent; **the two services fail
SILENTLY** — each returns early when the key is unset, so a bad rotation degrades
AI labelling and card extraction with no error surfaced anywhere. That asymmetry is
the thing to check after any change to the parameter, and it is why this row exists
even though the procedure does not belong here.

**The infra half is deliberately not duplicated here.** `oxy-infra` owns the
terraform, the task definitions, the IAM policies and the AWS procedures, and a
second copy of an AWS runbook in this repository would be the one that goes stale
without anybody noticing. Where a procedure below crosses into AWS it says so and
stops at the boundary, naming what has to happen on the other side rather than
guessing at commands nobody here has run.

## Two things that are true of every rotation

**A secret that reached a remote is compromised, and rewriting history does not
change that.** If a credential was committed and pushed, the object survives in
forks, in CI caches, in clones and in GitHub's own reflog long after a
force-push. Rotate first; clean history afterwards if at all. The secret scanner
(`scripts/check-secret-scan.mjs`) refuses the commit that would start this, which
is cheaper than every procedure here.

**Rotation is only safe if the two sides overlap.** Every credential class Oxy
issues either has a grace window (application credentials, machine keys) or
resolves by key id (the signing keys), and both exist so that the old and new
material are valid at the same time for a bounded period. A rotation performed as
a flag day — old invalidated at the instant the new one is minted — is an
outage, and for the signing keys it is an outage you cannot roll back, because
the tokens signed under the retired key cannot be re-signed.

## Where the authority for each mechanism is

- Application and machine credentials: `packages/api/src/db/schema/applicationCredentials.ts`
  (the lifecycle and both CHECK biconditionals), `packages/api/src/utils/credentialUsability.ts`
  (the single usability predicate), `packages/api/src/routes/applications.ts`.
- BYOK: [ADR 0013](../adr/0013-byok-secret-custody.md),
  `packages/api/src/services/inferenceProviderConnection.service.ts`,
  `packages/api/src/services/providerSecretStore.ts`.
- Service tokens: [ADR 0012](../adr/0012-service-token-signing-key-model.md).
- The Oxy→Kaana boundary: [ADR 0006](../adr/0006-oxy-kaana-boundary.md) and
  ADR 0015.
- Platform secret delivery: `.github/workflows/deploy-aws.yml` and
  `scripts/check-deploy-secrets-sync.mjs`.
