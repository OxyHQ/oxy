# Runbooks

- [Bootstrap the Kaana catalogue reviewer](./bootstrap-catalogue-reviewer.md)
- [Bootstrap or retire the native product agents](./native-product-agent-bootstrap.md)
- [Cut over the exact-ID Kaana request v2](./kaana-request-v2-cutover.md)

Rotation and break-glass procedures for credentials Oxy issues or operates
through its control surfaces, including customer BYOK keys held only by Kaana.
One file per credential, and each one states the same five things
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
| A customer's BYOK provider credential | the customer; encrypted custody in Kaana PostgreSQL/KMS | [byok-provider-connection-rotation.md](./byok-provider-connection-rotation.md) |
| Oxy → Kaana edge-signing key | Oxy private key; Kaana public verification set | [kaana-edge-signing-key-rotation.md](./kaana-edge-signing-key-rotation.md) |
| Service-token signing key, and `ACCESS_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET` | Oxy | [service-token-signing-key-rotation.md](./service-token-signing-key-rotation.md) |
| AWS access keys, RDS credentials, the ECS task role, the ALB certificate, KMS keys | infra | **`~/Oxy/oxy-infra`**, `docs/runbooks/` there |
The retired Oxy-to-Alia proxy credential has no live consumer and therefore no
rotation runbook. Deployment explicitly removes its historical task binding.
Inbox point inference, automatic labelling and card extraction use the metered
Oxy-to-Kaana path; Alia agent/chat/voice clients address Alia directly. Keep the
old name only in removal/audit records so a stale task definition cannot retain
it accidentally.

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
- BYOK: [ADR 0019](../adr/0019-kaana-byok-custody.md),
  `packages/api/src/services/inferenceProviderConnection.service.ts`,
  `packages/api/src/services/kaanaCredentialControl.ts`.
- Oxy → Kaana edge signing: [ADR 0015](../adr/0015-oxy-kaana-envelope-signing.md),
  `packages/api/src/config/kaanaDataPlane.ts`,
  `packages/api/src/services/httpKaanaClient.ts`.
- Service tokens: [ADR 0012](../adr/0012-service-token-signing-key-model.md).
- Platform secret delivery: `.github/workflows/deploy-aws.yml` and
  `scripts/check-deploy-secrets-sync.mjs`.
