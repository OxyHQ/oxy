# Cut over the exact-ID Kaana request v2

`@oxyhq/contracts` 0.40.0 changes two canonical wire shapes:

- `inferenceRequestSchema`: `schemaVersion` 1 → 2;
- `routingPolicySchema`: `schemaVersion` 1 → 2.

Their routing target no longer has a slug arm. A profile is always
`{ "kind": "routing_profile_id", "routingProfileId": "<exact-pk>" }`.
Oxy may accept the deprecated public `routingProfile` field at its HTTP edge,
but resolves it by the unique slug constraint to one exact PK immediately. The
slug cannot enter a policy snapshot, cache, signed envelope or Kaana.

This is a two-producer rolling cutover, not one deploy. Follow this order:

1. Merge and publish `@oxyhq/contracts` 0.40.0. The Oxy auto-deploy is safe only
   while `.github/workflows/deploy-aws.yml` explicitly writes
   `INFERENCE_KAANA_EXECUTION=disabled`. Confirm the new Oxy task definition has
   that exact value and `GET /inference/admin/rollout` reports Kaana execution
   disabled. With no Kaana client, admission refuses before reservation and
   before `buildEnvelope`; this image cannot emit request v2 in production.
2. In a separate Kaana PR, consume the published 0.40.0 package, regenerate the
   descriptor and implement a rolling decoder that accepts old
   `schemaVersion: 1` **only for the concrete model arm** and new
   `schemaVersion: 2` for model or exact `routing_profile_id`. Both versions must
   reject `routing_profile`/`routingProfile`; Kaana must never translate a slug.
3. Deploy Kaana first. Verify the deployed image digest and `/health`
   `contractVersion=2.0.0`, then run signed canaries proving v1 model requests
   still work during the rolling window, v2 exact-PK profile requests work, an
   unknown/whitespace-modified ID fails closed, and either-version slug targets
   are rejected. Do not infer readiness from the health string alone.
4. Only after step 3, open a second Oxy PR that deliberately changes the deploy
   binding to `INFERENCE_KAANA_EXECUTION=enabled` and updates the temporary
   phase gate `scripts/check-kaana-request-v2-rollout.mjs` with the reviewed
   Kaana image/canary evidence. That change must not alter the contract or
   routing target again.
5. Deploy Oxy, watch the rolling task set until every task is healthy, then
   smoke one direct-model request, one exact profile-ID request, one deprecated
   public slug request (the captured Kaana envelope must contain only the PK),
   one cancelled stream and one unknown ID. Verify reservations, settlement,
   usage and application/account attribution.
6. After the Oxy rollout is complete, Kaana may remove v1 only in a later
   independently reviewed release after logs prove no v1 producer remains.

The CI gate intentionally fails if this first-phase branch enables Kaana
execution, regresses the request version or restores a slug arm. It is a phase
barrier, not proof of the later live canaries.

Rollback order is Oxy first: restore
`INFERENCE_KAANA_EXECUTION=disabled`, deploy and confirm admission is closed.
Keep Kaana dual-version and keep 0.40.0 published. Do not roll Kaana back to a
v1-only image while any Oxy v2 task may still be running.
