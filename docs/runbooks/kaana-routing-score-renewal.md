# Renew the reviewed Kaana routing scores

## Trigger

Every reviewed scorecard has a `validUntil`. Runtime refuses the **complete**
route set once any selectable route's score for the requested optimisation is
stale ([routing](../inference/routing.md)), so every Kaana-backed product surface
fails at that instant. The daily
[`kaana-routing-score-expiry-monitor.yml`](../../.github/workflows/kaana-routing-score-expiry-monitor.yml)
goes red and opens the issue "Kaana routing scores expire within 7 days" a week
before the cliff. Renew then, not on the day.

This path renews validity only, with the **same** scores, sources, evidence and
measurement windows, after an owner approval. Changing a score is a new review,
not a renewal.

## Procedure

1. In `packages/api/src/config/kaanaInitialCatalogue.ts`, set the new
   `validUntil` and `reviewedAt` (a past instant, the approval date) and set each
   provider's `scoreRenewal.supersedes` to the exact state now in production
   (`changedAt`, `validUntil`, `reason`). Update the pinned target values in
   `renew-kaana-routing-scores.yml` (`RENEWED_VALID_UNTIL`,
   `RENEWED_CHANGED_AT`). Merge to `main` and deploy `oxy-api`.
2. Re-register the dedicated task on that image: in `oxy-infra`, dispatch
   `terraform-uswest2.yml` with `action=plan`, then `action=apply`, targeting
   only `aws_ecs_task_definition.kaana_catalogue_bootstrap`. The plan must show
   the deployed `oxy/oxy-api@sha256:` digest and nothing else.
3. Read back the three exact inputs:
   `aws ecs describe-services --cluster oxy-cluster --services oxy-api` (the
   task-definition ARN and its image digest) and
   `aws ecs describe-task-definition --task-definition oxy-kaana-catalogue-bootstrap`
   (the new revision ARN; its image must equal the live digest).
4. Dispatch `renew-kaana-routing-scores.yml` from `main` with `mode=dry-run`,
   the three inputs and `reviewer_user_id=6981c9178fcdefaf81988ffb`. Read the
   planned renewals and the plan SHA-256 from the job summary. Drift (any row
   that is neither the superseded nor the renewed state) fails here and writes
   nothing.
5. Dispatch it again with `mode=apply`, the same inputs,
   `expected_plan_sha256` from step 4 and a single-line `reason` naming the
   owner approval.

## Verify

The apply run itself proves the result: the apply result must carry the
reviewed plan, a fresh dry run must plan zero operations, and the read-only
readiness command must pass at the monitor's seven-day horizon. Then dispatch
`kaana-routing-score-expiry-monitor.yml` once and require it green.

## Rollback

None needed and none offered: validity only moves forward, the previous state
stays in the append-only `inference_deployment_routing_score_events`, and the
scores themselves never change. To shorten validity, author a reviewed
scorecard through the staff API.

## Break-glass

If the workflow path is unavailable before the cliff, a staff user holding
`inference:catalogue:publish` can `PUT
/inference/admin/kaana-deployments/:kaanaDeploymentId/routing-scorecard` with
the complete scorecard and the new `validUntil`. That write is audited (one
event per call) but stamps `changedAt` with the wall clock, so the reviewed
config must then be updated to that exact instant before the next catalogue
bootstrap, or the bootstrap will refuse the row as drift.
