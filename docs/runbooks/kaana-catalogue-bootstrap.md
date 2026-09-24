# Bootstrap the reviewed Kaana catalogue

This is the production-safe path for creating the exact Oxy catalogue facts
already reviewed in `kaanaInitialCatalogue.ts`: the gpt-oss text routes and
their eight profiles, and Alia's text-to-speech route (`x-ai/text-to-speech`
on `dep_xai_tts_observed_2026_09_24`) with its speech-only profile
`cc2471c8-807e-46ec-b5da-b6f3b39d2db5` (`kaana-v1-speech`, ranked on price). It does not enable an inference
audience, change an application's classification, create a reviewer or move a
provider key.

Run only [Bootstrap reviewed Kaana catalogue](../../.github/workflows/bootstrap-kaana-catalogue.yml)
from `main`. The workflow uses GitHub OIDC through the dedicated
`oxy-github-kaana-catalogue-bootstrap` role and the persistent
`oxy-kaana-catalogue-bootstrap` task definition; it never derives a writer from
the live `oxy-api` task.

## Prerequisites

1. Apply and read back the exact reviewer authorization described in
   [Bootstrap the Kaana catalogue reviewer](./bootstrap-catalogue-reviewer.md).
   This workflow accepts only the source-reviewed PostgreSQL `users.id`
   `6981c9178fcdefaf81988ffb`; it never grants staff status or discovers a
   reviewer by username, display name or order.
2. Deploy the matching Oxy `main` image, then renew the dedicated bootstrap task
   definition through reviewed infrastructure so it pins the same immutable
   image digest. An older revision is not usable merely because its family name
   matches.
3. The GitHub OIDC role must have `ecs:RunTask` and exact `iam:PassRole` for both
   `oxy-ecs-execution` and `oxy-kaana-catalogue-bootstrap`. Keep the latter exact;
   do not widen it to a path or wildcard.
4. Keep `kaana-publisher` healthy. Copy its complete live network configuration
   to the one-shot, including `assignPublicIp`. Both public-subnet `ENABLED`
   and private-subnet `DISABLED` are valid; never force a public IP after the
   publisher moves behind NAT.
5. Verify the current Kaana inventory content snapshot remains
   `snap_37548e4f1f8ec610`. The task role can read only the versioned
   `inventory/current.json` object and the writer refuses stale or mismatched
   content.

The task definition is also checked before every run: one ARM64 Fargate
container, exact command and image, exact inventory object and task role, and
one secret binding — PostgreSQL `DATABASE_URL`. Provider keys, signing keys,
application credentials, static AWS credentials and MongoDB are outside this
lane.

6. Apply any pending same-value scorecard renewal first
   ([routing score renewal](./kaana-routing-score-renewal.md)). The bootstrap
   refuses an existing scorecard that is not at its current reviewed state.

The job binds no GitHub `environment:`. The OIDC role trusts only the
`ref:refs/heads/main` subject, and an environment-bound job presents
`environment:<name>` instead and cannot assume it.

## Dry run, then apply

Choose `dry-run` and supply:

- the exact live `oxy-api` task-definition ARN;
- the exact dedicated bootstrap task-definition ARN;
- their shared immutable `sha256:` image digest;
- the exact authorized reviewer `users.id`.

The task takes a PostgreSQL transaction advisory lock, locks the reviewer row,
validates every exact model, revision, deployment, routing-profile PK and
candidate, hashes all source-reviewed pricing, score, policy and profile facts,
computes `planSha256`, and rolls the transaction back. Review the allow-listed
operation list, source-facts SHA and retain the plan SHA.

Choose `apply` with the same identities, the retained SHA and a single-line
change reason. The workflow always performs a fresh dry run first, then
re-attests the live rollout and passes that attestation (timestamp, both task
definitions, image, cluster, service) to the one-shot, which refuses APPLY
unless it is under ten minutes old and repeats the ECS proof itself. Both the
workflow and the writer inside the still-rollbackable transaction require the
fresh SHA to equal the reviewed SHA. After commit, the workflow runs the exact
Inbox profile query inside a PostgreSQL `READ ONLY` transaction, then performs
another rollback-only bootstrap and requires `inserted: []`.

An apply with a non-zero exit, absent result or malformed result is ambiguous:
the workflow runs the SELECT-only readback, reports whether the exact row is
present, exits failed and does not retry or declare success. Review the database
state and obtain a new dry-run plan before any later apply.

## Identity is not audience eligibility

Every reviewed deployment is `availability_scope = platform_internal`: reviewed
for official Oxy products under `standard_application_use`, never for public
resale. Staff-classified `first_party`, `internal` and `system` applications see
that scope ([catalogue.md](../inference/catalogue.md#reads-are-audience-scoped));
third-party applications and plain user bearers do not. A successful bootstrap
and exact-PK readback prove the profile identity and candidate, not that a
given product may route through it. Before setting
`INBOX_INFERENCE_ROUTING_PROFILE_ID` or enabling execution, prove the exact
profile resolves to at least one route for the real Inbox principal.

Do not relabel an application's tier and do not rewrite an approved
deployment's scope as a shortcut.

### Text routes still stored as `internal_alia`

The three gpt-oss deployments, written before the rename, still store the
legacy `internal_alia` bytes: the storage rename's backfill is a
separate migration
([rolling storage rename](../inference/catalogue.md#rolling-storage-rename-three-releases-in-order)).
The bootstrap compares an existing row's legacy `internal_alia` as the
`platform_internal` it means and never rewrites it; any other stored scope is
still drift. Rows it inserts, such as the speech route, are written as
`platform_internal`. The Cerebras and Groq routes also keep the approval note
written on 2026-09-02 (`Owner-approved initial internal Alia route; …`): it is
the record of that decision and the reviewed facts pin its exact bytes.

### Existing scorecards after migration 0082

The two original Cerebras/Groq scorecards may carry
`funding_evidence_ref = migration/standard-payg`: migration 0082 backfilled that
exact value into both current rows and immutable events, then removed the SQL
default. Bootstrap preserves that historical marker for those exact deployment
IDs only. It still checks every other reviewed field and requires the matching
immutable event to carry the same marker; it never rewrites either row. Newly
created scorecards, including OpenRouter, require the reviewed price URL.
