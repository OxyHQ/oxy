# Cut over the exact-ID Kaana request v2

`@oxy.so/contracts` 0.40.0 changes two canonical wire shapes:

- `inferenceRequestSchema`: `schemaVersion` 1 → 2;
- `routingPolicySchema`: `schemaVersion` 1 → 2.

Their routing target no longer has a slug arm. A profile is always
`{ "kind": "routing_profile_id", "routingProfileId": "<exact-pk>" }`.
Oxy may accept the deprecated public `routingProfile` field at its HTTP edge,
but resolves it by the unique slug constraint to one exact PK immediately. The
slug cannot enter a policy snapshot, cache, signed envelope or Kaana.

This is a two-producer rolling cutover, not one deploy. Follow this order:

1. Merge and publish `@oxy.so/contracts` 0.40.0. Keep the public audience closed
   while the two producers roll. With incomplete canonical Kaana configuration,
   admission refuses before reservation and before `buildEnvelope`.
2. In a separate Kaana PR, consume the published 0.40.0 package, regenerate the
   descriptor and implement a rolling decoder that accepts old
   `schemaVersion: 1` **only for the concrete model arm** and new
   `schemaVersion: 2` for model or exact `routing_profile_id`. Both versions must
   reject `routing_profile`/`routingProfile`; Kaana must never translate a slug.
3. Deploy Kaana first. Verify the deployed image digest and `/health`
   `contractVersion=2.0.0`, then run signed canaries proving v1 model requests
   still work during the rolling window, v2 envelopes propagate the exact opaque
   profile id while executing only a signed exact deployment, an unknown or
   whitespace-modified deployment id fails closed, and either-version slug
   targets are rejected. Do not infer readiness from the health string alone or
   treat this direct probe as evidence that the Oxy-owned profile row exists.
4. Only after step 3, open a second Oxy PR that updates the temporary phase gate
   `scripts/check-kaana-request-v2-rollout.mjs` with the reviewed Kaana
   image/canary evidence. That change must not alter the contract or routing
   target again.
5. Deploy Oxy, watch the rolling task set until every task is healthy, then
   smoke one direct-model request, one exact profile-ID request, one deprecated
   public slug request (the captured Kaana envelope must contain only the PK),
   one cancelled stream and one unknown ID. Verify reservations, settlement,
   usage and application/account attribution.
6. After the Oxy rollout is complete, Kaana may remove v1 only in a later
   independently reviewed release after logs prove no v1 producer remains.

The CI gate requires the exact reviewed evidence in
`docs/release-evidence/kaana-request-v2-cutover-2026-09-09.md`; it
also fails if the request version regresses or a slug arm returns. Later Kaana
candidates are validated in isolated, time-bounded tasks before promotion, so
their lifecycle does not disable the already-reviewed production lane. The
production service configuration remains independent of those tasks.

Rollback order is Oxy first: close `INFERENCE_EDGE_AUDIENCE`, deploy and confirm
admission is closed. Keep Kaana dual-version and keep 0.40.0 published. Do not
roll Kaana back to a v1-only image while any Oxy v2 task may still be running.

## Signed data-plane canary

First run `.github/workflows/kaana-signed-deployment-readback.yml` with the
exact reviewed live Oxy task-definition ARN and immutable image digest. Its
secret-minimized ECS one-shot signs the literal `{}` body and prints only the
serving `snapshotId` plus Kaana's operator-safe descriptors:
`deploymentId`, pinned `modelReference`, `provider` and `regions`. It makes no
inference request, holds no database binding and writes neither provider usage
nor the Oxy ledger. The returned array is a projection, not a priority list;
never select by its position, model name or provider.

Choose one exact `deploymentId` from that signed projection. Then use
`.github/workflows/kaana-signed-canary.yml` with that id and the exact
`expected_snapshot_id` from the same readback. Every input is required and has
no operational default. The canary sends only the exact deployment id in its
signed lookup and derives `modelReference` from the returned descriptor; there
is no operator-supplied or checked-in model authority. If the serving snapshot
changed after readback, the canary fails before every inference probe and the
operator must run readback again. The routing-profile/policy and attribution
identities come from the exact Oxy PostgreSQL rows used for the reviewed
inference credential. Never copy a provider-credential UUID into
`deployment_id`: Kaana deployment identities are opaque strings, and only the
live signed lookup establishes what one means.

Before dispatching the Oxy canary, run Kaana's isolated candidate workflow from
the reviewed Kaana commit. Its successful handoff supplies four values that
must be copied exactly into the Oxy workflow invocation:
`candidate_task_arn`, `candidate_task_definition_arn`,
`candidate_image_digest` and `candidate_private_ip`. Dispatch the Oxy canary
while that candidate is still running and before the bounded Kaana workflow
cleanup window expires. Do not reconstruct any value from a tag, service name,
provider name or current task list. If the candidate stops, its ENI changes or
the window expires, start a new candidate and use only its new complete receipt.
The Kaana workflow owns stopping the isolated task and deregistering its
temporary task definition; the Oxy workflow only attests and calls that task
and must not take over cleanup ownership.

The workflow refuses unless the Oxy service is at one steady deployment with
`KAANA_BASE_URL=https://kaana.ai`, the
reviewed task definition and the reviewed image digest. It derives a throwaway
one-shot task from that live image, retains only the single `oxy-api` container
(live observability sidecars are deliberately excluded), removes any container
dependency inherited from the service task, and removes every environment binding and
secret except the two non-secret Kaana settings plus the ECS-injected Ed25519
private key, and never exposes or decrypts that key on the GitHub runner. In
particular, the task has no `DATABASE_URL`, Redis credential, Oxy signing key or
credential-control authority. Its network configuration retains the live
subnets and public-IP setting needed to launch in the same VPC, but replaces the
live API security-group list with exactly the audited Kaana candidate source
security group. It therefore has no network reachability merely inherited from
the production API task.

All four negative probes run before either provider call: v1 and v2 slug arms
must return `invalid_request`; an unknown exact deployment id and a
whitespace-modified deployment id must terminate with `invalid_request` at
`authorizedRoutes[0]`, with no usage report. Only then does the canary make one
v1 direct-model request and one v2 `routing_profile_id` request, each with a
fixed nonsensitive prompt and `maxOutputTokens: 1`. Both must complete on the
exact signed deployment and return a schema-v2 usage report; neither may carry
an Oxy receipt.

This boundary is deliberate: Kaana treats `routingProfileId` as opaque
provenance and executes only the exact `authorizedRoutes` Oxy signed. It does
not look up an Oxy routing-profile row. Unknown or whitespace-modified
**routing-profile** IDs are therefore tested later at the Oxy edge, before an
envelope can reach Kaana; this direct canary proves the corresponding
**deployment** identity is closed at Kaana. The two successful probes may leave
Kaana's normal technical usage records, but the direct one-shot has no Oxy
admission, reservation or settlement path and performs zero Oxy ledger writes.

Merging either workflow never dispatches it and never enables ambient Kaana
execution. Record the readback run, canary run, matching Kaana snapshot id,
exact task/image, deployment id, descriptor-derived model reference, six case
results and the zero-ledger-write assertion in the release evidence before
opening the separate execution-enable change.
