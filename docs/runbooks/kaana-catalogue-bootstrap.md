# Bootstrap the reviewed Kaana catalogue

This is the production-safe path for creating the exact Oxy catalogue facts
already reviewed in `kaanaInitialCatalogue.ts`. It does not enable an inference
audience, change an application's classification, create a reviewer or move a
provider key.

Run only [Bootstrap reviewed Kaana catalogue](../../.github/workflows/bootstrap-kaana-catalogue.yml)
from `main`. The workflow uses GitHub OIDC and the persistent
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
4. Keep `kaana-publisher` healthy. Its live network configuration is the source
   for the one-shot task because the cluster needs its public-egress setting.
5. Verify the current Kaana inventory content snapshot remains
   `snap_7c760c006f5ac633`. The task role can read only the versioned
   `inventory/current.json` object and the writer refuses stale or mismatched
   content.

The task definition is also checked before every run: one ARM64 Fargate
container, exact command and image, exact inventory object and task role, and
one secret binding — PostgreSQL `DATABASE_URL`. Provider keys, signing keys,
application credentials, static AWS credentials and MongoDB are outside this
lane.

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
change reason. The workflow always performs a fresh dry run first. Both the
workflow and the writer inside the still-rollbackable transaction require the
fresh SHA to equal the reviewed SHA. After commit, the workflow runs the exact
Inbox profile query inside a PostgreSQL `READ ONLY` transaction, then performs
another rollback-only bootstrap and requires `inserted: []`.

An apply with a non-zero exit, absent result or malformed result is ambiguous:
the workflow runs the SELECT-only readback, reports whether the exact row is
present, exits failed and does not retry or declare success. Review the database
state and obtain a new dry-run plan before any later apply.

## Identity is not audience eligibility

This bootstrap's two exact deployments are intentionally
`availability_scope = internal_alia`. The Inbox application is `first_party`
with `is_internal = false`; that audience sees only `public_payg` and
`oxy_hosted`. Therefore a successful bootstrap and exact-PK readback prove the
profile identity and candidate, but do **not** make the profile routable for
Inbox.

Do not relabel Inbox as internal and do not rewrite an approved deployment's
scope as a shortcut. Before setting `INBOX_INFERENCE_ROUTING_PROFILE_ID` or
enabling execution, publish a separately reviewed deployment whose commercial
permission and availability scope legitimately include the Inbox audience, then
prove the exact profile resolves to at least one route for the real Inbox
principal.
